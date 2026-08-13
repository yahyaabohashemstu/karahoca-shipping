import Foundation
import SQLite3
import os

/// ============================================================================
///  THE DATABASE
/// ============================================================================
///
/// SQLite through the system library, hand-bound, on purpose.
///
///  - **Not Core Data.** This is a write-heavy append log driven from a
///    CoreLocation callback. Core Data wants a managed object context per
///    thread, does its own coalescing, and reaches for the main queue in ways
///    that are hard to see; the one thing this component must guarantee is that
///    a fix is durable before the delegate method returns, and Core Data makes
///    that guarantee awkward to state and impossible to verify.
///  - **Not GRDB or any other package.** No SPM dependencies at all. A
///    dependency is a supply chain running on a third-party driver's phone, and
///    a signing problem the first time this ships outside TestFlight.
///
/// ## Concurrency model — one serial queue, synchronous calls
///
/// Every statement in the app runs inside `queue`, a serial `DispatchQueue`,
/// and every public entry point *blocks* until it is done. There is no `async`
/// anywhere in the storage layer, and that is the whole design:
///
///  1. **A fix must be durable before the location callback returns.** iOS
///     hands the app a few hundred milliseconds of runtime when it wakes it for
///     a background location update and can suspend it immediately after. An
///     `await` yields, and a suspended task is not a scheduled task — the
///     continuation may simply never run, and the fix is gone. A `queue.sync`
///     that has already begun cannot be un-scheduled.
///  2. **Actors are re-entrant and this log is ordered.** An `actor` guarantees
///     mutual exclusion between statements but not between `await`s, so two
///     interleaved appends could allocate device sequence numbers in one order
///     and commit rows in another. A serial queue with synchronous bodies gives
///     total order for free.
///  3. **The UI reads on the main actor.** Counts and the session snapshot are
///     read from SwiftUI. Those reads are microseconds — an indexed lookup or a
///     cached integer — so blocking the main thread on them is cheaper than the
///     hop, and vastly simpler than keeping a published mirror in sync.
///
/// The cost is honest: a slow write blocks a UI read. The mitigations are that
/// every statement here is indexed, the largest transaction claims 500 rows by
/// primary key, and the row counts the UI actually asks for are cached in
/// memory rather than counted on disk.
final class SQLiteDatabase: @unchecked Sendable {

    /// One schema step. Applied in order, once, and never rolled back.
    struct Migration {
        let version: Int32
        let statements: [String]
    }

    enum Failure: Error, CustomStringConvertible {
        case open(code: Int32, message: String)
        case statement(sql: String, code: Int32, message: String)

        var description: String {
            switch self {
            case let .open(code, message):
                return "sqlite open failed (\(code)): \(message)"
            case let .statement(sql, code, message):
                let head = sql.prefix(120).replacingOccurrences(of: "\n", with: " ")
                return "sqlite error \(code): \(message) — while running: \(head)"
            }
        }
    }

    static let log = Logger(subsystem: "com.karahoca.tracker", category: "storage")

    private var handle: OpaquePointer!
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UInt8>()

    /// Prepared statements, keyed by their SQL text.
    ///
    /// The insert on the hot path is re-run every ten seconds for fourteen
    /// hours. Re-parsing and re-planning it each time is pure waste; SQLite's
    /// own advice is to prepare once and reset. Finalised in `close()`.
    private var statementCache: [String: OpaquePointer] = [:]

    /// Handles currently mid-`step`. See `withStatement` — a cached statement
    /// that is already running must not be handed out a second time.
    private var activeStatements: Set<OpaquePointer> = []

    private var savepointDepth = 0

    let path: String

    // -------------------------------------------------------------------------
    // Opening
    // -------------------------------------------------------------------------

    init(path: String, migrations: [Migration]) throws {
        self.path = path
        self.queue = DispatchQueue(label: "com.karahoca.tracker.sqlite")
        queue.setSpecific(key: queueKey, value: 1)

        var db: OpaquePointer?
        /*
         * FULLMUTEX, even though the serial queue already guarantees exclusion.
         *
         * The queue is the real discipline; this is the seatbelt. If some later
         * change touches the handle from another thread — a background
         * URLSession completion, a test helper, a well-meaning refactor — the
         * failure mode with FULLMUTEX is a slow path, and without it is heap
         * corruption on a driver's phone at 3 a.m. with no symbolicated crash.
         */
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(path, &db, flags, nil)
        guard rc == SQLITE_OK, let opened = db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            if db != nil { sqlite3_close_v2(db) }
            throw Failure.open(code: rc, message: message)
        }
        self.handle = opened

        applyPragmas()
        try migrate(migrations)
        protectFiles()
    }

    deinit { close() }

    func close() {
        sync {
            for (_, stmt) in statementCache { sqlite3_finalize(stmt) }
            statementCache.removeAll()
            if handle != nil {
                sqlite3_close_v2(handle)
                handle = nil
            }
        }
    }

    /// Tuning. Deliberately best-effort.
    ///
    /// Mirrors the lesson `TrackerDatabase.kt` records on Android, where a
    /// pragma sent down the wrong API threw on every database open, on every
    /// device, and killed the app two seconds after launch. A tuning pragma is
    /// never allowed to be the reason a driver's shift goes untracked: if one is
    /// rejected we log it and run on SQLite's defaults.
    private func applyPragmas() {
        /*
         * WAL, and it is not about read/write concurrency here — there is one
         * connection and one queue.
         *
         * It is about what a commit costs and what a crash costs. A rollback
         * journal commit writes the journal, fsyncs, writes the pages, fsyncs,
         * then deletes the journal: four disk barriers, six times a minute, for
         * fourteen hours. A WAL commit appends to one file. And with
         * synchronous=NORMAL, WAL is *documented not to corrupt* on power loss —
         * you lose the most recent commits and nothing else — whereas a rollback
         * journal at NORMAL can leave the database itself inconsistent.
         *
         * That is precisely the trade this buffer wants: we will accept losing
         * the last few seconds of a route to a battery pull, and we will not
         * accept losing the file.
         *
         * Worth being exact about the failure we are NOT exposed to: an iOS app
         * being killed — jetsam, force-quit, the watchdog — is a *process*
         * death, not a power loss. The committed WAL bytes are already in the
         * kernel's page cache and survive it intact. synchronous=NORMAL costs us
         * nothing there; only a kernel panic or a flat battery can reach the
         * tail of the log.
         */
        pragma("PRAGMA journal_mode = WAL")
        pragma("PRAGMA synchronous = NORMAL")
        pragma("PRAGMA temp_store = MEMORY")
        // ~8 MB page cache: enough that claiming a 500-row batch never has to
        // touch the same index page twice.
        pragma("PRAGMA cache_size = -8000")
        // Nothing else opens this file, so a busy timeout should never fire.
        // It is here for the one case that can: iOS unlinking the -shm file
        // under memory pressure while a checkpoint is in progress.
        pragma("PRAGMA busy_timeout = 5000")
    }

    @discardableResult
    private func pragma(_ sql: String) -> String? {
        do {
            // Through the full prepare/step path, never a fire-and-forget exec.
            // A setter pragma such as `journal_mode` answers with the value it
            // actually applied, and we want to be able to read that answer —
            // "WAL was requested" and "WAL is on" are different facts.
            return try first(sql) { $0.textOrNil(0) } ?? nil
        } catch {
            Self.log.warning("PRAGMA rejected, continuing on defaults: \(sql, privacy: .public) — \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// Current journal mode, for tests and diagnostics.
    var journalMode: String { pragma("PRAGMA journal_mode")?.uppercased() ?? "UNKNOWN" }

    // -------------------------------------------------------------------------
    // Migrations
    // -------------------------------------------------------------------------

    /// Forward-only, and there is no destructive fallback. Not ever.
    ///
    /// Room's `fallbackToDestructiveMigration` is the exact thing
    /// `TrackerDatabase.kt` refuses, for the exact reason that applies here: on
    /// the day an app update ships with a schema change, the buffer on some
    /// driver's phone is holding a shift's worth of points that never reached
    /// the server. Dropping the table to make the update easy deletes a route
    /// that no longer exists anywhere else.
    private func migrate(_ migrations: [Migration]) throws {
        let current = try first("PRAGMA user_version") { Int32($0.int(0)) } ?? 0
        let target = migrations.map(\.version).max() ?? 0

        if current > target {
            /*
             * The database was written by a newer build than this one — a
             * TestFlight rollback, or a driver reinstalling an older IPA.
             *
             * We keep it and carry on. An added column is harmless to our
             * statements (they name their columns); an added NOT NULL column
             * would make inserts fail, which surfaces as a logged, counted
             * failure per fix rather than as the silent deletion of everything
             * already buffered. Degrading loudly beats erasing quietly.
             */
            Self.log.error("Schema v\(current) is newer than this build's v\(target). Keeping the file: it may hold unsent points.")
            return
        }

        for migration in migrations where migration.version > current {
            try transaction { () -> Void in
                for statement in migration.statements { try exec(statement) }
                // Interpolated rather than bound: PRAGMA does not accept
                // parameters, and the value is an Int32 from our own source.
                try exec("PRAGMA user_version = \(migration.version)")
            }
            Self.log.notice("Applied schema migration v\(migration.version)")
        }
    }

    // -------------------------------------------------------------------------
    // File protection — the iOS-specific way to lose a whole shift
    // -------------------------------------------------------------------------

    /// Pin the data protection class to `completeUntilFirstUserAuthentication`.
    ///
    /// This is not tidying. Under the stricter `complete` class, iOS makes a
    /// file's contents unreadable *while the device is locked* — and a phone
    /// tracking a lorry is locked in a cradle for essentially the entire shift.
    /// Every background write would come back `SQLITE_IOERR` and every fix would
    /// be dropped, with the app looking perfectly healthy whenever the driver
    /// picked it up and unlocked it. `completeUntilFirstUserAuthentication` is
    /// the class that survives the screen locking, and it must be applied to the
    /// `-wal` and `-shm` sidecars too: SQLite creates them itself, and the
    /// database is only as available as its journal.
    ///
    /// (`sqlite3_open_v2` accepts an Apple-specific protection flag that would
    /// do this at open time. Setting it through `FileManager` afterwards is one
    /// extra call and does not depend on a constant that is not in the Swift
    /// overlay.)
    private func protectFiles() {
        #if os(iOS)
        let attributes: [FileAttributeKey: Any] = [
            .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
        ]
        for suffix in ["", "-wal", "-shm"] {
            let target = path + suffix
            guard FileManager.default.fileExists(atPath: target) else { continue }
            do {
                try FileManager.default.setAttributes(attributes, ofItemAtPath: target)
            } catch {
                Self.log.error("Could not set file protection on \(suffix.isEmpty ? "db" : suffix, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
        #endif
    }

    // -------------------------------------------------------------------------
    // Running statements
    // -------------------------------------------------------------------------

    /// The queue entry point, re-entrant.
    ///
    /// Everything public funnels through here, and helpers call each other
    /// freely — `transaction` calls `run`, `migrate` calls both. Without the
    /// queue-specific check, the second `queue.sync` on the same thread would
    /// deadlock the app permanently, and it would do so only on the code path
    /// that happens to nest, which is exactly the sort of bug that ships.
    @discardableResult
    func sync<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return try body() }
        return try queue.sync(execute: body)
    }

    /// Run SQL with no bindings and no results. Accepts several statements.
    func exec(_ sql: String) throws {
        try sync {
            var error: UnsafeMutablePointer<CChar>?
            let rc = sqlite3_exec(handle, sql, nil, nil, &error)
            guard rc == SQLITE_OK else {
                let message = error.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(handle))
                sqlite3_free(error)
                throw Failure.statement(sql: sql, code: rc, message: message)
            }
            sqlite3_free(error)
        }
    }

    /// Run one statement to completion. Returns the number of rows it changed.
    @discardableResult
    func run(_ sql: String, _ binds: [SQLValue] = []) throws -> Int {
        try sync {
            try withStatement(sql) { stmt in
                try bind(binds, to: stmt, sql: sql)
                let rc = sqlite3_step(stmt)
                guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
                    throw Failure.statement(sql: sql, code: rc, message: String(cString: sqlite3_errmsg(handle)))
                }
                return Int(sqlite3_changes(handle))
            }
        }
    }

    func query<T>(_ sql: String, _ binds: [SQLValue] = [], _ decode: (SQLRow) -> T) throws -> [T] {
        try sync {
            try withStatement(sql) { stmt in
                try bind(binds, to: stmt, sql: sql)
                var out: [T] = []
                while true {
                    let rc = sqlite3_step(stmt)
                    if rc == SQLITE_ROW {
                        out.append(decode(SQLRow(handle: stmt)))
                    } else if rc == SQLITE_DONE {
                        return out
                    } else {
                        throw Failure.statement(sql: sql, code: rc, message: String(cString: sqlite3_errmsg(handle)))
                    }
                }
            }
        }
    }

    func first<T>(_ sql: String, _ binds: [SQLValue] = [], _ decode: (SQLRow) -> T) throws -> T? {
        try sync {
            try withStatement(sql) { stmt in
                try bind(binds, to: stmt, sql: sql)
                let rc = sqlite3_step(stmt)
                if rc == SQLITE_ROW { return decode(SQLRow(handle: stmt)) }
                guard rc == SQLITE_DONE else {
                    throw Failure.statement(sql: sql, code: rc, message: String(cString: sqlite3_errmsg(handle)))
                }
                return nil
            }
        }
    }

    func count(_ sql: String, _ binds: [SQLValue] = []) throws -> Int {
        try first(sql, binds) { Int($0.int(0)) } ?? 0
    }

    /// Atomic unit of work, composable.
    ///
    /// SAVEPOINT rather than BEGIN/COMMIT so that nesting is correct rather than
    /// merely tolerated. A plain depth counter would let an inner failure that
    /// the outer caller catches leave half-applied work inside a transaction
    /// that then commits — which in this schema means a point row whose device
    /// sequence number was never persisted, and a sequence that repeats after
    /// the next launch.
    @discardableResult
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try sync {
            savepointDepth += 1
            let name = "kh_sp_\(savepointDepth)"
            defer { savepointDepth -= 1 }

            try exec("SAVEPOINT \(name)")
            do {
                let result = try body()
                try exec("RELEASE \(name)")
                return result
            } catch {
                // Best effort: if the rollback itself fails the connection is
                // already unusable and the original error is the useful one.
                try? exec("ROLLBACK TO \(name)")
                try? exec("RELEASE \(name)")
                throw error
            }
        }
    }

    /// Force a WAL checkpoint and truncate the log.
    ///
    /// Never on the hot path — SQLite's automatic checkpointing at a thousand
    /// pages is what should be doing this work. It is here for the end of a
    /// session, where folding the WAL back into the database means the next
    /// cold background launch has nothing to recover before it can write.
    func checkpoint() {
        sync { _ = sqlite3_wal_checkpoint_v2(handle, nil, SQLITE_CHECKPOINT_TRUNCATE, nil, nil) }
    }

    // -------------------------------------------------------------------------
    // Statement plumbing
    // -------------------------------------------------------------------------

    private func withStatement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        let cached = statementCache[sql]
        /*
         * A cached statement that is already mid-`step` cannot be reused.
         *
         * It happens the moment a decode closure runs a nested query on the same
         * SQL — resetting and re-binding the live statement would silently
         * truncate the outer loop. Rather than forbid nesting (a rule nobody
         * remembers), prepare a throwaway and finalise it on the way out.
         */
        let reusable = cached != nil && !activeStatements.contains(cached!)

        let stmt: OpaquePointer
        if reusable {
            stmt = cached!
        } else {
            stmt = try prepare(sql)
            if cached == nil { statementCache[sql] = stmt }
        }
        let throwaway = !reusable && cached != nil

        activeStatements.insert(stmt)
        defer {
            activeStatements.remove(stmt)
            if throwaway {
                sqlite3_finalize(stmt)
            } else {
                sqlite3_reset(stmt)
                sqlite3_clear_bindings(stmt)
            }
        }
        return try body(stmt)
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(handle, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK, let prepared = stmt else {
            throw Failure.statement(sql: sql, code: rc, message: String(cString: sqlite3_errmsg(handle)))
        }
        return prepared
    }

    private func bind(_ values: [SQLValue], to stmt: OpaquePointer, sql: String) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let rc: Int32
            switch value {
            case .null:
                rc = sqlite3_bind_null(stmt, index)
            case let .integer(v):
                rc = sqlite3_bind_int64(stmt, index, v)
            case let .real(v):
                rc = sqlite3_bind_double(stmt, index, v)
            case let .text(v):
                /*
                 * SQLITE_TRANSIENT, never SQLITE_STATIC.
                 *
                 * Swift hands the C call a pointer to the String's bytes that is
                 * only valid for the duration of that call. STATIC would tell
                 * SQLite "these bytes will outlive me" and it would read freed
                 * memory at step() — a use-after-free that mostly works, which is
                 * the worst kind. TRANSIENT makes SQLite copy immediately.
                 */
                rc = sqlite3_bind_text(stmt, index, v, -1, sqliteTransient)
            }
            guard rc == SQLITE_OK else {
                throw Failure.statement(sql: sql, code: rc, message: String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Values and rows
// -----------------------------------------------------------------------------

/// SQLite tells a bound pointer's owner when it is safe to free the bytes.
/// `-1` is the sentinel meaning "copy them now"; there is no symbol for it in
/// the Swift overlay, so it is reconstructed here the way everyone does.
private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)

    // Deliberately distinct names per type rather than overloads on the same
    // one: `.intOrNull(nil)` against overloaded Int?/Int64? parameters is
    // ambiguous at the call site, and the diagnostic points at the wrong line.
    static func int64OrNull(_ value: Int64?) -> SQLValue { value.map { .integer($0) } ?? .null }
    static func intOrNull(_ value: Int?) -> SQLValue { value.map { .integer(Int64($0)) } ?? .null }
    static func doubleOrNull(_ value: Double?) -> SQLValue { value.map { .real($0) } ?? .null }
    static func textOrNull(_ value: String?) -> SQLValue { value.map { .text($0) } ?? .null }
    static func bool(_ value: Bool) -> SQLValue { .integer(value ? 1 : 0) }

    /// Epoch milliseconds. The whole schema stores time this way, matching the
    /// Android buffer and the `recordedAt` the ingest endpoint accepts, so that
    /// a point can be handed to the encoder without a conversion that could
    /// round differently on the two platforms.
    static func millis(_ value: Date) -> SQLValue {
        .integer(Int64((value.timeIntervalSince1970 * 1000).rounded()))
    }

    static func millisOrNull(_ value: Date?) -> SQLValue { value.map { .millis($0) } ?? .null }
}

struct SQLRow {
    fileprivate let handle: OpaquePointer

    func isNull(_ index: Int32) -> Bool { sqlite3_column_type(handle, index) == SQLITE_NULL }

    func int(_ index: Int32) -> Int64 { sqlite3_column_int64(handle, index) }
    func int64OrNil(_ index: Int32) -> Int64? { isNull(index) ? nil : sqlite3_column_int64(handle, index) }
    func intOrNil(_ index: Int32) -> Int? { isNull(index) ? nil : Int(sqlite3_column_int64(handle, index)) }
    func double(_ index: Int32) -> Double { sqlite3_column_double(handle, index) }
    func doubleOrNil(_ index: Int32) -> Double? { isNull(index) ? nil : sqlite3_column_double(handle, index) }
    func bool(_ index: Int32) -> Bool { sqlite3_column_int64(handle, index) != 0 }

    func textOrNil(_ index: Int32) -> String? {
        guard let bytes = sqlite3_column_text(handle, index) else { return nil }
        return String(cString: bytes)
    }

    func text(_ index: Int32) -> String { textOrNil(index) ?? "" }

    func millis(_ index: Int32) -> Date { Date(timeIntervalSince1970: Double(int(index)) / 1000) }
    func millisOrNil(_ index: Int32) -> Date? {
        int64OrNil(index).map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }
}

// -----------------------------------------------------------------------------
// The schema
// -----------------------------------------------------------------------------

/// Every table the app owns, in one place, versioned by `PRAGMA user_version`.
///
/// The point buffer and the session state share a database rather than living in
/// a table and a `UserDefaults` plist respectively, and that is a deliberate
/// change from Android, where the two are Room and DataStore. Two reasons:
///
///  - **The device sequence number can be exact.** On Android it is held in
///    memory and flushed to DataStore every hundredth value, because each
///    DataStore write re-serialises the whole preferences map and fsyncs it —
///    ten thousand full rewrites a shift to maintain one integer. Here the
///    counter update and the point insert are two statements in one
///    transaction, so they commit or fail together. No reserved window, no
///    skipped numbers after a kill, and no window at all in which a fix exists
///    with a sequence number the next launch will hand out again.
///  - **One durability story.** A single WAL, a single lock, a single answer to
///    "what survives a kill". Two stores means two answers, and the interesting
///    bugs live in the gap between them.
enum TrackerSchema {

    static let migrations: [SQLiteDatabase.Migration] = [
        SQLiteDatabase.Migration(version: 1, statements: [
            """
            CREATE TABLE IF NOT EXISTS location_points (
                id                   TEXT    PRIMARY KEY NOT NULL,
                session_id           TEXT    NOT NULL,
                recorded_at          INTEGER NOT NULL,
                monotonic_ns         INTEGER NOT NULL,
                lat                  REAL    NOT NULL,
                lon                  REAL    NOT NULL,
                accuracy_m           REAL,
                altitude_m           REAL,
                vertical_accuracy_m  REAL,
                speed_mps            REAL,
                speed_accuracy_mps   REAL,
                bearing_deg          REAL,
                satellites           INTEGER,
                provider             TEXT,
                battery_pct          INTEGER,
                is_charging          INTEGER NOT NULL DEFAULT 0,
                is_mock              INTEGER NOT NULL DEFAULT 0,
                network_type         TEXT,
                device_seq           INTEGER NOT NULL,
                sync_state           INTEGER NOT NULL DEFAULT 0,
                batch_id             TEXT,
                claimed_at           INTEGER NOT NULL DEFAULT 0,
                attempts             INTEGER NOT NULL DEFAULT 0,
                created_at           INTEGER NOT NULL
            )
            """,
            // The uploader's only query: oldest pending first.
            "CREATE INDEX IF NOT EXISTS idx_points_pending ON location_points (sync_state, recorded_at)",
            // Releasing, acknowledging or reading a claimed batch.
            "CREATE INDEX IF NOT EXISTS idx_points_batch ON location_points (batch_id)",

            """
            CREATE TABLE IF NOT EXISTS pending_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT    NOT NULL,
                type        TEXT    NOT NULL,
                occurred_at INTEGER NOT NULL,
                message     TEXT,
                payload     TEXT,
                attempts    INTEGER NOT NULL DEFAULT 0
            )
            """,
            /*
             * AUTOINCREMENT, which SQLite normally advises against.
             *
             * Without it a rowid is reused as soon as the highest row is
             * deleted, and this queue deletes its highest row constantly: event
             * 7 is delivered and dropped, the next event inserted becomes 7
             * again, and a retried acknowledgement for the old 7 deletes an
             * event that was never sent. The extra sequence table costs one page.
             */

            """
            CREATE TABLE IF NOT EXISTS session_state (
                key   TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            )
            """,
        ]),
    ]
}

// -----------------------------------------------------------------------------
// Composition
// -----------------------------------------------------------------------------

/// The whole storage layer, opened once.
///
/// The app holds exactly one of these for its lifetime. `PointBuffer` and
/// `SessionStore` share the connection deliberately — see `TrackerSchema`.
struct TrackerStorage {
    let database: SQLiteDatabase
    let session: SessionStore
    let points: PointBuffer

    static func open(
        directory: URL? = nil,
        maxRows: Int = PointBuffer.defaultMaxRows
    ) throws -> TrackerStorage {
        let folder = try directory ?? defaultDirectory()
        let file = folder.appendingPathComponent("karahoca-tracker.db")

        let database = try SQLiteDatabase(path: file.path, migrations: TrackerSchema.migrations)
        let session = SessionStore(database: database)
        let points = PointBuffer(database: database, session: session, maxRows: maxRows)
        return TrackerStorage(database: database, session: session, points: points)
    }

    /// Application Support, not Caches and not Documents.
    ///
    ///  - **Caches is purgeable.** iOS deletes it under disk pressure, without
    ///    asking and without telling the app. A buffer the operating system is
    ///    allowed to throw away is not a buffer.
    ///  - **Documents is user-visible** once file sharing is on, and a driver
    ///    with a route database in the Files app is a support call waiting to
    ///    happen.
    ///
    /// The directory is also excluded from backup: these are device-local
    /// operational bytes, they can reach hundreds of megabytes, and restoring
    /// one phone's unsent route onto a different phone would replay another
    /// driver's shift under a session that has long since closed.
    static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        var folder = base.appendingPathComponent("KaraHoca", isDirectory: true)

        if !FileManager.default.fileExists(atPath: folder.path) {
            var attributes: [FileAttributeKey: Any] = [:]
            #if os(iOS)
            attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
            #endif
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true, attributes: attributes
            )
        }

        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? folder.setResourceValues(&values)

        return folder
    }
}

package com.karahoca.tracker.data.local

import android.content.Context
import android.util.Log
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [LocationPointEntity::class, PendingEventEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class TrackerDatabase : RoomDatabase() {

    abstract fun locationPointDao(): LocationPointDao
    abstract fun pendingEventDao(): PendingEventDao

    companion object {
        private const val TAG = "KH/Database"

        fun build(context: Context): TrackerDatabase =
            Room.databaseBuilder(context, TrackerDatabase::class.java, "karahoca-tracker.db")
                /*
                 * WAL + synchronous=NORMAL is the right trade for a GPS buffer.
                 *
                 *  - WAL lets the sync worker read while the location callback
                 *    writes, with no lock contention every 10 seconds.
                 *  - synchronous=NORMAL fsyncs at checkpoints rather than on
                 *    every commit. A hard power loss can cost the last fixes
                 *    (seconds), while FULL would fsync 6× a minute for a
                 *    14-hour shift and measurably burn both battery and flash.
                 *    We accept seconds of loss on a kernel panic; the phone is
                 *    in a truck, not running a bank ledger.
                 */
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .addCallback(object : RoomDatabase.Callback() {
                    override fun onOpen(db: SupportSQLiteDatabase) {
                        /*
                         * Every PRAGMA goes through query(), never execSQL().
                         *
                         * execSQL throws SQLiteException("Queries can be
                         * performed using SQLiteDatabase query or rawQuery
                         * methods only") for any statement that produces a
                         * result set — and `PRAGMA busy_timeout = N` returns
                         * the resulting value even when you are SETTING it.
                         * That threw here on every database open, on every
                         * device, which meant the location buffer could never
                         * be created: the app died two seconds after launch.
                         *
                         * query() is correct for both kinds — a setter pragma
                         * simply yields an empty cursor — so routing all of
                         * them through it removes the whole class of mistake.
                         */
                        fun pragma(sql: String) {
                            runCatching { db.query(sql).use { it.moveToFirst() } }
                                .onFailure {
                                    // A tuning pragma must never be the reason a
                                    // driver's shift goes untracked. Degrade to
                                    // SQLite defaults and keep the buffer alive.
                                    Log.w(TAG, "PRAGMA rejected: $sql", it)
                                }
                        }

                        pragma("PRAGMA synchronous = NORMAL")
                        pragma("PRAGMA temp_store = MEMORY")
                        // ~8 MB page cache: enough that claiming a 500-row
                        // batch never touches disk twice.
                        pragma("PRAGMA cache_size = -8000")
                        pragma("PRAGMA busy_timeout = 5000")
                    }
                })
                /*
                 * NO fallbackToDestructiveMigration.
                 *
                 * A destructive migration on app update would delete buffered
                 * points that had never reached the server. Every future schema
                 * change must ship a real Migration, even if that means holding
                 * a release back a day.
                 */
                .build()
    }
}

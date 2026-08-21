#!/usr/bin/env node
/**
 * KaraHoca migration runner.
 *
 * Deliberately ~200 lines of plain Node instead of a migration framework:
 * a self-hosted system should be restorable by anyone who can read JavaScript,
 * at 2 a.m., without first learning a tool's CLI.
 *
 *   node migrate.mjs            apply pending migrations
 *   node migrate.mjs --seed     apply migrations, then db/seed/*.sql
 *   node migrate.mjs --status   list applied / pending, exit 0
 *   node migrate.mjs --verify   fail if any applied migration's checksum drifted
 *   node migrate.mjs --reseal <file>
 *                               re-record one applied migration's checksum
 *
 * --reseal exists for one narrow case: a file whose *comments* were edited
 * after it was applied. The drift check compares bytes, correctly — it is there
 * to catch someone quietly changing the SQL under a database that has already
 * run it — but it cannot tell a corrected paragraph from a dropped column, and
 * a warning nobody can ever clear is a warning everybody learns to scroll past.
 *
 * It takes one exact filename, never a pattern, prints both checksums, and
 * makes you assert the SQL is untouched. If you are resealing more than once in
 * a blue moon, the thing to fix is the habit of editing applied migrations.
 *
 * A file may opt out of the wrapping transaction with a first-line directive:
 *   -- migrate:no-transaction
 * which is required for TimescaleDB continuous aggregates.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');
const SEED_DIR = join(__dirname, 'seed');

const args = new Set(process.argv.slice(2));
const WANT_SEED = args.has('--seed');
const STATUS_ONLY = args.has('--status');
const VERIFY = args.has('--verify');
/** `--reseal 0013_foo.sql` — the filename is the argument after the flag. */
const RESEAL = (() => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--reseal');
  return i >= 0 ? argv[i + 1] : undefined;
})();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const log = (...a) => console.log('[migrate]', ...a);

/**
 * Split a SQL file into top-level statements.
 *
 * Handles: line comments, block comments, single-quoted strings (incl. '' escape),
 * double-quoted identifiers, and dollar-quoted bodies with arbitrary tags
 * ($$ … $$, $ddl$ … $ddl$). Without dollar-quote awareness a naive split on ';'
 * shreds every PL/pgSQL function in this repo.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // single-quoted literal
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // dollar quoting
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*\n?/g, '').trim().length > 0);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.kh_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);
  // Cooperative lock: two containers booting at once must not race.
  await client.query('SELECT pg_advisory_lock($1)', [0x4b48_4d47]);
}

async function listSqlFiles(dir) {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function applyFile(client, dir, filename, ledger) {
  const raw = await readFile(join(dir, filename), 'utf8');
  const checksum = sha256(raw);
  const noTx = /^\s*--\s*migrate:no-transaction/m.test(raw.split('\n').slice(0, 3).join('\n'));

  const previous = ledger.get(filename);
  if (previous) {
    if (previous !== checksum) {
      const msg = `CHECKSUM DRIFT in ${filename}. Applied migrations are immutable; add a new file instead.`;
      if (VERIFY) throw new Error(msg);
      console.warn('[migrate] WARNING:', msg);
    }
    return false;
  }
  if (STATUS_ONLY) {
    log(`pending: ${filename}`);
    return false;
  }

  const started = Date.now();
  log(`applying ${filename}${noTx ? ' (no-transaction)' : ''}`);

  if (noTx) {
    for (const stmt of splitStatements(raw)) {
      await client.query(stmt);
    }
  } else {
    await client.query('BEGIN');
    try {
      await client.query(raw);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  const duration = Date.now() - started;
  await client.query(
    `INSERT INTO public.kh_migrations (filename, checksum, duration_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
    [filename, checksum, duration],
  );
  log(`  ✓ ${filename} in ${duration} ms`);
  return true;
}

/**
 * Re-record the checksum of one already-applied migration.
 *
 * Runs no SQL from the file. That is the whole point: the schema is presumed
 * unchanged, and if it is not, this is the wrong tool — the right one is a new
 * migration.
 */
async function reseal(client, filename) {
  const raw = await readFile(join(MIGRATIONS_DIR, filename), 'utf8').catch(() => null);
  if (raw === null) throw new Error(`no such migration: ${filename}`);

  const { rows } = await client.query(
    'SELECT checksum FROM public.kh_migrations WHERE filename = $1',
    [filename],
  );
  if (rows.length === 0) throw new Error(`${filename} has never been applied; nothing to reseal`);

  const recorded = rows[0].checksum;
  const current = sha256(raw);
  if (recorded === current) {
    log(`${filename} already matches; nothing to do`);
    return;
  }

  console.warn(
    `[migrate] RESEALING ${filename}\n` +
      `[migrate]   recorded ${recorded}\n` +
      `[migrate]   on disk  ${current}\n` +
      `[migrate]   No SQL is run. Only do this when the difference is comments.`,
  );
  await client.query(
    'UPDATE public.kh_migrations SET checksum = $2 WHERE filename = $1',
    [filename, current],
  );
  log(`${filename} resealed`);
}

async function main() {
  const client = new pg.Client({ connectionString, application_name: 'kh-migrate' });

  // Postgres inside Compose can be reachable before it is *ready*.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`database not ready (${err.code || err.message}); retry ${attempt}/30`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  try {
    await ensureLedger(client);

    if (RESEAL) {
      await reseal(client, RESEAL);
      return;
    }

    const { rows } = await client.query('SELECT filename, checksum FROM public.kh_migrations');
    const ledger = new Map(rows.map((r) => [r.filename, r.checksum]));

    let applied = 0;
    for (const file of await listSqlFiles(MIGRATIONS_DIR)) {
      if (await applyFile(client, MIGRATIONS_DIR, file, ledger)) applied += 1;
    }

    if (WANT_SEED && !STATUS_ONLY) {
      for (const file of await listSqlFiles(SEED_DIR)) {
        const key = `seed/${file}`;
        if (ledger.has(key)) continue;
        const raw = await readFile(join(SEED_DIR, file), 'utf8');
        log(`seeding ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(raw);
          await client.query(
            `INSERT INTO public.kh_migrations (filename, checksum, duration_ms)
             VALUES ($1, $2, 0) ON CONFLICT (filename) DO NOTHING`,
            [key, sha256(raw)],
          );
          await client.query('COMMIT');
          log(`  ✓ ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }

    log(applied === 0 ? 'database is up to date' : `applied ${applied} migration(s)`);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [0x4b48_4d47]); } catch { /* ignore */ }
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  if (err.position) console.error('[migrate] at character', err.position);
  if (err.detail) console.error('[migrate] detail:', err.detail);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * SQL test runner.
 *
 *   DATABASE_URL=... node db/tests/run.mjs
 *
 * Applies 00_harness.sql then every NN_*.sql in order, and reports the contents
 * of kh_test.results. Exits non-zero on any failure so CI can gate on it.
 *
 * These tests write into the real hypertable on purpose — a mocked ingest test
 * would prove nothing about ON CONFLICT, window-function distance maths, or
 * Timescale chunk routing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const client = new pg.Client({ connectionString, application_name: 'kh-tests' });
await client.connect();
await client.query("SET search_path TO kh, public; SET timezone TO 'UTC';");

const files = (await readdir(HERE)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

let hardFailure = null;
for (const file of files) {
  const sql = await readFile(join(HERE, file), 'utf8');
  process.stdout.write(`${DIM}running ${file}…${OFF} `);
  const started = Date.now();
  try {
    await client.query(sql);
    console.log(`${DIM}${Date.now() - started} ms${OFF}`);
  } catch (err) {
    console.log(`${RED}ERROR${OFF}`);
    console.error(`\n${RED}${file} raised:${OFF} ${err.message}`);
    if (err.where) console.error(`${DIM}${err.where}${OFF}`);
    hardFailure = file;
    break;
  }
}

const { rows } = await client.query(
  `SELECT suite, name, ok, expected, actual FROM kh_test.results ORDER BY id`,
);

console.log('');
let currentSuite = null;
let passed = 0;
let failed = 0;

for (const row of rows) {
  if (row.suite !== currentSuite) {
    currentSuite = row.suite;
    console.log(`${BOLD}${currentSuite}${OFF}`);
  }
  if (row.ok) {
    passed += 1;
    console.log(`  ${GREEN}PASS${OFF}  ${row.name}`);
  } else {
    failed += 1;
    console.log(`  ${RED}FAIL${OFF}  ${row.name}`);
    console.log(`        expected: ${row.expected}`);
    console.log(`        actual:   ${row.actual}`);
  }
}

console.log('');
console.log(
  `${BOLD}${passed + failed} assertions — ${GREEN}${passed} passed${OFF}` +
    (failed ? `, ${RED}${failed} failed${OFF}` : ''),
);

await client.end();

if (hardFailure) {
  console.error(`\n${RED}Aborted: ${hardFailure} did not execute to completion.${OFF}`);
  process.exit(2);
}
process.exit(failed > 0 ? 1 : 0);

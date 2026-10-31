#!/usr/bin/env node
// Writes a consistent copy of the SQLite database while the server keeps
// running: VACUUM INTO reads through the WAL and takes no write lock.
//
//   node scripts/db-snapshot.mjs [--out <file>] [--include-cache] [--db <path>]
//
// The database is DATABASE_URI's, as the server resolves it, unless --db names
// one. The copy goes to stdout unless --out names a file. Its cache table is
// emptied unless --include-cache keeps it. In the image:
//
//   docker compose exec -T server /nodejs/bin/node scripts/db-snapshot.mjs > db.sqlite
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { parseArgs } from 'util';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const { values: options } = parseArgs({
  options: {
    out: { type: 'string' },
    db: { type: 'string' },
    'include-cache': { type: 'boolean', default: false },
  },
});

/** The same resolution as core's db/connect.ts. */
function databasePath() {
  if (options.db) return path.resolve(options.db);
  const url = new URL(process.env.DATABASE_URI || 'sqlite://./data/db.sqlite');
  if (url.protocol !== 'sqlite:') {
    fail(`Only a SQLite database can be snapshotted, not ${url.protocol}`);
  }
  return url.hostname === '.'
    ? path.join(process.cwd(), url.pathname.replace(/^\//, ''))
    : url.pathname;
}

/** core's better-sqlite3, which the app and the repo both have beside this script. */
function loadSqlite() {
  try {
    return createRequire(new URL('../packages/core/', import.meta.url))(
      'better-sqlite3'
    );
  } catch {
    fail('better-sqlite3 not found in packages/core');
  }
}

const source = databasePath();
if (!fs.existsSync(source)) fail(`No database at ${source}`);
if (!options.out && process.stdout.isTTY) {
  fail('Refusing to write a database to a terminal; redirect it or pass --out');
}
if (options.out) {
  // The rename would replace a live database and strand its WAL beside the copy.
  const realpath = (file) =>
    path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const out = path.resolve(options.out);
  if (!fs.existsSync(path.dirname(out))) {
    fail(`No directory for --out at ${path.dirname(out)}`);
  }
  if (realpath(out) === realpath(source)) {
    fail('--out is the database being snapshotted');
  }
  if (fs.existsSync(`${out}-wal`)) {
    fail(
      `${options.out} has a WAL beside it, so may be in use; pick another --out`
    );
  }
}

const Database = loadSqlite();
// One folder in the temp directory holds the copy and whatever SQLite spills
// while it shrinks it, so a run that dies leaves nothing beside the database;
// a container's goes when it's recreated.
let workDir;
try {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-snapshot-'));
} catch (error) {
  fail(`No temp directory at ${os.tmpdir()} (set TMPDIR): ${error.message}`);
}
process.env.SQLITE_TMPDIR = workDir;
const tmp = path.join(workDir, 'snapshot.sqlite');
const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });

/** Moves the finished copy to --out, by copying when the temp directory is on another disk. */
function moveTo(out) {
  try {
    fs.renameSync(tmp, out);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const partial = `${out}.partial-${process.pid}`;
    try {
      fs.copyFileSync(tmp, partial);
      fs.renameSync(partial, out);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }
}

try {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    db.close();
  }
  if (!options['include-cache']) {
    const snapshot = new Database(tmp);
    try {
      snapshot.exec('DELETE FROM cache');
      snapshot.exec('VACUUM');
    } finally {
      snapshot.close();
    }
  }
  const { size } = fs.statSync(tmp);
  if (options.out) {
    moveTo(path.resolve(options.out));
  } else {
    await pipeline(fs.createReadStream(tmp), process.stdout);
  }
  console.error(
    `✓ Snapshot of ${source} (${(size / 1024 / 1024).toFixed(1)} MB)` +
      (options.out ? ` written to ${options.out}` : '')
  );
} catch (error) {
  cleanup();
  fail(`Snapshot failed: ${error.message}`);
}
cleanup();

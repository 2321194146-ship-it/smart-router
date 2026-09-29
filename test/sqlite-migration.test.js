/**
 * SQLite cost_daily migration — verified against the REAL better-sqlite3 native module
 * (compiled locally on macOS), not a mock. Exercises the idempotent schema migration that
 * previously crashed startup on legacy databases that had a `provider` column but an outdated
 * PRIMARY KEY of (date, model).
 */
import test from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { migrateCostDaily } from '../src/server.js';

function freshMem() {
  return new Database(':memory:');
}

function newSchema() {
  return `CREATE TABLE cost_daily (
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT DEFAULT '',
    requests INTEGER DEFAULT 1,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_rmb REAL DEFAULT 0,
    PRIMARY KEY (date, model, provider)
  );`;
}

function legacySchema() {
  return `CREATE TABLE cost_daily (
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER DEFAULT 1,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_rmb REAL DEFAULT 0,
    PRIMARY KEY (date, model)
  );`;
}

function pkCols(db) {
  return db.pragma('table_info(cost_daily)').filter((c) => c.pk > 0).map((c) => c.name).sort().join(',');
}

test('fresh database with the new PK is already-current (no migration)', () => {
  const db = freshMem();
  db.exec(newSchema());
  const r = migrateCostDaily(db);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'already-current');
  assert.strictEqual(pkCols(db), 'date,model,provider');
  db.close();
});

test('legacy PK (date, model) migrates to (date, model, provider)', () => {
  const db = freshMem();
  db.exec(legacySchema());
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-01', 'm1', 5);
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-02', 'm2', 3);
  const r = migrateCostDaily(db);
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(pkCols(db), 'date,model,provider');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM cost_daily').get().c, 2, 'row count preserved');
  db.close();
});

test('migration is idempotent across repeated startups', () => {
  const db = freshMem();
  db.exec(legacySchema());
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-01', 'm1', 7);
  const first = migrateCostDaily(db);
  assert.strictEqual(first.migrated, true);
  const second = migrateCostDaily(db); // simulate a restart
  assert.strictEqual(second.migrated, false);
  assert.strictEqual(second.reason, 'already-current');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM cost_daily').get().c, 1, 'no row duplicated on re-run');
  db.close();
});

test('legacy (date, model) table with existing provider column also migrates', () => {
  const db = freshMem();
  db.exec(`CREATE TABLE cost_daily (
    date TEXT NOT NULL, model TEXT NOT NULL, provider TEXT DEFAULT '',
    requests INTEGER DEFAULT 1, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_rmb REAL DEFAULT 0,
    PRIMARY KEY (date, model)
  );`);
  db.prepare('INSERT INTO cost_daily (date, model, provider, requests) VALUES (?, ?, ?, ?)').run('2026-01-01', 'm1', 'A', 4);
  const r = migrateCostDaily(db);
  assert.strictEqual(r.migrated, true, 'a provider column must not hide an outdated PK');
  assert.strictEqual(pkCols(db), 'date,model,provider');
  const row = db.prepare('SELECT provider, requests FROM cost_daily WHERE date=? AND model=?').get('2026-01-01', 'm1');
  assert.strictEqual(row.provider, 'A');
  db.close();
});

test('old data is preserved (count and values) after migration', () => {
  const db = freshMem();
  db.exec(legacySchema());
  db.prepare('INSERT INTO cost_daily (date, model, requests, cost_rmb) VALUES (?, ?, ?, ?)').run('2026-01-01', 'm1', 9, 0.45);
  migrateCostDaily(db);
  const row = db.prepare('SELECT requests, cost_rmb FROM cost_daily WHERE date=? AND model=?').get('2026-01-01', 'm1');
  assert.strictEqual(row.requests, 9);
  assert.strictEqual(row.cost_rmb, 0.45);
  db.close();
});

test('cost_daily_backup exists and holds the original rows after migration', () => {
  const db = freshMem();
  db.exec(legacySchema());
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-01', 'm1', 5);
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-02', 'm2', 6);
  migrateCostDaily(db);
  const backup = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_daily_backup'").get();
  assert.ok(backup, 'cost_daily_backup must exist');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM cost_daily_backup').get().c, 2, 'backup keeps original rows');
  db.close();
});

test('different providers are recorded as separate rows', () => {
  const db = freshMem();
  db.exec(newSchema());
  const upsert = db.prepare(`INSERT INTO cost_daily (date, model, provider, requests, tokens_in, tokens_out, cost_rmb)
    VALUES (@date, @model, @provider, @requests, @tokens_in, @tokens_out, @cost_rmb)
    ON CONFLICT(date, model, provider) DO UPDATE SET
      requests = requests + @requests,
      tokens_in = tokens_in + @tokens_in,
      tokens_out = tokens_out + @tokens_out,
      cost_rmb = cost_rmb + @cost_rmb`);
  upsert.run({ date: 'd', model: 'm', provider: 'A', requests: 1, tokens_in: 10, tokens_out: 20, cost_rmb: 0.1 });
  upsert.run({ date: 'd', model: 'm', provider: 'B', requests: 1, tokens_in: 12, tokens_out: 22, cost_rmb: 0.2 });
  const rows = db.prepare('SELECT provider, requests, cost_rmb FROM cost_daily ORDER BY provider').all();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].provider, 'A');
  assert.strictEqual(rows[1].provider, 'B');
  assert.strictEqual(rows[0].cost_rmb, 0.1);
  assert.strictEqual(rows[1].cost_rmb, 0.2);
  db.close();
});

test('a failing migration does not corrupt the original table', () => {
  const db = freshMem();
  // No PK and duplicate (date, model) rows so the aggregate would collapse 2 rows into 1,
  // triggering the safety abort. The original table must remain untouched.
  db.exec(`CREATE TABLE cost_daily (
    date TEXT, model TEXT, requests INTEGER DEFAULT 1,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_rmb REAL DEFAULT 0
  );`);
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-01', 'm1', 5);
  db.prepare('INSERT INTO cost_daily (date, model, requests) VALUES (?, ?, ?)').run('2026-01-01', 'm1', 5);
  assert.throws(() => migrateCostDaily(db), /migration aborted/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM cost_daily').get().c, 2, 'original table preserved on failure');
  const leftover = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_daily_new'").get();
  assert.strictEqual(leftover, undefined, 'temporary table cleaned up on failure');
  db.close();
});

import initSqlJs, { type Database, type QueryExecResult, type SqlValue } from 'sql.js';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from '../config.js';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: Database | null = null;
let loading: Promise<Database> | null = null;
let saving: Promise<void> = Promise.resolve();
let requiresRestart = false;

async function initSQL() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function getDb(): Promise<Database> {
  if (requiresRestart) throw new Error('database_requires_restart');
  if (db) return db;
  if (loading) return loading;
  loading = loadDb();
  try { return await loading; }
  finally { loading = null; }
}

async function loadDb(): Promise<Database> {
  const sql = await initSQL();
  let database: Database;
  try {
    const buf = await readFile(config.dbPath);
    database = new sql.Database(buf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    database = new sql.Database();
  }
  const d = database;
  try {
    db = d;
    return d;
  } catch (error) {
    d.close();
    throw error;
  }
}

async function writeExclusiveFile(path: string, buffer: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  let complete = false;
  try {
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    complete = true;
  } finally {
    if (!complete) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
  }
}

async function replaceSnapshot(buffer: Buffer): Promise<void> {
  await mkdir(dirname(config.dbPath), { recursive: true });
  const temporaryPath = config.dbPath + '.' + randomUUID() + '.tmp';
  await writeExclusiveFile(temporaryPath, buffer);
  try { await rename(temporaryPath, config.dbPath); }
  catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function saveDb(): Promise<void> {
  const next = saving.then(async () => {
    if (requiresRestart) throw new Error('database_requires_restart');
    if (!db) return;
    const buffer = Buffer.from(db.export());
    await replaceSnapshot(buffer);
  });
  saving = next.catch(() => {});
  return next;
}

export interface DatabaseTransaction {
  run(sql: string, values?: SqlValue[]): void;
  query(sql: string, values?: SqlValue[]): QueryExecResult[];
  backupBeforeMigration(label: string): void;
}

export async function commitDb<Result>(operation: (transaction: DatabaseTransaction) => Result): Promise<Result> {
  const next = saving.then(async () => {
    const database = await getDb();
    const original = Buffer.from(database.export());
    const sql = await initSQL();
    const staged = new sql.Database(Uint8Array.from(original));
    const statements: Array<{ sql: string; values: SqlValue[] }> = [];
    let backupLabel: string | undefined;
    let active = true;
    const assertActive = () => { if (!active) throw new Error('closed_database_transaction'); };
    try {
      let result: Result;
      try {
        result = operation({
          run(statement, values = []) {
            assertActive();
            if (!/^\s*(?:CREATE TABLE|INSERT INTO|UPDATE)\b/i.test(statement) || statement.includes(';')) throw new Error('invalid_database_statement');
            const parameters = values.map(value => value instanceof Uint8Array ? Uint8Array.from(value) : value);
            staged.run(statement, parameters);
            statements.push({ sql: statement, values: parameters });
          },
          query(statement, values = []) {
            assertActive();
            if (!/^\s*SELECT\b/i.test(statement) || statement.includes(';')) throw new Error('invalid_database_query');
            return staged.exec(statement, values);
          },
          backupBeforeMigration(label) {
            assertActive();
            if (!/^[a-z0-9-]{1,40}$/.test(label) || (backupLabel && backupLabel !== label)) throw new Error('invalid_backup_label');
            backupLabel = label;
          },
        });
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          void Promise.resolve(result).catch(() => {});
          throw new Error('async_database_transaction');
        }
      } finally { active = false; }
      if (!statements.length) return result;
      if (backupLabel) {
        await mkdir(dirname(config.dbPath), { recursive: true });
        await writeExclusiveFile(config.dbPath + '.before-' + backupLabel + '.' + randomUUID() + '.bak', original);
      }
      await replaceSnapshot(Buffer.from(staged.export()));
      try {
        database.run('BEGIN');
        for (const statement of statements) database.run(statement.sql, statement.values);
        database.run('COMMIT');
      } catch {
        try { database.run('ROLLBACK'); } catch {}
        requiresRestart = true;
        throw new Error('database_requires_restart');
      }
      return result;
    } finally { staged.close(); }
  });
  saving = next.then(() => {}, () => {});
  return next;
}

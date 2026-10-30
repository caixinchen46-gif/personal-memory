import initSqlJs from 'sql.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { acquireDatabaseLock } from './store/lock.js';
import { readMemoryRecords } from './memory/store.js';

export async function migrateMemories(sourcePath: string, targetPath: string) {
  const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath) || canonical(sourcePath) === canonical(targetPath)) throw new Error('invalid_migration_paths');
  if (!(await lstat(sourcePath)).isFile() || (await lstat(sourcePath)).isSymbolicLink()) throw new Error('invalid_migration_source');
  const release = await acquireDatabaseLock(targetPath);
  const SQL = await initSqlJs().catch(async error => { await release(); throw error; });
  let source: import('sql.js').Database | undefined;
  let target: import('sql.js').Database | undefined;
  try {
    source = new SQL.Database(await readFile(sourcePath));
    if (!source.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_memories'").length) throw new Error('memory_source_missing');
    readMemoryRecords({ query: (sql, values) => source!.exec(sql, values) });
    let existing: Buffer | undefined;
    try {
      const metadata = await lstat(targetPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('invalid_migration_target');
      existing = await readFile(targetPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    target = new SQL.Database(existing);
    const names = target.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (names.some(result => result.values.some(row => row[0] !== 'personal_memories'))) throw new Error('memory_only_target_required');
    target.run('CREATE TABLE IF NOT EXISTS personal_memories (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)');
    readMemoryRecords({ query: (sql, values) => target!.exec(sql, values) });
    const sourceRows = source.exec('SELECT id, payload_json FROM personal_memories ORDER BY id')[0]?.values ?? [];
    const previous = new Map((target.exec('SELECT id, payload_json FROM personal_memories ORDER BY id')[0]?.values ?? []).map(row => [String(row[0]), String(row[1])]));
    let inserted = 0;
    for (const row of sourceRows) {
      const old = previous.get(String(row[0]));
      if (old !== undefined) {
        if (old !== row[1]) throw new Error('memory_migration_conflict');
        continue;
      }
      target.run('INSERT INTO personal_memories (id, payload_json) VALUES (?, ?)', row);
      inserted++;
    }
    const rows = target.exec('SELECT id, payload_json FROM personal_memories ORDER BY id')[0]?.values ?? [];
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const sourceDigest = createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex');
    if (inserted || !existing) {
      const temporary = targetPath + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(Buffer.from(target.export())); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, targetPath);
      } finally { await unlink(temporary).catch(() => {}); }
    }
    return { count: rows.length, inserted, sourceCount: sourceRows.length, digest, sourceDigest };
  } finally { source?.close(); target?.close(); await release(); }
}

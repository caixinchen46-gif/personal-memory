import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';
import type { MemoryCandidate, MemorySource } from '../src/types/interfaces.js';

const now = new Date('2026-10-28T08:00:00.000Z');
const source: MemorySource = {
  sessionId: 'chat-a', turnId: 'turn-a', messageId: 'message-a', role: 'user',
  text: '我喜欢先举例的讲解，也希望回答简洁。', observedAt: '2026-10-28T07:59:00.000Z',
};
const candidate: MemoryCandidate = {
  content: '讲解偏好是先举例。', level: 'long', kind: 'preference', scope: 'personal',
  reason: '用户明确陈述讲解偏好。', evidence: 'user_report', privacy: 'ordinary',
  source: { messageId: source.messageId, excerpt: source.text },
};
const runFile = promisify(execFile);
const mode = process.argv[2];

if (mode === '--inspect') {
  const path = resolve(process.argv[3] || '');
  if (!path.startsWith(join(tmpdir(), 'kb-memory-storage-'))) throw new Error('isolated_path_required');
  process.env.PM_DB_PATH = path;
  const { readMemories, searchMemories } = await import('../src/memory/index.js');
  const { writeService } = await import('../src/write-service.js');
  const { getDb } = await import('../src/store/metadata.js');
  const records = await readMemories();
  const context = await searchMemories({ query: '讲解偏好', scope: 'personal', now });
  const database = await getDb();
  const legacy = database.exec('SELECT content FROM legacy_probe')[0].values[0][0];
  const retry = records.length ? await writeService.commitMemory(candidate, source, { now }) : null;
  console.log('MEMORY_CHILD:' + JSON.stringify({ records, context, legacy, retry }));
  database.close();
} else {
  let passed = 0;
  let failed = 0;
  async function check(name: string, run: () => unknown | Promise<unknown>) {
    try { await run(); passed++; console.log('  ✓ ' + name); }
    catch (error) { failed++; console.error('  ✗ ' + name + ': ' + (error as Error).message); }
  }
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-storage-'));
  const realPath = resolve(import.meta.dirname, '../data/memory.db');
  const beforeReal = createHash('sha256').update(await readFile(realPath).catch(() => Buffer.alloc(0))).digest('hex');
  process.env.PM_DB_PATH = join(root, 'metadata.db');
  let database: import('sql.js').Database | undefined;
  const persistence = await import('../src/memory/index.js').catch(() => null);
  const writer = await import('../src/write-service.js').catch(() => null);
  try {
    await check('记忆读取和唯一写入 facade 可用', () => assert.ok(persistence && writer));
    if (persistence && writer) {
      const { writeService } = writer;
      const { readMemories, searchMemories } = persistence;
      await check('凭据拒绝发生在任何数据库或备份文件创建之前', async () => {
        assert.deepEqual(await writeService.commitMemory({ ...candidate, content: 'token=synthetic_987' }, source, { now }),
          { status: 'rejected', code: 'credentials' });
        assert.deepEqual(await readdir(root), []);
      });
      await check('敏感候选只有无正文待确认结果，不创建暂存文件', async () => {
        assert.deepEqual(await writeService.commitMemory({ ...candidate, privacy: 'sensitive' }, source, { now }), { status: 'needs_consent' });
        assert.deepEqual(await readdir(root), []);
      });
      const metadata = await import('../src/store/metadata.js');
      database = await metadata.getDb();
      database.run('CREATE TABLE legacy_probe (content TEXT)');
      database.run('INSERT INTO legacy_probe VALUES (?)', ['已有学习数据']);
      await metadata.saveDb();
      const oldDisk = await readFile(process.env.PM_DB_PATH!);
      await check('读取旧库不隐式创建记忆表或写回文件', async () => {
        assert.deepEqual(await readMemories(), []);
        assert.ok(oldDisk.equals(await readFile(process.env.PM_DB_PATH!)));
      });
      await writeService.initializeMemory();
      const backups = (await readdir(root)).filter(path => path.includes('.before-memory-v1.'));
      await check('首次迁移前保留可打开的独立快照且不包含新表', async () => {
        assert.equal(backups.length, 1);
        const SQL = await initSqlJs();
        const snapshot = new SQL.Database(await readFile(join(root, backups[0])));
        try {
          assert.equal(snapshot.exec('SELECT content FROM legacy_probe')[0].values[0][0], '已有学习数据');
          assert.equal(snapshot.exec("SELECT name FROM sqlite_master WHERE name='personal_memories'").length, 0);
        } finally { snapshot.close(); }
      });
      await check('重复初始化不重复备份、不切换共享连接', async () => {
        await writeService.initializeMemory();
        assert.equal((await readdir(root)).filter(path => path.includes('.before-memory-v1.')).length, 1);
        assert.equal(await metadata.getDb(), database);
      });
      const first = await writeService.commitMemory(candidate, source, { now });
      assert.equal(first.status, 'saved');
      if (first.status !== 'saved') throw new Error('fixture_not_saved');
      const firstId = first.receipt.id;
      await check('保存回执对应磁盘里的来源与记录时间', async () => {
        const SQL = await initSqlJs();
        const persisted = new SQL.Database(await readFile(process.env.PM_DB_PATH!));
        try {
          const row = persisted.exec('SELECT id, payload_json FROM personal_memories')[0].values[0];
          const record = JSON.parse(String(row[1]));
          assert.equal(row[0], firstId);
          assert.equal(record.source.sessionId, 'chat-a');
          assert.equal(record.source.messageId, 'message-a');
          assert.equal(record.recordedAt, first.receipt.recordedAt);
        } finally { persisted.close(); }
      });
      await check('同来源重试幂等，解释文案变化不增殖', async () => {
        const before = await readFile(process.env.PM_DB_PATH!);
        const retry = await writeService.commitMemory({ ...candidate, reason: '同一个偏好的另一种归类说明。' }, source,
          { now: new Date('2026-10-28T09:00:00.000Z') });
        assert.equal(retry.status, 'saved');
        if (retry.status === 'saved') {
          assert.deepEqual(retry.receipt, { id: firstId, recordedAt: first.receipt.recordedAt, duplicate: true });
        }
        assert.equal((await readMemories()).length, 1);
        assert.ok(before.equals(await readFile(process.env.PM_DB_PATH!)));
      });
      await check('同一事实不能在重试时悄悄改变层级', async () => {
        assert.deepEqual(await writeService.commitMemory({ ...candidate, level: 'medium' }, source, { now }), { status: 'rejected', code: 'conflict' });
      });
      await check('同轮可以保存不同事实，不同项目不合并', async () => {
        assert.equal((await writeService.commitMemory({ ...candidate, content: '回答偏好是简洁。' }, source, { now })).status, 'saved');
        assert.equal((await writeService.commitMemory({ ...candidate, scope: 'project:other' }, source, { now })).status, 'saved');
        assert.equal((await readMemories()).length, 3);
      });
      const revisedSource = { ...source, sessionId: 'chat-b', turnId: 'turn-b', messageId: 'message-b',
        text: '现在讲解偏好改为先讲原理。', observedAt: '2026-10-28T07:59:30.000Z' };
      const revised = { ...candidate, content: '讲解偏好改为先讲原理。', source: { messageId: revisedSource.messageId, excerpt: revisedSource.text } };
      await check('目标不存在的更正不写入新记录', async () => {
        assert.deepEqual(await writeService.commitMemory(revised, revisedSource, { now, replacesId: 'f'.repeat(64) }), { status: 'rejected', code: 'not_found' });
        assert.equal((await readMemories()).length, 3);
      });
      await check('不能更正另一个项目的记忆', async () => {
        assert.deepEqual(await writeService.commitMemory({ ...revised, scope: 'project:other' }, revisedSource, { now, replacesId: firstId }),
          { status: 'rejected', code: 'scope_mismatch' });
      });
      await check('助手猜测不能替代已有事实', async () => {
        assert.deepEqual(await writeService.commitMemory({ ...revised, level: 'medium', evidence: 'hypothesis' },
          { ...revisedSource, role: 'assistant' }, { now, replacesId: firstId }), { status: 'rejected', code: 'invalid_correction' });
      });
      await check('旧来源不能覆盖较新的事实', async () => {
        assert.deepEqual(await writeService.commitMemory(revised, { ...revisedSource, observedAt: '2026-10-27T07:59:00.000Z' }, { now, replacesId: firstId }),
          { status: 'rejected', code: 'invalid_correction' });
      });
      const correction = await writeService.commitMemory(revised, revisedSource, { now, replacesId: firstId });
      assert.equal(correction.status, 'saved');
      if (correction.status !== 'saved') throw new Error('correction_not_saved');
      await check('显式更正原子保留旧记录与双向关系', async () => {
        const records = await readMemories();
        assert.equal(records.find(record => record.id === firstId)?.supersededBy, correction.receipt.id);
        assert.equal(records.find(record => record.id === firstId)?.status, 'superseded');
        assert.equal(records.find(record => record.id === correction.receipt.id)?.supersedes, firstId);
        assert.equal(records.length, 4);
      });
      await check('更正重试仍幂等，改变目标则冲突', async () => {
        const retry = await writeService.commitMemory(revised, revisedSource, { now, replacesId: firstId });
        assert.equal(retry.status, 'saved');
        if (retry.status === 'saved') assert.equal(retry.receipt.duplicate, true);
        assert.deepEqual(await writeService.commitMemory(revised, revisedSource, { now }), { status: 'rejected', code: 'conflict' });
      });
      await check('重试旧写入不会把被更正偏好复活', async () => {
        assert.equal((await writeService.commitMemory(candidate, source, { now })).status, 'saved');
        const context = await searchMemories({ query: '讲解偏好', scope: 'personal', now });
        assert.ok(!context.items.some(record => record.id === firstId));
        assert.ok(context.items.some(record => record.id === correction.receipt.id && record.supersedes === firstId));
      });
      await check('同进程跨聊天并发写入均保留', async () => {
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) => {
          const origin = { ...source, sessionId: 'parallel-' + index };
          return writeService.commitMemory(candidate, origin, { now });
        }));
        assert.ok(results.every(result => result.status === 'saved'));
        assert.equal((await readMemories()).length, 16);
        assert.equal(database!.exec('SELECT content FROM legacy_probe')[0].values[0][0], '已有学习数据');
      });
      async function inspect(path: string) {
        const child = await runFile(process.execPath, ['--import', 'tsx', resolve(import.meta.filename), '--inspect', path], { cwd: resolve(import.meta.dirname, '..'), maxBuffer: 1048576 });
        const line = child.stdout.split(/\r?\n/).find(entry => entry.startsWith('MEMORY_CHILD:'));
        assert.ok(line);
        return JSON.parse(line.slice('MEMORY_CHILD:'.length));
      }
      await check('独立新进程可读全部已确认记忆与幂等回执', async () => {
        const result = await inspect(process.env.PM_DB_PATH!);
        assert.equal(result.records.length, 16);
        assert.equal(result.retry.status, 'saved');
        assert.equal(result.retry.receipt.id, firstId);
        assert.equal(result.retry.receipt.duplicate, true);
        assert.equal(result.legacy, '已有学习数据');
        assert.ok(!result.context.items.some((record: { id: string }) => record.id === firstId));
      });
      await check('迁移前备份可恢复旧学习数据，记忆快照可恢复完整记忆', async () => {
        const restored = join(root, 'restored');
        await mkdir(restored);
        const beforeMigration = join(restored, 'old.db');
        await copyFile(join(root, backups[0]), beforeMigration);
        const old = await inspect(beforeMigration);
        assert.deepEqual(old.records, []);
        assert.equal(old.legacy, '已有学习数据');
        const withMemory = join(restored, 'memory.db');
        await copyFile(process.env.PM_DB_PATH!, withMemory);
        const recovered = await inspect(withMemory);
        assert.equal(recovered.records.length, 16);
        assert.equal(recovered.retry.receipt.id, firstId);
      });
      await check('敏感/凭据拒绝不会进入数据库、备份或错误正文', async () => {
        const before = await readFile(process.env.PM_DB_PATH!);
        const output = await writeService.commitMemory({ ...candidate, content: 'token=synthetic_987' }, source, { now });
        assert.ok(!JSON.stringify(output).includes('synthetic_987'));
        assert.ok(before.equals(await readFile(process.env.PM_DB_PATH!)));
        for (const path of await readdir(root, { withFileTypes: true })) {
          if (path.isFile()) assert.ok(!(await readFile(join(root, path.name))).includes(Buffer.from('synthetic_987')));
        }
      });
      await check('损坏 payload 读取失败不暴露正文、不覆盖文件', async () => {
        database!.run('UPDATE personal_memories SET payload_json = ? WHERE id = ?', ['synthetic broken payload', firstId]);
        await metadata.saveDb();
        const before = await readFile(process.env.PM_DB_PATH!);
        await assert.rejects(readMemories(), (error: unknown) => error instanceof Error && error.message === 'memory_storage_unavailable' && !('cause' in error));
        assert.ok(before.equals(await readFile(process.env.PM_DB_PATH!)));
      });
    }
  } finally {
    database?.close();
    const afterReal = createHash('sha256').update(await readFile(realPath).catch(() => Buffer.alloc(0))).digest('hex');
    await check('测试前后真实数据库哈希完全一致', () => assert.equal(afterReal, beforeReal));
    await rm(root, { recursive: true, force: true });
  }
  console.log(`记忆持久化结果: ${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

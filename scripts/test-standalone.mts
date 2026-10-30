import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import initSqlJs from 'sql.js';

const temporary = await mkdtemp(join(tmpdir(), 'personal-memory-standalone-'));
const projectRoot = resolve(import.meta.dirname, '..');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let passed = 0;
let failed = 0;
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + ': ' + (error as Error).message); }
}
let child: ChildProcess | undefined;
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const running = child;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('exit_timeout')), 10000);
    running.once('exit', () => { clearTimeout(timer); done(); });
    running.kill();
  });
  child = undefined;
};
try {
  const migration = await import('../src/migration.js').catch(() => null);
  const entry = await import('../src/server.js').catch(() => null);
  await check('独立迁移模块可用', () => assert.ok(migration));
  await check('独立服务入口可用且导入时不启动服务', () => assert.ok(entry));
  if (migration && entry) {
    const SQL = await initSqlJs();
    const sourcePath = join(temporary, 'legacy.db');
    const targetPath = join(temporary, 'memory.db');
    const { validateMemoryCandidate } = await import('../src/memory/rules.js');
    const { stageMemoryCommit } = await import('../src/memory/store.js');
    const source = new SQL.Database();
    source.run('CREATE TABLE personal_memories (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)');
    source.run('CREATE TABLE chunks (content TEXT)');
    source.run("INSERT INTO chunks VALUES ('synthetic_learning_only')");
    const original = { sessionId: 'fixture-a', turnId: 'fixture-a', messageId: 'user.fixture-a', role: 'user' as const,
      text: '我希望回答先给实例。', observedAt: '2026-10-30T00:00:00.000Z' };
    const valid = validateMemoryCandidate({ content: '回答先给实例。', level: 'long', kind: 'preference', scope: 'personal',
      reason: '明确偏好', evidence: 'user_report', privacy: 'ordinary', source: { messageId: original.messageId, excerpt: original.text } },
      original, new Date('2026-10-30T00:01:00.000Z'));
    assert.equal(valid.status, 'accepted');
    if (valid.status !== 'accepted') throw new Error('fixture_invalid');
    const transaction = { query: (sql: string, values: import('sql.js').SqlValue[] = []) => source.exec(sql, values),
      run: (sql: string, values: import('sql.js').SqlValue[] = []) => { source.run(sql, values); }, backupBeforeMigration: () => {} };
    const saved = stageMemoryCommit(transaction, valid.memory);
    assert.equal(saved.status, 'saved');
    const correctedSource = { ...original, sessionId: 'fixture-correction', turnId: 'fixture-correction', messageId: 'user.fixture-correction',
      text: '更正，现在希望回答先给图示。' };
    const correction = validateMemoryCandidate({ content: '回答先给图示。', level: 'long', kind: 'preference', scope: 'personal',
      reason: '明确更正', evidence: 'user_report', privacy: 'ordinary', source: { messageId: correctedSource.messageId, excerpt: correctedSource.text } },
      correctedSource, new Date('2026-10-30T00:02:00.000Z'));
    assert.equal(correction.status, 'accepted');
    if (correction.status !== 'accepted' || saved.status !== 'saved') throw new Error('fixture_invalid');
    stageMemoryCommit(transaction, correction.memory, saved.receipt.id);
    const rows = source.exec('SELECT id, payload_json FROM personal_memories ORDER BY id')[0].values;
    await writeFile(sourcePath, Buffer.from(source.export()));
    source.close();
    const beforeSource = digest(await readFile(sourcePath));
    await check('迁移只复制记忆并完整保留 ID、来源和双向更正关系', async () => {
      const result = await migration.migrateMemories(sourcePath, targetPath);
      assert.equal(result.count, 2);
      const database = new SQL.Database(await readFile(targetPath));
      try {
        assert.deepEqual(database.exec('SELECT name FROM sqlite_master WHERE type=\'table\'')[0].values, [['personal_memories']]);
        assert.deepEqual(database.exec('SELECT id, payload_json FROM personal_memories ORDER BY id')[0].values, rows);
      } finally { database.close(); }
      assert.equal(digest(await readFile(sourcePath)), beforeSource);
    });
    await check('迁移重试幂等且不重写相同目标', async () => {
      const before = digest(await readFile(targetPath));
      assert.equal((await migration.migrateMemories(sourcePath, targetPath)).inserted, 0);
      assert.equal(digest(await readFile(targetPath)), before);
    });
    await check('拒绝同库迁移和覆盖学习数据库', async () => {
      await assert.rejects(migration.migrateMemories(sourcePath, sourcePath));
      const other = join(temporary, 'wrong-target.db');
      await writeFile(other, await readFile(sourcePath));
      await assert.rejects(migration.migrateMemories(sourcePath, other));
    });
    await check('同 ID 不同内容拒绝覆盖，目标文件保持不变', async () => {
      const conflicting = new SQL.Database(await readFile(sourcePath));
      const row = rows[0];
      const payload = JSON.parse(String(row[1]));
      payload.reason = '明确偏好；迁移冲突测试';
      conflicting.run('UPDATE personal_memories SET payload_json=? WHERE id=?', [JSON.stringify(payload), row[0]]);
      const conflictPath = join(temporary, 'conflict.db');
      await writeFile(conflictPath, Buffer.from(conflicting.export()));
      conflicting.close();
      const before = digest(await readFile(targetPath));
      await assert.rejects(migration.migrateMemories(conflictPath, targetPath), /memory_migration_conflict/);
      assert.equal(digest(await readFile(targetPath)), before);
    });
    await check('损坏记忆拒绝迁移，已保存的目标不变', async () => {
      const broken = new SQL.Database(await readFile(sourcePath));
      broken.run("UPDATE personal_memories SET payload_json='invalid'");
      const brokenPath = join(temporary, 'broken.db');
      await writeFile(brokenPath, Buffer.from(broken.export()));
      broken.close();
      const before = digest(await readFile(targetPath));
      await assert.rejects(migration.migrateMemories(brokenPath, targetPath));
      assert.equal(digest(await readFile(targetPath)), before);
    });
    const portProbe = createServer();
    await new Promise<void>(done => portProbe.listen(0, '127.0.0.1', done));
    const port = (portProbe.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(done => portProbe.close(() => done()));
    const chatRoot = join(temporary, 'chat-project');
    await mkdir(chatRoot);
    const runtime = join(temporary, 'connection.json');
    const token = 'a'.repeat(64);
    await writeFile(runtime, JSON.stringify({ version: 1, url: `http://127.0.0.1:${port}/api/memory`, token, projectRoot: chatRoot, projectRoots: [chatRoot, projectRoot] }));
    const url = `http://127.0.0.1:${port}`;
    const start = async () => {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--runtime', runtime], {
        cwd: projectRoot, windowsHide: true, stdio: 'ignore', env: { ...process.env, PM_DB_PATH: targetPath },
      });
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('standalone_start_failed');
        try { if ((await fetch(url + '/api/status', { signal: AbortSignal.timeout(700) })).ok) return; } catch {}
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error('standalone_start_timeout');
    };
    const request = async (route: string, body: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(url + '/api/memory' + route, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'standalone-a', turn_id: 'standalone-a', cwd: chatRoot,
      prompt: '我的工作偏好是先列验收标准。' };
    await check('独立服务在其他聊天目录保存，命令仍引用独立程序', async () => {
      await start();
      const health = await (await fetch(url + '/api/status')).json() as any;
      assert.equal(health.application, 'personal-memory');
      const result = await request('/events', event);
      assert.equal(result.status, 200);
      assert.ok(result.body.hookSpecificOutput.additionalContext.includes(join(projectRoot, 'scripts/memory-chat-client.mjs').replaceAll('\\', '/'))
        || result.body.hookSpecificOutput.additionalContext.includes(join(projectRoot, 'scripts/memory-chat-client.mjs')));
      const submission = await request('/submit', { turn: result.body.turn, candidates: [{ candidate: { content: '工作偏好是先列验收标准。',
        level: 'long', kind: 'preference', scope: 'personal', reason: '明确偏好', evidence: 'user_report', privacy: 'ordinary',
        source: { messageId: 'user.standalone-a', excerpt: event.prompt } } }] });
      assert.equal(submission.body.results[0].status, 'saved');
    });
    await check('认证、Origin 和未知项目拒绝，学习路由不存在', async () => {
      assert.equal((await request('/events', event, { Authorization: 'Bearer ' + 'b'.repeat(64) })).status, 403);
      assert.equal((await request('/events', event, { Origin: 'http://localhost' })).status, 403);
      assert.equal((await request('/events', { ...event, cwd: temporary })).status, 400);
      assert.equal((await fetch(url + '/api/plan')).status, 404);
      assert.equal((await fetch(url + '/api/search')).status, 404);
    });
    await check('单服务可接收两个明确允许的项目并隔离项目 scope', async () => {
      const { projectMemoryScope } = await import('../src/memory/chat-protocol.js');
      const result = await request('/events', { ...event, session_id: 'second-project', turn_id: 'second-project', cwd: projectRoot });
      assert.equal(result.status, 200);
      assert.ok(result.body.hookSpecificOutput.additionalContext.includes(projectMemoryScope(projectRoot)));
      const denied = await request('/submit', { turn: result.body.turn, candidates: [{ candidate: { content: '先列验收标准。',
        level: 'medium', kind: 'task', scope: projectMemoryScope(chatRoot), reason: '当前任务', evidence: 'user_report', privacy: 'ordinary',
        source: { messageId: 'user.second-project', excerpt: event.prompt } } }] });
      assert.equal(denied.body.results[0].code, 'scope_mismatch');
    });
    await check('服务重启后向 B 会话召回 A 的磁盘记忆', async () => {
      await stop(); await start();
      const result = await request('/events', { ...event, session_id: 'standalone-b', turn_id: 'standalone-b', prompt: '我的工作偏好是什么' });
      assert.ok(result.body.hookSpecificOutput.additionalContext.includes('先列验收标准'));
      assert.ok(result.body.hookSpecificOutput.additionalContext.includes('user.standalone-a'));
    });
    await check('同轮无回执 Stop 只阻断一次，第二次放行', async () => {
      const stopEvent = { ...event, session_id: 'standalone-b', turn_id: 'standalone-b', hook_event_name: 'Stop' };
      assert.equal((await request('/events', stopEvent)).body.decision, 'block');
      const second = (await request('/events', stopEvent)).body;
      assert.equal(second.decision, undefined);
      assert.match(second.systemMessage, /未确认/);
    });
    await check('同一数据库拒绝第二个服务和迁移器，文件不被覆盖', async () => {
      const before = digest(await readFile(targetPath));
      await assert.rejects(migration.migrateMemories(sourcePath, targetPath));
      const running = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--runtime', runtime], {
        cwd: projectRoot, windowsHide: true, stdio: 'ignore', env: { ...process.env, PM_DB_PATH: targetPath },
      });
      const exit = await new Promise<number | null>((done, reject) => {
        const timer = setTimeout(() => { running.kill(); reject(new Error('second_owner_timeout')); }, 8000);
        running.once('exit', code => { clearTimeout(timer); done(code); });
      });
      assert.notEqual(exit, 0);
      assert.equal(digest(await readFile(targetPath)), before);
    });
    await check('服务停止后 Hook 明确降级，聊天放行且记忆文件不变', async () => {
      const before = digest(await readFile(targetPath));
      await stop();
      const output = await new Promise<{ code: number | null; stdout: string }>((done, reject) => {
        const runner = spawn(process.execPath, [join(projectRoot, 'scripts/memory-chat-client.mjs'), '--runtime', runtime, 'hook'], { windowsHide: true });
        let stdout = '';
        runner.stdout.on('data', part => { stdout += part; });
        runner.once('error', reject);
        runner.once('exit', code => done({ code, stdout }));
        runner.stdin.end(JSON.stringify(event));
      });
      assert.equal(output.code, 0);
      assert.match(JSON.parse(output.stdout).systemMessage, /不可用.*聊天可以继续/);
      assert.equal(digest(await readFile(targetPath)), before);
    });
    await check('源学习数据库始终未变化', async () => assert.equal(digest(await readFile(sourcePath)), beforeSource));
  }
} finally { await stop(); await rm(temporary, { recursive: true, force: true }); }
console.log(`Standalone: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

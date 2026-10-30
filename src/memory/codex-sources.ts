import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { projectMemoryScope } from './chat-protocol.js';
import { verifiedTest } from './turn-sources.js';
import { containsCredentials, MEMORY_LIMITS } from './rules.js';
import type { ChatEvent } from './chat-protocol.js';
import type { MemorySource } from '../types/interfaces.js';

const inside = (parent: string, target: string) => {
  const difference = relative(parent, target);
  return difference !== '..' && !difference.startsWith('..' + sep) && !isAbsolute(difference);
};

async function codexBinary(projectRoot: string): Promise<string> {
  try {
    const project = await realpath(projectRoot);
    const roots = process.platform === 'win32'
      ? [await realpath(join(process.env.LOCALAPPDATA!, 'OpenAI/Codex/bin'))] : ['/usr/local', '/usr/bin', '/opt'];
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = await realpath(join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')).catch(() => null);
      if (candidate && roots.some(root => inside(root, candidate)) && !inside(project, candidate) && (await stat(candidate)).isFile()) return candidate;
    }
  } catch {}
  throw new Error('turn_source_unavailable');
}

async function testCommand(command: string, projectRoot: string): Promise<string> {
  const wrapper = command.match(/^"([^"\r\n]+[\\/](?:pwsh|powershell)\.exe)" -Command (['"])([^'"\r\n]+)\2$/i);
  if (!wrapper) return command;
  if (process.platform !== 'win32') return '';
  const allowed = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'),
  ];
  try {
    const binary = await realpath(wrapper[1]);
    if (inside(await realpath(projectRoot), binary)) return '';
    for (const path of allowed) {
      const trusted = await realpath(path).catch(() => null);
      if (trusted && trusted.toLowerCase() === binary.toLowerCase()) return wrapper[3];
    }
  } catch {}
  return '';
}

function assertThread(metadata: unknown, event: ChatEvent): void {
  const thread = (metadata as any)?.thread;
  if (!thread || thread.id !== event.sessionId || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)
    || projectMemoryScope(thread.cwd) !== projectMemoryScope(event.projectRoot)) throw new Error('turn_source_unavailable');
}

export async function parseCodexSources(metadata: unknown, rows: unknown[], event: ChatEvent, observedAt: string, now: Date): Promise<MemorySource[]> {
  assertThread(metadata, event);
  if (!Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(now.getTime())) throw new Error('turn_source_unavailable');
  const sources: MemorySource[] = [];
  const identities = new Set<string>();
  let total = 0;
  for (const row of rows as any[]) {
    if (!row || row.turnId !== event.turnId) throw new Error('turn_source_unavailable');
    const item = row.item;
    if (item?.type !== 'commandExecution') continue;
    if (typeof item.id !== 'string' || !item.id || identities.has(item.id)) throw new Error('turn_source_unavailable');
    identities.add(item.id);
    if (!['completed', 'failed'].includes(item.status) || typeof item.exitCode !== 'number' || !Number.isInteger(item.exitCode)) continue;
    const startedAtMs = item.startedAtMs ?? row.startedAtMs;
    const completedAtMs = item.completedAtMs ?? row.completedAtMs;
    const hasTiming = startedAtMs !== undefined && startedAtMs !== null || completedAtMs !== undefined && completedAtMs !== null;
    if (hasTiming && (typeof startedAtMs !== 'number' || typeof completedAtMs !== 'number'
      || !Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)
      || startedAtMs < Date.parse(observedAt) || completedAtMs < startedAtMs || completedAtMs > now.getTime())) continue;
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
      : item.output && typeof item.output.text === 'string' && item.output.truncated === false ? item.output.text : null;
    if (typeof item.cwd !== 'string' || !isAbsolute(item.cwd) || typeof item.command !== 'string' || typeof output !== 'string' || !output.trim()
      || output.length > MEMORY_LIMITS.source || containsCredentials(output)) continue;
    const command = await testCommand(item.command, event.projectRoot);
    if (!await verifiedTest('exec_command', JSON.stringify({ cmd: command, workdir: item.cwd }), 0, event.projectRoot)) continue;
    total += output.length;
    if (sources.length >= 20 || total > 24576) throw new Error('turn_source_unavailable');
    sources.push({
      sessionId: event.sessionId, turnId: event.turnId,
      messageId: 'tool.' + createHash('sha256').update(item.id).digest('hex').slice(0, 32),
      role: 'tool', text: output, observedAt: new Date(hasTiming ? completedAtMs : now.getTime()).toISOString(),
      ...(item.status === 'completed' && item.exitCode === 0 ? { verification: 'passed' as const } : {}),
    });
  }
  return sources;
}

export async function readCodexTurnSources(event: ChatEvent, observedAt: string, now: Date): Promise<MemorySource[]> {
  const child = spawn(await codexBinary(event.projectRoot), ['app-server', '--stdio'], {
    cwd: event.projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const input = new PassThrough();
  const lines = createInterface({ input });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let bytes = 0;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    for (const entry of pending.values()) entry.reject(new Error('turn_source_unavailable'));
    pending.clear();
    child.kill();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  input.on('error', fail);
  lines.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1048576) { fail(); return; }
    input.write(chunk);
  });
  child.stdout.on('end', () => input.end());
  const timer = setTimeout(fail, 4000);
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error || !message.result) entry.reject(new Error('turn_source_unavailable'));
      else entry.resolve(message.result);
    } catch { fail(); }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (failed) { reject(new Error('turn_source_unavailable')); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) fail(); });
  });
  try {
    await request('initialize', { clientInfo: { name: 'kb_current_turn_sources', title: null, version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n', error => { if (error) fail(); });
    const metadata = await request('thread/read', { threadId: event.sessionId, includeTurns: false });
    assertThread(metadata, event);
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const result = await request('thread/items/list', { threadId: event.sessionId, turnId: event.turnId, limit: 100, cursor });
      if (!Array.isArray(result.data) || result.data.length > 100 || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error();
      rows.push(...result.data);
      if (result.nextCursor === null) return await parseCodexSources(metadata, rows, event, observedAt, now);
      if (result.nextCursor === cursor) throw new Error();
      cursor = result.nextCursor;
    }
    throw new Error();
  } catch { throw new Error('turn_source_unavailable'); }
  finally { clearTimeout(timer); lines.close(); input.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.kill(); }
}

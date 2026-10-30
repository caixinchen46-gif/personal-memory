import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { MemorySource } from '../types/interfaces.js';
import type { ChatEvent } from './chat-protocol.js';
import { containsCredentials, MEMORY_LIMITS } from './rules.js';

export interface TurnAnchor {
  path: string;
  offset: number;
  inode: number;
  device: number;
  observedAt: string;
}

export async function captureTurnAnchor(path: string | undefined, now: Date): Promise<TurnAnchor | null> {
  if (!path || !isAbsolute(path) || !path.endsWith('.jsonl')) return null;
  try {
    const canonical = await realpath(path);
    const file = await open(canonical, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) return null;
      return { path: canonical, offset: metadata.size, inode: metadata.ino, device: metadata.dev, observedAt: now.toISOString() };
    } finally { await file.close(); }
  } catch { return null; }
}

function toolText(output: unknown): { text: string; exitCode?: number } | null {
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
      return { text: parsed.output, ...(typeof parsed.exit_code === 'number' ? { exitCode: parsed.exit_code } : {}) };
    }
  } catch {}
  const envelope = output.match(/^Chunk ID: [^\n]+\nWall time: [^\n]+\nProcess exited with code (\d+)\n(?:Final output|Output):\n([\s\S]*)$/);
  return envelope ? { text: envelope[2], exitCode: Number(envelope[1]) } : { text: output };
}

export async function verifiedTest(name: unknown, argumentsText: unknown, exitCode: number | undefined, projectRoot: string): Promise<boolean> {
  if (!['exec_command', 'functions.exec_command'].includes(String(name)) || typeof argumentsText !== 'string' || exitCode !== 0) return false;
  try {
    const input = JSON.parse(argumentsText);
    const command = input.cmd;
    if (typeof command !== 'string' || !/^(?:npm(?:\.cmd)? (?:test|run test:[a-zA-Z0-9_-]+)|(?:\.\\|\.\/)?node_modules[\\/]+\.bin[\\/]+tsx(?:\.cmd)? scripts[\\/]+test-[a-zA-Z0-9_-]+\.mts|node --test(?: [a-zA-Z0-9_./\\-]+)?)$/.test(command.trim())) return false;
    if (input.workdir !== undefined && (typeof input.workdir !== 'string' || !isAbsolute(input.workdir))) return false;
    const root = await realpath(resolve(projectRoot));
    const directory = await realpath(resolve(input.workdir ?? projectRoot));
    const difference = relative(root, directory);
    if (difference === '..' || difference.startsWith('..' + sep) || isAbsolute(difference)) return false;
    const explicitPath = command.trim().match(/^node --test (.+)$/)?.[1]
      ?? command.trim().match(/tsx(?:\.cmd)? (scripts[\\/]+test-[a-zA-Z0-9_-]+\.mts)$/)?.[1];
    if (explicitPath) {
      const target = await realpath(resolve(directory, explicitPath));
      const targetDifference = relative(root, target);
      if (targetDifference === '..' || targetDifference.startsWith('..' + sep) || isAbsolute(targetDifference)) return false;
    }
    return true;
  } catch { return false; }
}

export async function readTurnSources(anchor: TurnAnchor, event: ChatEvent, now: Date): Promise<MemorySource[]> {
  try {
    const file = await open(anchor.path, 'r');
    let text: string;
    try {
      const metadata = await file.stat();
      const length = metadata.size - anchor.offset;
      if (!metadata.isFile() || metadata.ino !== anchor.inode || metadata.dev !== anchor.device || length < 0 || length > 1048576) throw new Error();
      const bytes = Buffer.alloc(length);
      let count = 0;
      while (count < length) {
        const result = await file.read(bytes, count, length - count, anchor.offset + count);
        if (!result.bytesRead) throw new Error();
        count += result.bytesRead;
      }
      text = bytes.toString('utf8');
    } finally { await file.close(); }
    const sources: MemorySource[] = [];
    const calls = new Map<string, { name: unknown; arguments: unknown }>();
    const completed = new Set<string>();
    let boundToTurn = false;
    let total = 0;
    for (const line of text.split('\n').slice(0, -1)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(anchor.observedAt) || timestamp > now.getTime()) throw new Error();
      const payload = row.payload;
      if (!payload || typeof payload !== 'object') continue;
      if ((row.type === 'event_msg' && payload.type === 'task_started') || row.type === 'turn_context') {
        if (payload.turn_id && payload.turn_id !== event.turnId) throw new Error();
        if (payload.session_id && payload.session_id !== event.sessionId) throw new Error();
        if (payload.turn_id === event.turnId) boundToTurn = true;
      }
      if (row.type !== 'response_item') continue;
      if (!boundToTurn) throw new Error();
      if (payload.type === 'function_call' && typeof payload.call_id === 'string') {
        calls.set(payload.call_id, { name: payload.name, arguments: payload.arguments });
      }
      if (payload.type !== 'function_call_output' || typeof payload.call_id !== 'string') continue;
      const call = calls.get(payload.call_id);
      if (!call) continue;
      if (completed.has(payload.call_id)) throw new Error();
      completed.add(payload.call_id);
      if (typeof call.arguments === 'string' && call.arguments.includes('memory-chat-client.mjs')) continue;
      const output = toolText(payload.output);
      if (!output || !output.text.trim() || output.text.length > MEMORY_LIMITS.source || containsCredentials(output.text)) continue;
      total += output.text.length;
      if (sources.length >= 20 || total > 24576) throw new Error();
      sources.push({
        sessionId: event.sessionId, turnId: event.turnId,
        messageId: 'tool.' + createHash('sha256').update(payload.call_id).digest('hex').slice(0, 32),
        role: 'tool', text: output.text, observedAt: new Date(timestamp).toISOString(),
        ...(await verifiedTest(call.name, call.arguments, output.exitCode, event.projectRoot) ? { verification: 'passed' as const } : {}),
      });
    }
    if (!boundToTurn) throw new Error();
    return sources;
  } catch { throw new Error('turn_source_unavailable'); }
}

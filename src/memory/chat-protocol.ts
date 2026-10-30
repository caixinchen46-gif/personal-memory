import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { MEMORY_LIMITS } from './rules.js';
import type { MemoryQuery } from '../types/interfaces.js';

export interface ChatEvent {
  event: 'UserPromptSubmit' | 'Stop';
  sessionId: string;
  turnId: string;
  prompt?: string;
  transcriptPath?: string;
  stopHookActive: boolean;
  projectRoot: string;
}

export function parseChatEvent(value: unknown, projectRoot: string): ChatEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!['UserPromptSubmit', 'Stop'].includes(String(input.hook_event_name))
    || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || projectMemoryScope(input.cwd) !== projectMemoryScope(projectRoot)) return null;
  for (const field of ['session_id', 'turn_id']) {
    if (typeof input[field] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input[field])) return null;
  }
  if (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== 'boolean') return null;
  if (input.hook_event_name === 'UserPromptSubmit'
    && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MEMORY_LIMITS.source)) return null;
  return {
    event: input.hook_event_name as ChatEvent['event'], sessionId: input.session_id as string,
    turnId: input.turn_id as string, stopHookActive: input.stop_hook_active === true, projectRoot: resolve(projectRoot),
    ...(input.hook_event_name === 'UserPromptSubmit' ? { prompt: input.prompt as string } : {}),
    ...(typeof input.transcript_path === 'string' ? { transcriptPath: input.transcript_path } : {}),
  };
}

export function userMessageId(turnId: string): string {
  return 'user.' + (turnId.length <= 123 ? turnId : createHash('sha256').update(turnId).digest('hex').slice(0, 32));
}

export function projectMemoryScope(projectRoot: string): string {
  const root = resolve(projectRoot);
  return 'project:' + createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
}

export function chatQuery(prompt: string, projectRoot: string, now: Date): MemoryQuery {
  const query = prompt.trim().slice(0, MEMORY_LIMITS.query);
  const request: MemoryQuery = {
    query, scope: projectMemoryScope(projectRoot), now,
    includeHistory: /昨天|前天|历史|之前|上次|以前|曾经|那天|yesterday|last time|history/i.test(prompt),
  };
  const daysAgo = /前天/.test(prompt) ? 2 : /昨天|\byesterday\b/i.test(prompt) ? 1 : 0;
  if (daysAgo && !(/前天/.test(prompt) && /昨天/.test(prompt))) {
    const today = Math.floor((now.getTime() + 28800000) / 86400000) * 86400000 - 28800000;
    request.occurredFrom = new Date(today - daysAgo * 86400000).toISOString();
    request.occurredTo = new Date(today - (daysAgo - 1) * 86400000).toISOString();
  }
  return request;
}

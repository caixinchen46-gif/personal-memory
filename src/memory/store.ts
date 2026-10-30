import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '../store/metadata.js';
import type { MemoryDraft, MemoryRecord, MemoryWriteResult } from '../types/interfaces.js';
import { isMemoryRecord, validateMemoryCandidate } from './rules.js';

type MemoryReader = Pick<DatabaseTransaction, 'query'>;

function hasSchema(reader: MemoryReader): boolean {
  return reader.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_memories'").length > 0;
}

export function ensureMemorySchema(transaction: DatabaseTransaction): void {
  if (hasSchema(transaction)) return;
  transaction.backupBeforeMigration('memory-v1');
  transaction.run('CREATE TABLE personal_memories (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)');
}

function memoryId(memory: MemoryDraft): string {
  return createHash('sha256').update(JSON.stringify([
    memory.source.sessionId, memory.source.turnId, memory.source.messageId,
    memory.scope, memory.kind, memory.content,
  ])).digest('hex');
}

export function readMemoryRecords(reader: MemoryReader): MemoryRecord[] {
  if (!hasSchema(reader)) return [];
  const result = reader.query('SELECT id, payload_json FROM personal_memories ORDER BY id');
  if (!result.length) return [];
  return result[0].values.map(row => {
    const value: unknown = JSON.parse(String(row[1]));
    if (!isMemoryRecord(value) || value.id !== row[0] || memoryId(value) !== value.id) throw new Error('invalid_memory_record');
    const normalized = validateMemoryCandidate({
      content: value.content, level: value.level, kind: value.kind, scope: value.scope, reason: value.reason,
      evidence: value.evidence, privacy: 'ordinary', occurredAt: value.occurredAt,
      source: { messageId: value.source.messageId, excerpt: value.source.excerpt },
    }, { ...value.source, text: value.source.excerpt }, new Date(value.recordedAt));
    if (normalized.status !== 'accepted') throw new Error('invalid_memory_record');
    return {
      ...normalized.memory, id: value.id, status: value.status,
      ...(value.supersededBy ? { supersededBy: value.supersededBy } : {}),
      ...(value.supersedes ? { supersedes: value.supersedes } : {}),
    };
  });
}

function commitIdentity(memory: MemoryDraft, replacesId?: string): string {
  return JSON.stringify([
    memory.level, memory.evidence, memory.occurredAt, memory.expiresAt,
    memory.source.role, memory.source.observedAt, memory.source.verification, replacesId,
  ]);
}

export function stageMemoryCommit(transaction: DatabaseTransaction, memory: MemoryDraft, replacesId?: string): MemoryWriteResult {
  const records = readMemoryRecords(transaction);
  const id = memoryId(memory);
  const existing = records.find(record => record.id === id);
  if (existing) {
    if (commitIdentity(existing, existing.supersedes) !== commitIdentity(memory, replacesId)) return { status: 'rejected', code: 'conflict' };
    return { status: 'saved', receipt: {
      id: existing.id, recordedAt: existing.recordedAt, duplicate: true,
      ...(existing.supersedes ? { supersedes: existing.supersedes } : {}),
    } };
  }
  const previous = replacesId ? records.find(record => record.id === replacesId) : undefined;
  if (replacesId) {
    if (!previous) return { status: 'rejected', code: 'not_found' };
    if (previous.scope !== memory.scope || previous.kind !== memory.kind) return { status: 'rejected', code: 'scope_mismatch' };
    if (previous.status !== 'active') return { status: 'rejected', code: 'conflict' };
    if (memory.evidence === 'hypothesis' || Date.parse(memory.source.observedAt) < Date.parse(previous.source.observedAt)) {
      return { status: 'rejected', code: 'invalid_correction' };
    }
  }
  ensureMemorySchema(transaction);
  const record: MemoryRecord = { ...memory, id, status: 'active', ...(replacesId ? { supersedes: replacesId } : {}) };
  transaction.run('INSERT INTO personal_memories (id, payload_json) VALUES (?, ?)', [id, JSON.stringify(record)]);
  if (previous) {
    transaction.run('UPDATE personal_memories SET payload_json = ? WHERE id = ?', [
      JSON.stringify({ ...previous, status: 'superseded', supersededBy: id }), previous.id,
    ]);
  }
  return { status: 'saved', receipt: { id, recordedAt: memory.recordedAt, duplicate: false, ...(replacesId ? { supersedes: replacesId } : {}) } };
}

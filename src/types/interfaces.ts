
// ═══ 基础类型 ═══

export type MemoryLevel = 'short' | 'medium' | 'long';
export type MemoryKind = 'event' | 'identity' | 'preference' | 'agreement' | 'task' | 'lesson';
export type MemoryEvidence = 'hypothesis' | 'user_report' | 'verified';
export type MemoryState = 'active' | 'historical' | 'closed' | 'superseded';

export interface MemorySource {
  sessionId: string;
  turnId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  observedAt: string;
  verification?: 'passed';
}

export interface MemoryCandidate {
  content: string;
  level: MemoryLevel;
  kind: MemoryKind;
  scope: string;
  reason: string;
  evidence: MemoryEvidence;
  privacy: 'ordinary' | 'sensitive' | 'credentials';
  source: { messageId: string; excerpt: string };
  occurredAt?: string;
}

export interface MemoryDraft {
  content: string;
  level: MemoryLevel;
  kind: MemoryKind;
  scope: string;
  reason: string;
  evidence: MemoryEvidence;
  source: Omit<MemorySource, 'text'> & { excerpt: string };
  recordedAt: string;
  occurredAt?: string;
  expiresAt?: string;
}

export type MemoryValidation =
  | { status: 'accepted'; memory: MemoryDraft }
  | { status: 'needs_consent' }
  | { status: 'rejected'; code: 'invalid_candidate' | 'invalid_source' | 'credentials' | 'evidence' | 'lifetime' };

export interface MemoryRecord extends MemoryDraft {
  id: string;
  status: 'active' | 'closed' | 'superseded';
  supersededBy?: string;
  supersedes?: string;
}

export interface MemoryCommitOptions {
  now: Date;
  replacesId?: string;
}

export interface MemoryReceipt {
  id: string;
  recordedAt: string;
  duplicate: boolean;
  supersedes?: string;
}

export type MemoryWriteResult = Exclude<MemoryValidation, { status: 'accepted' }>
  | { status: 'saved'; receipt: MemoryReceipt }
  | { status: 'rejected'; code: 'conflict' | 'not_found' | 'scope_mismatch' | 'invalid_correction' };

export interface MemoryQuery {
  query: string;
  scope: string;
  now: Date;
  includeHistory?: boolean;
  occurredFrom?: string;
  occurredTo?: string;
}

export interface MemoryContextItem extends MemoryRecord {
  state: MemoryState;
}

export interface MemoryContext {
  items: MemoryContextItem[];
  context: string;
}

export type ChunkId = string;
export type DocId = string;

export interface Chunk {
  id: ChunkId;
  docId: DocId;
  parentId?: ChunkId;       // parent-child: 小chunk的父chunk
  content: string;
  contentHash: string;       // SHA256, 去重用
  position: number;          // 在文档中的序号
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  docTitle?: string;
  pageNumber?: number;
  section?: string;
  heading?: string;
  tokenCount: number;
  isParent: boolean;         // true = 大块上下文, false = 小块检索
}

export interface VectorizedChunk extends Chunk {
  embedding: number[];
  modelName: string;
  dimensions: number;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;             // [0,1] 归一化
  source: 'bm25' | 'vector' | 'hybrid';
}

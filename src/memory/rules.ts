import type { MemoryCandidate, MemoryDraft, MemoryQuery, MemoryRecord, MemorySource, MemoryState, MemoryValidation } from '../types/interfaces.js';

export const MEMORY_LIMITS = {
  content: 1600,
  reason: 400,
  scope: 128,
  identifier: 128,
  excerpt: 800,
  source: 65536,
  query: 512,
  results: 5,
  context: 6000,
} as const;

const DAY_MS = 86400000;
const SHANGHAI_OFFSET_MS = 8 * 3600000;
const levels = ['short', 'medium', 'long'];
const kinds = ['event', 'identity', 'preference', 'agreement', 'task', 'lesson'];
const evidenceTypes = ['hypothesis', 'user_report', 'verified'];

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MEMORY_LIMITS.identifier && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
}

function scopeValue(value: unknown): value is string {
  return textValue(value, MEMORY_LIMITS.scope) && value.trim() === value && !/[\r\n\t]/.test(value);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(timestamp).toISOString() === canonical ? timestamp : undefined;
}

export function containsCredentials(text: string): boolean {
  return /(?:password|passwd|pwd|token|api[_ -]?key|secret|authorization|密码|口令|密钥|令牌|验证码|动态码|一次性密码)["']?\s*(?:是|为|[:：=])/i.test(text)
    || /(?:验证码|动态码|OTP)\s*(?:是|为|[:：=])?\s*\d{4,10}/i.test(text)
    || /\bBearer\s+\S+/i.test(text)
    || /\b(?:sk-(?:proj-)?[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{15,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)
    || /https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(text);
}

function containsSensitiveData(text: string): boolean {
  return /病史|确诊|诊断为|患有|服用|抑郁|焦虑症|糖尿病|血糖|血压|发烧|怀孕|处方|身份证(?:号)?|银行卡(?:号)?|信用卡|我的收入|月薪|年薪|工资是|存款|负债|贷款余额|medical history|diagnosed|my (?:salary|income|diagnosis|bank account)/i.test(text);
}

export function validateMemoryCandidate(candidate: unknown, source: MemorySource, now: Date): MemoryValidation {
  if (!objectValue(candidate)
    || !textValue(candidate.content, MEMORY_LIMITS.content)
    || !textValue(candidate.reason, MEMORY_LIMITS.reason)
    || !scopeValue(candidate.scope)
    || typeof candidate.level !== 'string' || !levels.includes(candidate.level)
    || typeof candidate.kind !== 'string' || !kinds.includes(candidate.kind)
    || typeof candidate.evidence !== 'string' || !evidenceTypes.includes(candidate.evidence)
    || typeof candidate.privacy !== 'string' || !['ordinary', 'sensitive', 'credentials'].includes(candidate.privacy)
    || !objectValue(candidate.source)
    || !textValue(candidate.source.excerpt, MEMORY_LIMITS.excerpt)
    || !identifier(candidate.source.messageId)) {
    return { status: 'rejected', code: 'invalid_candidate' };
  }
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  const observedMs = source && instant(source.observedAt);
  if (!Number.isFinite(nowMs) || !source
    || !identifier(source.sessionId) || !identifier(source.turnId) || !identifier(source.messageId)
    || !['user', 'assistant', 'tool'].includes(source.role)
    || (source.verification !== undefined && (source.role !== 'tool' || source.verification !== 'passed'))
    || !textValue(source.text, MEMORY_LIMITS.source)
    || observedMs === undefined || observedMs > nowMs
    || candidate.source.messageId !== source.messageId || !source.text.includes(candidate.source.excerpt)) {
    return { status: 'rejected', code: 'invalid_source' };
  }
  const fields = [candidate.content, candidate.reason, candidate.scope, candidate.source.excerpt, source.text,
    source.sessionId, source.turnId, source.messageId];
  if (candidate.privacy === 'credentials' || fields.some(containsCredentials)) return { status: 'rejected', code: 'credentials' };
  if (candidate.privacy === 'sensitive' || fields.some(containsSensitiveData)) return { status: 'needs_consent' };
  const occurredMs = candidate.occurredAt === undefined ? undefined : instant(candidate.occurredAt);
  if (candidate.occurredAt !== undefined && (occurredMs === undefined || occurredMs > observedMs)) {
    return { status: 'rejected', code: 'invalid_candidate' };
  }
  if ((candidate.evidence === 'user_report' && source.role !== 'user')
    || (candidate.evidence === 'verified' && (source.role !== 'tool' || source.verification !== 'passed'))
    || (candidate.level === 'long' && candidate.evidence === 'hypothesis')
    || (candidate.level === 'long' && candidate.kind === 'lesson' && candidate.evidence !== 'verified')
    || (candidate.level === 'long' && candidate.kind !== 'lesson' && candidate.evidence !== 'user_report')) {
    return { status: 'rejected', code: 'evidence' };
  }
  if ((candidate.kind === 'event' && candidate.level !== 'short')
    || (candidate.kind === 'task' && candidate.level !== 'medium')
    || (candidate.level === 'short' && candidate.kind !== 'event')) {
    return { status: 'rejected', code: 'lifetime' };
  }
  const typed = candidate as unknown as MemoryCandidate;
  const memory: MemoryDraft = {
    content: typed.content.trim(), level: typed.level, kind: typed.kind, scope: typed.scope,
    reason: typed.reason.trim(), evidence: typed.evidence,
    source: {
      sessionId: source.sessionId, turnId: source.turnId, messageId: source.messageId,
      role: source.role, excerpt: typed.source.excerpt, observedAt: new Date(observedMs).toISOString(),
      ...(source.role === 'tool' && source.verification === 'passed' ? { verification: 'passed' as const } : {}),
    },
    recordedAt: now.toISOString(),
  };
  if (occurredMs !== undefined) memory.occurredAt = new Date(occurredMs).toISOString();
  if (typed.level === 'short') {
    const eventMs = occurredMs ?? observedMs;
    const expiry = (Math.floor((eventMs + SHANGHAI_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - SHANGHAI_OFFSET_MS;
    memory.expiresAt = new Date(expiry).toISOString();
  }
  return { status: 'accepted', memory };
}

export function memoryState(record: MemoryRecord, now: Date): MemoryState {
  if (record.status !== 'active') return record.status;
  if (record.level === 'short' && record.expiresAt && now.getTime() >= Date.parse(record.expiresAt)) return 'historical';
  return 'active';
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!objectValue(value)) return false;
  const record = value as unknown as MemoryRecord;
  if (!objectValue(record) || !identifier(record.id) || !objectValue(record.source)
    || !['active', 'closed', 'superseded'].includes(record.status)
    || !textValue(record.source.excerpt, MEMORY_LIMITS.excerpt)
    || instant(record.recordedAt) === undefined
    || (record.supersededBy !== undefined && !identifier(record.supersededBy))
    || (record.supersedes !== undefined && (!identifier(record.supersedes) || record.supersedes === record.id))
    || containsCredentials(record.id) || (record.supersededBy !== undefined && containsCredentials(record.supersededBy))
    || (record.supersedes !== undefined && containsCredentials(record.supersedes))
    || (record.status === 'superseded' && (!record.supersededBy || record.supersededBy === record.id))) return false;
  const result = validateMemoryCandidate({
    content: record.content, level: record.level, kind: record.kind, scope: record.scope,
    reason: record.reason, evidence: record.evidence, privacy: 'ordinary', occurredAt: record.occurredAt,
    source: { messageId: record.source.messageId, excerpt: record.source.excerpt },
  }, { ...record.source, text: record.source.excerpt }, new Date(record.recordedAt));
  return result.status === 'accepted' && result.memory.expiresAt === record.expiresAt;
}

export function eligibleMemories(records: readonly MemoryRecord[], request: MemoryQuery): MemoryRecord[] {
  const nowMs = request?.now instanceof Date ? request.now.getTime() : NaN;
  const fromMs = request?.occurredFrom === undefined ? undefined : instant(request.occurredFrom);
  const toMs = request?.occurredTo === undefined ? undefined : instant(request.occurredTo);
  if (!request || !textValue(request.query, MEMORY_LIMITS.query) || !scopeValue(request.scope)
    || !Number.isFinite(nowMs) || (request.includeHistory !== undefined && typeof request.includeHistory !== 'boolean')
    || (request.occurredFrom !== undefined && fromMs === undefined)
    || (request.occurredTo !== undefined && toMs === undefined)
    || (fromMs !== undefined && toMs !== undefined && fromMs >= toMs)
    || (!request.includeHistory && (fromMs !== undefined || toMs !== undefined))) throw new Error('invalid_memory_query');
  if (containsCredentials(request.query)) return [];
  return records.filter(record => {
    if (!isMemoryRecord(record)) return false;
    if (record.scope !== 'personal' && record.scope !== request.scope) return false;
    if (Date.parse(record.recordedAt) > nowMs) return false;
    if (!request.includeHistory && memoryState(record, request.now) !== 'active') return false;
    const eventMs = Date.parse(record.occurredAt ?? record.source.observedAt);
    return eventMs <= nowMs && (fromMs === undefined || eventMs >= fromMs) && (toMs === undefined || eventMs < toMs);
  });
}

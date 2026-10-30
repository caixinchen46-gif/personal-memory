import { commitDb } from './store/metadata.js';
import { ensureMemorySchema, stageMemoryCommit } from './memory/store.js';
import { validateMemoryCandidate } from './memory/rules.js';
import type { MemoryCommitOptions, MemorySource, MemoryWriteResult } from './types/interfaces.js';

export class MemoryStorageError extends Error {
  constructor() {
    super('memory_storage_unavailable');
    this.name = 'MemoryStorageError';
  }
}

export const writeService = {
  async initializeMemory(): Promise<void> {
    try { await commitDb(ensureMemorySchema); }
    catch { throw new MemoryStorageError(); }
  },

  async commitMemory(candidate: unknown, source: MemorySource, options: MemoryCommitOptions): Promise<MemoryWriteResult> {
    const validation = validateMemoryCandidate(candidate, source, options?.now);
    if (validation.status !== 'accepted') return validation;
    const replacesId = options.replacesId;
    if (replacesId !== undefined && (typeof replacesId !== 'string' || !/^[a-f0-9]{64}$/.test(replacesId))) {
      return { status: 'rejected', code: 'invalid_correction' };
    }
    try { return await commitDb(transaction => stageMemoryCommit(transaction, validation.memory, replacesId)); }
    catch { throw new MemoryStorageError(); }
  },
};

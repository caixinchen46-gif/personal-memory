import { getDb } from '../store/metadata.js';
import { writeService, MemoryStorageError } from '../write-service.js';
import { readMemoryRecords } from './store.js';
import { retrieveMemories } from './retrieval.js';
import type { MemoryContext, MemoryQuery, MemoryRecord } from '../types/interfaces.js';

export async function ensureSchema(): Promise<void> {
  await writeService.initializeMemory();
}

export async function readMemories(): Promise<MemoryRecord[]> {
  try {
    const database = await getDb();
    return readMemoryRecords({ query: (statement, values) => database.exec(statement, values) });
  } catch { throw new MemoryStorageError(); }
}

export async function searchMemories(request: MemoryQuery): Promise<MemoryContext> {
  return retrieveMemories(await readMemories(), request);
}

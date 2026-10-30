import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Windows named pipes are owned by the process and released by the OS even on a crash.
export async function acquireDatabaseLock(databasePath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(databasePath), { recursive: true });
  const directory = await realpath(dirname(databasePath));
  const canonical = resolve(directory, basename(databasePath));
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\personal-memory-' + key : join(tmpdir(), 'personal-memory-' + key + '.sock');
  const owner = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((done, reject) => {
      owner.once('error', reject);
      owner.listen(endpoint, () => { owner.removeListener('error', reject); done(); });
    });
  } catch { throw new Error('memory_database_in_use'); }
  owner.unref();
  return () => new Promise<void>((done, reject) => owner.close(error => error ? reject(error) : done()));
}

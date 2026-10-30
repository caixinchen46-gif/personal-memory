import express from 'express';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { acquireDatabaseLock } from './store/lock.js';
import { ensureSchema, readMemories } from './memory/index.js';
import { createMemoryRouter } from './memory/chat-router.js';
import { readConnection } from '../scripts/memory-chat-client.mjs';

export async function startMemoryService(runtimePath: string) {
  const connection = await readConnection(runtimePath);
  const address = new URL(connection.url);
  const metadata = await lstat(config.dbPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error('invalid_memory_database');
  const release = await acquireDatabaseLock(config.dbPath);
  try {
    await ensureSchema();
    const app = express();
    app.disable('x-powered-by');
    app.get('/api/status', async (_request, response) => {
      try { response.setHeader('Cache-Control', 'no-store'); response.json({ application: 'personal-memory', status: 'ready', memoryCount: (await readMemories()).length }); }
      catch { response.status(503).json({ status: 'unavailable' }); }
    });
    app.use('/api/memory', createMemoryRouter({ token: connection.token, projectRoot: connection.projectRoot,
      projectRoots: connection.projectRoots, runtimePath, authority: () => address.host }));
    const server = await new Promise<import('node:http').Server>((done, reject) => {
      const listening = app.listen(Number(address.port), '127.0.0.1', () => done(listening));
      listening.once('error', reject);
    });
    return { close: async () => {
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await release();
    } };
  } catch (error) { await release(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--runtime')) throw new Error('invalid_arguments');
    const runtime = args[1] ? resolve(args[1]) : process.env.PM_RUNTIME_CONFIG || resolve(config.root, 'data/runtime/connection.json');
    const service = await startMemoryService(runtime);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void service.close().then(() => process.exit(0), () => process.exit(1));
    });
    console.log('personal-memory ready');
  } catch { console.error('personal-memory startup failed'); process.exitCode = 1; }
}

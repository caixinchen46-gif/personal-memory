import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function validateConnection(value) {
  if (!value || value.version !== 1 || typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/api\/memory$/.test(value.url)
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.projectRoot !== 'string'
    || !isAbsolute(value.projectRoot) || /[\u0000-\u001f\u007f]/.test(value.projectRoot)) throw new Error('invalid_memory_connection');
  try {
    const url = new URL(value.url);
    const port = Number(value.url.match(/^http:\/\/127\.0\.0\.1:(\d+)\//)[1]);
    if (port < 1 || port > 65535 || url.hostname !== '127.0.0.1') throw new Error();
  } catch { throw new Error('invalid_memory_connection'); }
  if (value.projectRoots !== undefined && (!Array.isArray(value.projectRoots) || !value.projectRoots.length || value.projectRoots.length > 8
    || value.projectRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)))) throw new Error('invalid_memory_connection');
  return { version: 1, url: value.url, token: value.token, projectRoot: value.projectRoot,
    ...(value.projectRoots ? { projectRoots: value.projectRoots } : {}) };
}

export async function readConnection(path) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8192) throw new Error();
    return validateConnection(JSON.parse(await readFile(path, 'utf8')));
  } catch { throw new Error('invalid_memory_connection'); }
}

async function readBounded(input, maximum) {
  const chunks = [];
  let size = 0;
  for await (const part of input) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > maximum) throw new Error();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function callMemory(connection, route, body, fetcher = fetch) {
  validateConnection(connection);
  if (!['/events', '/sources', '/submit'].includes(route)) throw new Error('invalid_memory_request');
  try {
    const input = JSON.stringify(body);
    if (Buffer.byteLength(input) > 131072) throw new Error();
    const response = await fetcher(connection.url + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: input,
    });
    if (!response.ok || !response.body) throw new Error();
    const result = JSON.parse(await readBounded(response.body, 131072));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Error('memory_unavailable'); }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const mode = argumentsList[2];
  try {
    if (argumentsList[0] !== '--runtime' || !['hook', 'sources', 'submit'].includes(mode)
      || (mode === 'hook' ? argumentsList.length !== 3 : argumentsList.length !== 5 || argumentsList[3] !== '--turn' || !/^[a-f0-9]{64}$/.test(argumentsList[4]))) throw new Error();
    const connection = await readConnection(argumentsList[1]);
    const body = mode === 'sources' ? { turn: argumentsList[4] } : JSON.parse(await readBounded(process.stdin, 131072));
    const result = await callMemory(connection, mode === 'hook' ? '/events' : '/' + mode,
      mode === 'submit' ? { ...body, turn: argumentsList[4] } : body);
    if (mode === 'hook') {
      const output = result.hookSpecificOutput ? { hookSpecificOutput: result.hookSpecificOutput }
        : result.decision === 'block' && typeof result.reason === 'string' ? { decision: 'block', reason: result.reason }
          : typeof result.systemMessage === 'string' ? { systemMessage: result.systemMessage } : {};
      process.stdout.write(JSON.stringify(output) + '\n');
    } else process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(mode === 'hook'
      ? { systemMessage: '记忆服务不可用，本轮未确认保存或检索；聊天可以继续。' }
      : { status: 'unavailable', error: 'memory_unavailable' }) + '\n');
    if (mode !== 'hook') process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

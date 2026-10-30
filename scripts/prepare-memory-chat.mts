import { mkdir, lstat, open, unlink, rmdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function buildMemoryChatConfig(nodePath: string, runnerPath: string, runtimePath: string) {
  const quote = (value: string): string => {
    if (!isAbsolute(value) || /[\u0000-\u001f\u007f"&|<>^%!;$`]/.test(value)) throw new Error('unsafe-command-path');
    return `"${value}"`;
  };
  const command = `${quote(nodePath)} ${quote(runnerPath)} --runtime ${quote(runtimePath)} hook`;
  const windowsQuote = (value: string) => quote(value.replace(/(\\+)$/, '$1$1'));
  const handler = { hooks: [{
    type: 'command', command, timeout: 10,
    ...(process.platform === 'win32' ? {
      commandWindows: 'powershell.exe -NoProfile -NonInteractive -EncodedCommand '
        + Buffer.from(`& ${quote(nodePath)} --% ${windowsQuote(runnerPath)} --runtime ${windowsQuote(runtimePath)} hook`, 'utf16le').toString('base64'),
    } : {}),
  }] };
  return {
    description: '项目个人记忆：读取启用后当前轮次，检索限量记忆；本机服务保存候选。需要客户端审阅信任；不扫描或导入旧聊天。',
    hooks: { UserPromptSubmit: [handler], Stop: [handler] },
  };
}

export async function prepareMemoryChat(directory: string, port: number, projectRoot: string) {
  if (!isAbsolute(directory) || !isAbsolute(projectRoot) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_memory_configuration');
  const runtimePath = join(directory, 'connection.json');
  const previewPath = join(directory, 'memory-hooks.preview.json');
  const preview = buildMemoryChatConfig(process.execPath, resolve(import.meta.dirname, 'memory-chat-client.mjs'), runtimePath);
  for (const path of [runtimePath, previewPath]) {
    try { await lstat(path); throw new Error('memory_configuration_exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await mkdir(resolve(directory, '..'), { recursive: true });
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('memory_configuration_exists');
    throw error;
  }
  const ownedFiles: string[] = [];
  try {
    if (process.platform === 'win32') {
      const run = promisify(execFile);
      const identity = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = identity.stdout.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
      if (!sid) throw new Error('memory_permissions_unavailable');
      await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
    }
    const connection = { version: 1, url: `http://127.0.0.1:${port}/api/memory`, token: randomBytes(32).toString('hex'), projectRoot: resolve(projectRoot) };
    for (const [path, value] of [[runtimePath, connection], [previewPath, preview]] as const) {
      const file = await open(path, 'wx', 0o600);
      ownedFiles.push(path);
      try { await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
    }
    return { installed: false, runtimePath, previewPath };
  } catch (error) {
    for (const path of ownedFiles.reverse()) await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length !== 4 || argumentsList[0] !== '--runtime-dir' || argumentsList[2] !== '--port') throw new Error('invalid_memory_configuration');
  const result = await prepareMemoryChat(resolve(argumentsList[1]), Number(argumentsList[3]), resolve(import.meta.dirname, '..'));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); }
  catch { process.stdout.write(JSON.stringify({ installed: false, error: 'memory_preparation_failed' }) + '\n'); process.exitCode = 1; }
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateMemories } from '../src/migration.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--target') throw new Error('invalid_arguments');
    console.log(JSON.stringify(await migrateMemories(resolve(args[1]), resolve(args[3]))));
  } catch { console.error('memory migration failed; no success receipt'); process.exitCode = 1; }
}

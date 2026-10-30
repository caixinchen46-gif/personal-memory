import { resolve } from 'node:path';

export const config = {
  root: resolve(import.meta.dirname, '..'),
  dbPath: process.env.PM_DB_PATH || resolve(import.meta.dirname, '../data/memory.db'),
};

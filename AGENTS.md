# Personal Memory

- Scope: local personal memory, retrieval, source validation, corrections and chat integration.
- TypeScript strict, ESM imports with .js suffixes; UTF-8 without BOM and LF.
- Run npm run check and npm test before reporting changes complete.
- Tests must set PM_DB_PATH to a temporary database before importing persistence modules.
- Preserve existing memory IDs, sources, scope, timestamps and correction relationships during migrations.
- One service owns each sql.js database. Do not open the same database with multiple writers.
- Never commit data/, .codex/, connection credentials, real memories or private chat transcripts.
- Synthetic tests do not prove desktop Hook behavior. Document actual validation limits.

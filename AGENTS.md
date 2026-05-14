## Cursor Cloud specific instructions

This is a TypeScript CLI orchestrator (no web server, no database, no Docker). All commands are documented in `CLAUDE.md` and `package.json` scripts.

### Quick reference

| Action | Command |
|--------|---------|
| Install deps | `npm install` |
| Type check | `npx tsc --noEmit` |
| Run tests | `npm test` |
| Build | `npm run build` |
| Verify prompts | `npm run verify:prompts` |
| Coverage + gate | `npm run test:coverage && npm run coverage:gate` |
| Run CLI help | `CURSOR_API_KEY=cur_dummy npm run start` |

### Gotchas

- The CLI **always** requires `CURSOR_API_KEY` env var to be set (even for `--backlog` display). Use a dummy value for offline operations that don't call Cursor API (help, backlog summary).
- The project uses **ESM** (`"type": "module"`). All imports in source use `.js` extensions.
- Tests use Node's built-in `node:test` runner via `tsx --test` — no Jest/Vitest.
- No `.env` file is committed; copy `.env.example` to `.env` for actual agent runs (requires a real `CURSOR_API_KEY`).
- `npm run build` outputs to `dist/` but the dev workflow uses `tsx` directly (no build step needed for development).

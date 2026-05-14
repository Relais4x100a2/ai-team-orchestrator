## Cursor Cloud specific instructions

This is a TypeScript CLI orchestrator (no web server, no database, no Docker). All commands are documented in `CLAUDE.md` and `package.json` scripts.

### Scope

The development environment targets **testing, reviewing, and documenting** the code. No external secrets are needed — all verification commands run fully offline.

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
| Backlog summary | `CURSOR_API_KEY=cur_dummy npm run backlog` |

### Gotchas

- **No secrets needed for dev workflow**: type-checking, tests, build, and prompt verification all run without any env vars.
- The CLI entry point (`npm run start`, `npm run backlog`, etc.) requires `CURSOR_API_KEY` to be set — use a dummy value (`cur_dummy`) for offline display (help, backlog summary). A real key is only needed to actually execute agents.
- The project uses **ESM** (`"type": "module"`). All imports in source use `.js` extensions.
- Tests use Node's built-in `node:test` runner via `tsx --test` — no Jest/Vitest.
- No `.env` file is committed; copy `.env.example` to `.env` only if you need to run actual agents.
- `npm run build` outputs to `dist/` but the dev workflow uses `tsx` directly (no build step needed for development).
- Always run `npx tsc --noEmit` before proposing any TypeScript change (as stated in `CLAUDE.md`).

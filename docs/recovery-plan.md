# Readable-Writable recovery plan

This branch is a stabilization branch. The goal is to get the repository back on track without removing capabilities, rewriting the app from scratch, or breaking the current test surface.

## Current diagnosis

Readable-Writable currently runs as a single Node entrypoint:

- `package.json` starts `node server.js`.
- Tests import `../server` directly.
- `server.js` contains backend runtime, frontend HTML/CSS/JS, Cesium rendering integration, live/sim entity pipelines, WebSocket handling, planner/worker/eval runtime, timeline state, traffic state, and quantum simulation state.

That structure works for fast prototyping, but it makes every new feature risky because unrelated systems share the same file, global state, and export surface.

## Recovery invariant

Do not remove capabilities. Do not rewrite from scratch. Preserve the existing public exports from `server.js` until tests and callers are migrated.

## Extraction order

1. Establish structure and diagnostics.
2. Keep `server.js` as the compatibility shell.
3. Extract pure helpers first.
4. Extract state containers second.
5. Extract providers and polling third.
6. Extract planner/worker/eval fourth.
7. Extract quantum simulation fifth.
8. Extract frontend HTML/CSS/JS last.

## Target folders

```text
src/
  config/
  core/
  entities/
  feeds/
  frontend/
  planner/
  quantum/
  router/
  runtime/
  websocket/
```

## Definition of done for each slice

- `npm test` still passes.
- `npm start` still launches the app.
- `server.js` still exports the names existing tests require.
- No live feature is removed.
- Any moved module has a narrow responsibility and can be tested separately.

## First safe slice

This branch starts by adding structure and a diagnostic script. It does not move live runtime code yet. That gives the repo a stable map before the monolith is cut apart.

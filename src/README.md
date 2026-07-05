# Source module map

This folder is the landing zone for extracting `server.js` without changing behavior.

`server.js` remains the compatibility shell until each subsystem is safely moved and verified.

## Intended boundaries

- `config/` — environment parsing and runtime constants.
- `core/` — shared utility functions and app-level primitives.
- `entities/` — live entity builders, normalization, anomaly detection, and render sanitization.
- `feeds/` — OpenSky, ADS-B Exchange, file ingestion, provider selection, and feed broker adapters.
- `frontend/` — HTML shell, CSS, browser JS, and Cesium/client rendering code.
- `planner/` — task registry, workers, planner tick, evaluations, and pruning.
- `quantum/` — branch simulation, scoring, interference, collapse, and audit trail.
- `router/` — HTTP route handlers and response helpers.
- `runtime/` — server bootstrap, loop orchestration, startup/shutdown boundaries.
- `websocket/` — RFC 6455 handshake, parsing, sending, and broadcast helpers.

## Rule

Move behavior in small slices. After every slice, keep existing tests importing from `../server` until a dedicated module test replaces that dependency.

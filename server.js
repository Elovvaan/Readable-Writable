'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4001;
const RW_OPENSKY_ENABLED = process.env.RW_OPENSKY_ENABLED || 'true';
const OPENSKY_ENABLED = RW_OPENSKY_ENABLED === 'true';
const OPENSKY_PUBLIC_STATES_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_STATES_URL = process.env.OPENSKY_STATES_URL || OPENSKY_PUBLIC_STATES_URL;
const OPENSKY_USERNAME = process.env.RW_OPENSKY_USERNAME || process.env.OPENSKY_USERNAME || '';
const OPENSKY_PASSWORD = process.env.RW_OPENSKY_PASSWORD || process.env.OPENSKY_PASSWORD || '';
const OPENSKY_POLL_INTERVAL_MS = Math.max(5000, Number(process.env.RW_OPENSKY_POLL_INTERVAL_MS || 15000));
const OPENSKY_GLOBE_MIN_Z = Number.isFinite(Number(process.env.RW_OPENSKY_GLOBE_MIN_Z))
  ? Number(process.env.RW_OPENSKY_GLOBE_MIN_Z)
  : -1;
const OPENSKY_TRAIL_MAX_POINTS = 24;
const RW_USE_CESIUM = true;
const RW_DEFAULT_VIEW = process.env.RW_DEFAULT_VIEW || 'earth';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const CESIUM_ACCESS_TOKEN = process.env.CESIUM_ACCESS_TOKEN || '';
const OPENSKY_FILE_PATH = path.resolve(process.env.OPENSKY_FILE_PATH || 'opensky.json');
const OPENSKY_FILE_POLL_MS = 5000;
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY || '';
const AVIATIONSTACK_POLL_INTERVAL_MS = 20000;
// Anything above this speed (m/s) is flagged as physically impossible for civil aircraft.
// Commercial jets cruise at ~240–280 m/s; 600 m/s ≈ Mach 1.8.
const ANOMALY_MAX_SPEED_MS = 600;

// ─── State ───────────────────────────────────────────────────────────────────
const worldview = {
  agents: {},
  regions: {},
  tick: 0,
  started: new Date().toISOString(),
};

const spatialIndex = {};   // key: regionId, value: { id, x, y, agents: [] }
const wsClients = new Set();
const eventLog = [];       // rolling last-100 events
const openSkyLiveState = {
  flights: {},
  rawStates: [],            // last raw states array from OpenSky, served by /api/flights
  token: null,
  tokenExpiresAtMs: 0,
  lastPollAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastFetchedCount: 0,
  lastNormalizedCount: 0,
  authConfigured: true,
  lastAuthMode: 'none',
  pollingRunning: false,
  lastRequestUrl: null,
  lastRequestStatus: null,
  lastModeUsed: 'public',
  lastVisibleCount: 0,
  lastDrawnCount: 0,
};

const openSkyFileState = {
  flights: {},
  lastLoadAt: null,
  lastErrorAt: null,
  lastContentHash: null,
  anomalies: [],
};

const aviationstackState = {
  flights: [],          // normalized flight objects { id, lat, lon, altitude, velocity }
  lastPollAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastFetchedCount: 0,
  pollingRunning: false,
};

// ─── Planner / Worker / Task Runtime Stores ───────────────────────────────────
const taskRegistry = new Map();   // taskId → task
const workerRuntime = new Map();  // workerId → worker
const taskResults = new Map();    // resultId → result
const evaluations = new Map();    // evalId → evaluation
const plannerState = {
  activeTaskIds: [],
  backlogCount: 0,
  notesByRegion: {},
  lastAssignments: [],
};

// Compact debug counters
const plannerStats = {
  totalAssigned: 0,
  completedTasks: 0,
  failedTasks: 0,
  evalAccepted: 0,
  evalRetry: 0,
  evalEscalated: 0,
};

// Credentials loaded from opensky.json — env vars always take priority.
const fileCredentials = {
  username: '',
  password: '',
  credentialType: '', // 'username_password' | 'client_credentials'
};

// ─── Frontend HTML (inline) ───────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RW Worldview</title>
  <link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Widgets/widgets.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { height: 100%; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #08090b; color: #8fa8bb; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    /* ── Header ──────────────────────────────────────────────────────────── */
    header { background: #09090d; border-bottom: 1px solid #141820; padding: 5px 14px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-height: 40px; }
    header h1 { font-size: .95rem; font-weight: 600; letter-spacing: .06em; color: #2ab8a4; margin-right: auto; }
    #status { font-size: .72rem; padding: 2px 7px; border-radius: 999px; background: #0d2218; color: #3ecb92; border: 1px solid #1a4a32; white-space: nowrap; }
    #status.disconnected { background: #1e0d0d; color: #c05050; border-color: #3d1a1a; }
    #telemetry-bar { display: inline-flex; align-items: center; gap: 8px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: .6rem; color: #4e7a8c; border: 1px solid #161e28; border-radius: 6px; padding: 3px 7px; background: #06080ccc; }
    .telemetry-item { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
    .telemetry-label { color: #354e5e; letter-spacing: .07em; }
    .telemetry-value { color: #6fa8bc; }
    #telemetry-rec.live { color: #d05858; text-shadow: 0 0 8px rgba(200,60,60,.3); animation: rec-pulse 1.4s ease-in-out infinite; }
    @keyframes rec-pulse { 0%, 100% { opacity: .62; } 50% { opacity: 1; } }
    #pause-btn { border: 1px solid #1c2a36; background: #0e1520; color: #6898aa; border-radius: 4px; font-size: .66rem; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
    #pause-btn.active { background: #1a0f0f; color: #c28080; border-color: #3d2020; }
    /* ── Globe shell — fills remaining space ─────────────────────────────── */
    #globe-shell { position: relative; flex: 1; overflow: hidden; background: #04050a; min-height: 0; }
    #cesium-world { position: absolute; inset: 0; z-index: 1; display: block; width: 100%; height: 100%; }
    canvas#world { position: absolute; inset: 0; z-index: 2; display: block; width: 100%; height: 100%; pointer-events: none; }
    #fx-overlay { position: absolute; inset: 0; z-index: 3; pointer-events: none; mix-blend-mode: screen; opacity: .35; transition: opacity 320ms ease, background 320ms ease, filter 320ms ease; }
    #fx-overlay .scanlines, #fx-overlay .noise, #fx-overlay .vignette, #fx-overlay .pixel-grid { position: absolute; inset: 0; }
    #fx-overlay .scanlines { background: repeating-linear-gradient(to bottom, rgba(180,255,240,.05) 0, rgba(180,255,240,.05) 1px, transparent 1px, transparent 3px); opacity: .18; }
    #fx-overlay .noise { background-image: radial-gradient(rgba(255,255,255,.07) 0.45px, transparent 0.55px); background-size: 3px 3px; opacity: .1; }
    #fx-overlay .pixel-grid { background-image: linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px); background-size: 10px 10px; opacity: .05; }
    #fx-overlay .vignette { background: radial-gradient(circle at center, transparent 42%, rgba(0,0,0,.72) 100%); opacity: .65; }
    /* ── Launcher rail ───────────────────────────────────────────────────── */
    #rail { position: absolute; left: 0; top: 0; bottom: 0; width: 44px; z-index: 20; display: flex; flex-direction: column; align-items: center; padding: 10px 0; gap: 4px; background: #07080cdd; border-right: 1px solid #141820; backdrop-filter: blur(6px); }
    .rail-btn { width: 34px; height: 34px; border: 1px solid #161e2a; background: #0c1219; color: #384e60; border-radius: 6px; font-size: .9rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 160ms, border-color 160ms, color 160ms, transform 160ms; user-select: none; }
    .rail-btn:hover { background: #111e2e; border-color: #224060; color: #6ab0c8; transform: translateY(-1px); }
    .rail-btn.active { background: #0a2422; border-color: #1f5e5a; color: #3ec9b8; }
    .rail-sep { width: 22px; height: 1px; background: #141e28; margin: 4px 0; flex-shrink: 0; }
    /* ── Viewport controls ───────────────────────────────────────────────── */
    #viewport-controls { position: absolute; bottom: 14px; left: 56px; display: grid; gap: 5px; z-index: 10; pointer-events: auto; }
    .viewport-row { display: flex; gap: 4px; }
    .viewport-btn { border: 1px solid #1c2e3a; background: #07101acc; color: #4e8898; border-radius: 4px; font-size: .66rem; padding: 5px 9px; cursor: pointer; transition: all 180ms ease; backdrop-filter: blur(4px); }
    .viewport-btn:hover { background: #0e2030e0; border-color: #2a5060; color: #7abcc8; transform: translateY(-1px); }
    .viewport-btn.reset { border-color: #1f4e5a; color: #3ec9b8; }
    .viewport-readout { font-size: .6rem; color: #3a5868; background: #05090ecc; border: 1px solid #141e28; border-radius: 4px; padding: 2px 6px; width: fit-content; backdrop-filter: blur(4px); }
    /* ── Drawers — all position:absolute inside #globe-shell ─────────────── */
    .drawer { position: absolute; z-index: 15; background: #09090d; display: flex; flex-direction: column; overflow: hidden; pointer-events: none; opacity: 0; transition: transform 220ms cubic-bezier(.4,0,.2,1), opacity 180ms ease; }
    .drawer.open { pointer-events: auto; opacity: 1; }
    .drawer-left  { left: 44px; top: 0; bottom: 0; width: 240px; border-right: 1px solid #141820; transform: translateX(-240px); }
    .drawer-right { right: 0; top: 0; bottom: 0; width: 280px; border-left: 1px solid #141820; transform: translateX(280px); }
    .drawer-bottom { left: 44px; right: 0; bottom: 0; height: 280px; border-top: 1px solid #141820; transform: translateY(280px); }
    .drawer-top { left: 44px; right: 0; top: 0; border-bottom: 1px solid #141820; transform: translateY(-100%); }
    .drawer-left.open  { transform: translateX(0); }
    .drawer-right.open { transform: translateX(0); }
    .drawer-bottom.open { transform: translateY(0); }
    .drawer-top.open { transform: translateY(0); }
    .drawer-header { display: flex; align-items: center; padding: 7px 12px; border-bottom: 1px solid #111820; flex-shrink: 0; gap: 8px; }
    .drawer-title { font-size: .6rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2a3e4a; flex: 1; }
    .drawer-close { border: none; background: none; color: #2e4050; font-size: 1rem; cursor: pointer; padding: 0 2px; line-height: 1; transition: color 160ms; flex-shrink: 0; }
    .drawer-close:hover { color: #6898aa; }
    .drawer-body { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; min-height: 0; }
    /* ── Right drawer tabs ───────────────────────────────────────────────── */
    .drawer-tabs { display: flex; border-bottom: 1px solid #111820; flex-shrink: 0; }
    .dtab { flex: 1; border: none; background: #07080c; color: #2e4050; font-size: .6rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; padding: 7px 4px; cursor: pointer; transition: color 160ms, background 160ms; border-bottom: 2px solid transparent; }
    .dtab:hover { color: #5a8098; background: #0c1018; }
    .dtab.active { color: #3ec9b8; border-bottom-color: #3ec9b8; background: #09090d; }
    .rtab-content { display: flex; flex-direction: column; flex: 1; overflow-y: auto; min-height: 0; }
    .rtab-content.hidden { display: none; }
    /* ── Style drawer controls ───────────────────────────────────────────── */
    #style-drawer-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
    .style-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: .68rem; color: #607a8c; }
    .fx-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 10px; }
    .ctrl-toggle { display: inline-flex; align-items: center; gap: 5px; user-select: none; white-space: nowrap; cursor: pointer; font-size: .68rem; color: #607a8c; }
    .ctrl-toggle input { width: 12px; height: 12px; accent-color: #2ab8a4; cursor: pointer; }
    .ctrl-inline { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: .68rem; color: #607a8c; }
    .ctrl-compact { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: .62rem; color: #607a8c; }
    .ctrl-compact input[type=range] { width: 52px; accent-color: #2ab8a4; transition: filter 200ms, transform 200ms; }
    .ctrl-compact input[type=range]:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .ctrl-compact select { border: 1px solid #1c2a36; background: #0e1520; color: #7fb8c8; border-radius: 4px; font-size: .64rem; padding: 2px 4px; }
    #style-indicator { border: 1px solid #1c2e3a; border-radius: 999px; font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; padding: 2px 7px; color: #3ec9b8; background: #080e14; }
    #speed-select { border: 1px solid #1c2a36; background: #0e1520; color: #7fb8c8; border-radius: 4px; font-size: .66rem; padding: 2px 5px; }
    .preset-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .preset-btn { border: 1px solid #182430; background: #0c1219; color: #4e8096; border-radius: 999px; font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; padding: 3px 7px; cursor: pointer; transition: background 180ms, border-color 180ms, color 180ms, transform 180ms; }
    .preset-btn:hover { background: #111e2a; border-color: #254056; color: #8abccc; transform: translateY(-1px); }
    .preset-btn.active { background: #0e1f2e; color: #3ec9b8; border-color: #1f5e5a; }
    /* ── Data layer rows ─────────────────────────────────────────────────── */
    .lp-title { font-size: .62rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2a3e4a; padding: 10px 12px 5px; }
    .lp-toggle { display: flex; align-items: center; gap: 7px; padding: 4px 12px; font-size: .68rem; color: #5a7888; cursor: pointer; user-select: none; white-space: nowrap; transition: color 160ms; }
    .lp-toggle:hover { color: #8ab8c8; }
    .lp-toggle input { width: 12px; height: 12px; accent-color: #2ab8a4; cursor: pointer; flex-shrink: 0; }
    .lp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .lp-divider { margin: 6px 12px; border-top: 1px solid #121820; }
    .layer-row { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid #0e1420; cursor: default; }
    .layer-row.unavailable { opacity: 0.38; pointer-events: none; }
    .layer-icon { font-size: .82rem; line-height: 1; width: 16px; text-align: center; flex-shrink: 0; color: #2e4252; transition: color 200ms; }
    .layer-row.on .layer-icon { color: var(--style-accent, #3ec9b8); }
    .layer-info { flex: 1; min-width: 0; display: grid; gap: 1px; }
    .layer-name { font-size: .65rem; font-weight: 600; color: #4a6878; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 200ms; }
    .layer-row.on .layer-name { color: #7ab8c8; }
    .layer-provider { font-size: .56rem; color: #243040; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .layer-freshness { font-size: .55rem; color: #243040; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .layer-row.on .layer-freshness { color: #2e6858; }
    .layer-toggle { border: 1px solid #161e2a; background: #0b1018; color: #263444; border-radius: 3px; font-size: .54rem; font-weight: 700; letter-spacing: .08em; padding: 3px 5px; cursor: pointer; flex-shrink: 0; min-width: 28px; text-align: center; transition: background 160ms, border-color 160ms, color 160ms; }
    .layer-toggle:hover { border-color: #1e3a50; color: #4a7898; background: #0e1828; }
    .layer-toggle.active { border-color: #1f5e5a; background: #0a2422; color: #3ec9b8; }
    .layer-toggle:disabled { cursor: not-allowed; opacity: 0.5; }
    /* ── Event log ───────────────────────────────────────────────────────── */
    #event-tools { padding: 8px 14px 6px; border-bottom: 1px solid #111820; display: grid; gap: 6px; flex-shrink: 0; }
    #event-search { width: 100%; border: 1px solid #1c2a36; background: #0e1520; color: #8ab8cc; border-radius: 4px; font-size: .68rem; padding: 4px 6px; }
    #event-chip-row { display: flex; gap: 5px; flex-wrap: wrap; }
    .event-chip { border: 1px solid #181e28; border-radius: 999px; background: #0b0e16; color: #4e7888; padding: 2px 8px; font-size: .64rem; cursor: pointer; }
    .event-chip.active { background: #0d1a28; color: #3ec9b8; border-color: #1a4a44; }
    #event-log { flex: 1; overflow-y: auto; padding: 8px 0; font-size: .72rem; font-family: 'Cascadia Code', 'Fira Code', monospace; min-height: 0; }
    .event-entry { padding: 3px 14px; border-bottom: 1px solid #0e1218; color: #4e6878; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .event-entry .ts { color: #283038; margin-right: 6px; }
    .event-entry.agent { color: #3ec9b8; }
    .event-entry.region { color: #b89040; }
    .event-entry.system { color: #8060b8; }
    .event-entry.related { background: #0c1820; box-shadow: inset 2px 0 0 #2ab8a4; }
    .event-entry.dimmed { opacity: 0.38; }
    .event-empty { padding: 8px 14px; color: #38505e; font-style: italic; }
    /* ── Selected target / actions ───────────────────────────────────────── */
    #selected-panel { padding: 10px 14px; font-size: .72rem; flex-shrink: 0; }
    #action-panel { border-top: 1px solid #111820; padding: 8px 14px 10px; font-size: .72rem; flex-shrink: 0; }
    .action-row { display: flex; gap: 6px; }
    .action-row.secondary { margin-top: 8px; }
    .action-btn { border: 1px solid #1c2a36; background: #0e1520; color: #6898aa; border-radius: 4px; font-size: .68rem; padding: 4px 8px; cursor: pointer; }
    .action-btn:disabled { cursor: not-allowed; opacity: .35; }
    .selected-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .selected-label { color: #2e4050; }
    .selected-value { color: #7098a8; font-family: monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selected-empty { color: #2e4050; font-style: italic; }
    /* ── Stats ───────────────────────────────────────────────────────────── */
    #stats { padding: 10px 14px; font-size: .72rem; border-top: 1px solid #111820; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; flex-shrink: 0; }
    .stat-label { color: #2e4050; }
    .stat-value { color: #7098a8; font-family: monospace; text-align: right; }
    /* ── Pod ─────────────────────────────────────────────────────────────── */
    .pod-lab { padding: 10px 14px 14px; display: grid; gap: 10px; background: #07080c; }
    .pod-stepper { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .pod-step-chip { border: 1px solid #1c2a36; border-radius: 999px; font-size: .62rem; text-align: center; padding: 3px 0; color: #4e7888; background: #0b1218; }
    .pod-step-chip.active { border-color: #1f4e5a; color: #3ec9b8; background: #0c1e28; }
    .pod-step-chip.done { border-color: #1a4a32; color: #60c88a; background: #0a1e16; }
    .pod-lock { border: 1px dashed #2e2030; border-radius: 6px; padding: 7px 8px; font-size: .68rem; color: #9070a0; background: #100d18; }
    .pod-lock.unlocked { border-style: solid; border-color: #1a4a32; color: #60c88a; background: #0a1e16; }
    .pod-lock.flash { animation: pod-unlock-flash 900ms ease; }
    @keyframes pod-unlock-flash { 0% { box-shadow: 0 0 0 0 rgba(60,200,140,.5); } 100% { box-shadow: 0 0 0 14px rgba(60,200,140,0); } }
    .pod-field { display: grid; gap: 4px; font-size: .66rem; color: #4e7888; }
    .pod-field textarea { width: 100%; min-height: 52px; border: 1px solid #1c2a36; background: #0e1520; color: #8ab8cc; border-radius: 4px; padding: 6px; font-size: .68rem; resize: vertical; }
    .pod-field textarea:disabled { opacity: .35; cursor: not-allowed; }
    .pod-live-score { display: grid; gap: 4px; border: 1px solid #1c2a36; background: #0b1218; border-radius: 6px; padding: 7px 8px; }
    .pod-live-score-row { display: flex; justify-content: space-between; font-size: .66rem; color: #4e7888; }
    .pod-live-score strong { color: #7098a8; }
    .pod-compare { border: 1px solid #1e3040; border-radius: 6px; background: #0a1220; padding: 7px 8px; font-size: .66rem; color: #5a8098; }
    .pod-actions { display: flex; gap: 6px; }
    .pod-actions button { border: 1px solid #1c2a36; background: #0e1520; color: #6898aa; border-radius: 4px; font-size: .66rem; padding: 4px 8px; cursor: pointer; }
    .pod-actions button:disabled { opacity: .35; cursor: not-allowed; }
    /* ── Entity type chips ───────────────────────────────────────────────── */
    .type-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #181e28; border-radius: 999px; padding: 2px 7px; }
    .type-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    /* ── Style accent vars and theme cascades ────────────────────────────── */
    body[data-style-mode="crt"]  { --style-accent: #3ec9b8; --style-shell: #4ab8ac; }
    body[data-style-mode="nvg"]  { --style-accent: #7fe874; --style-shell: #88f580; }
    body[data-style-mode="flir"] { --style-accent: #d4a055; --style-shell: #c89850; }
    header h1, .event-entry.agent, .viewport-readout, #style-indicator { color: var(--style-accent, #3ec9b8); }
    .lp-title, .selected-label, .stat-label, .drawer-title { color: color-mix(in srgb, var(--style-shell, #4ab8ac) 38%, #2a3840); }
    /* ── Global transitions ──────────────────────────────────────────────── */
    #cesium-world, canvas, .action-btn, #pause-btn, #style-indicator, .event-chip { transition: filter 260ms ease, box-shadow 260ms ease, color 260ms ease, background 260ms ease, border-color 260ms ease; }
  /* === RW NEW LAYOUT === */

#sidebar {
  position: absolute;
  left: 0;
  top: 60px;
  width: 200px;
  bottom: 0;
  background: rgba(0,0,0,0.85);
  padding: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

#sidebar button {
  background: #111;
  color: #0ff;
  border: 1px solid #0ff;
  padding: 8px;
  cursor: pointer;
  text-align: left;
}

#sidebar button:hover {
  background: #0ff;
  color: #000;
}

#worldview {
  position: absolute;
  left: 200px;
  top: 60px;
  right: 0;
  bottom: 0;
}

.panel {
  position: absolute;
  left: 200px;
  right: 0;
  bottom: 0;
  height: 240px;
  background: rgba(0,0,0,0.92);
  color: white;
  display: none;
  z-index: 30;
  overflow: auto;
  padding: 12px;
  border-top: 1px solid #0ff;
}
    /* ── Street-view overlay (transparent HUD over Cesium) ──────────────────── */
    #street-view { position: absolute; inset: 0; z-index: 50; background: transparent; display: none; opacity: 0; transition: opacity 300ms ease; pointer-events: none; }
    #street-view.visible { display: block; opacity: 1; pointer-events: auto; }
    #street-view-close { position: absolute; top: 10px; right: 10px; z-index: 51; background: #09090dcc; color: #3ec9b8; border: 1px solid #1f5e5a; border-radius: 4px; font-size: .72rem; padding: 5px 12px; cursor: pointer; backdrop-filter: blur(4px); transition: background 160ms, color 160ms; }
    #street-view-close:hover { background: #0a2422; color: #7fe0d4; }
    #street-view-pano { position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: auto; }
    .sv-nav-row { display: flex; gap: 6px; justify-content: center; }
    .sv-nav-btn { border: 1px solid #1f5e5a; background: #09090dcc; color: #3ec9b8; border-radius: 4px; font-size: .72rem; padding: 6px 12px; cursor: pointer; backdrop-filter: blur(4px); transition: background 160ms, color 160ms; user-select: none; }
    .sv-nav-btn:hover { background: #0a2422; color: #7fe0d4; }
    .sv-nav-btn:active { background: #0e3530; transform: scale(0.96); }
    .sv-alt-text { font-size: .6rem; font-family: 'Cascadia Code', 'Fira Code', monospace; color: #4e9888; background: #09090dcc; border: 1px solid #141820; border-radius: 4px; padding: 3px 8px; backdrop-filter: blur(4px); white-space: nowrap; }
    #sv-mode-hint { font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: #3ec9b8; background: #09090dcc; border: 1px solid #1f5e5a; border-radius: 4px; padding: 3px 8px; backdrop-filter: blur(4px); white-space: nowrap; }
    /* ── Street-level tab — absolute overlay inside globe-shell ──────────────── */
    #street-level-view { position: absolute; inset: 0; z-index: 9; background: transparent; display: none; flex-direction: row; overflow: hidden; }
    #street-level-view.active { display: flex; }
    #street-level-header { display: flex; align-items: center; padding: 8px 14px; background: #09090d; border-bottom: 1px solid #141820; gap: 10px; flex-shrink: 0; }
    #street-level-back-btn { border: 1px solid #1f5e5a; background: #0a2422; color: #3ec9b8; border-radius: 4px; font-size: .62rem; padding: 4px 6px; cursor: pointer; transition: background 160ms, color 160ms; width: 36px; text-align: center; }
    #street-level-back-btn:hover { background: #0d2f2c; color: #7fe0d4; }
    #street-level-target-label { font-size: .58rem; color: #4e7888; font-family: 'Cascadia Code', 'Fira Code', monospace; padding: 2px 0; text-align: center; word-break: break-all; }
    #street-level-no-target { display: flex; align-items: center; justify-content: center; flex: 1; color: #2e4050; font-size: .82rem; font-style: italic; pointer-events: none; }
    #street-level-pano { position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); display: none; flex-direction: column; align-items: center; gap: 6px; pointer-events: auto; }
    #street-level-pano.visible { display: flex; }
    /* ── Street-level redesigned left panel ──────────────────────────────── */
    #sl-left-panel { width: 52px; flex-shrink: 0; background: #07080cdd; border-right: 1px solid #141820; display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 4px; overflow-y: auto; }
    .sl-world-btn { width: 36px; min-height: 36px; border: 1px solid #161e2a; background: #0c1219; color: #384e60; border-radius: 5px; font-size: .52rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; text-align: center; line-height: 1.2; padding: 2px; transition: background 160ms, border-color 160ms, color 160ms; user-select: none; }
    .sl-world-btn:hover { background: #111e2e; border-color: #224060; color: #6ab0c8; }
    .sl-world-btn.active { background: #0a2422; border-color: #1f5e5a; color: #3ec9b8; }
    /* ── Street-level center viewport ────────────────────────────────────── */
    #sl-viewport { flex: 1; position: relative; overflow: hidden; display: flex; flex-direction: column; min-width: 0; background: transparent; pointer-events: none; }
    /* ── Street-level bottom bar (locations/landmarks) ───────────────────── */
    #sl-bottom-bar { flex-shrink: 0; background: #07080ccc; border-top: 1px solid #141820; padding: 4px 10px; display: flex; align-items: center; gap: 6px; backdrop-filter: blur(4px); pointer-events: auto; }
    .sl-bottom-label { font-size: .52rem; letter-spacing: .1em; text-transform: uppercase; color: #2a3e4a; white-space: nowrap; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    #sl-landmarks { display: flex; gap: 4px; overflow-x: auto; flex: 1; scrollbar-width: none; }
    #sl-landmarks::-webkit-scrollbar { display: none; }
    .sl-landmark-btn { border: 1px solid #161e2a; background: #0a1018; color: #4e7888; border-radius: 999px; font-size: .58rem; padding: 2px 8px; cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: background 160ms, border-color 160ms, color 160ms; }
    .sl-landmark-btn:hover { background: #0e1e2e; border-color: #1e3a50; color: #7abcc8; }
    .sl-landmark-btn.active { background: #0a2422; border-color: #1f5e5a; color: #3ec9b8; }
    /* ── States pop-up drawer (bottom, inside #sl-viewport) ─────────────── */
    #sl-states-drawer { position: absolute; left: 0; right: 0; bottom: 0; background: #09090dee; border-top: 1px solid #1f5e5a; transform: translateY(100%); transition: transform 260ms cubic-bezier(.4,0,.2,1); z-index: 10; display: flex; flex-direction: column; max-height: 60%; pointer-events: auto; }
    #sl-states-drawer.open { transform: translateY(0); }
    #sl-states-hdr { display: flex; align-items: center; padding: 6px 12px; border-bottom: 1px solid #141820; flex-shrink: 0; gap: 8px; }
    .sl-states-title { font-size: .58rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #3ec9b8; font-family: 'Cascadia Code', 'Fira Code', monospace; flex: 1; }
    #sl-states-close { border: none; background: none; color: #2e4050; font-size: 1rem; cursor: pointer; padding: 0 2px; line-height: 1; transition: color 160ms; flex-shrink: 0; }
    #sl-states-close:hover { color: #6898aa; }
    #sl-states-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 4px; padding: 8px 12px; overflow-y: auto; flex: 1; }
    .sl-state-btn { border: 1px solid #161e2a; background: #0b1018; color: #4e7888; border-radius: 4px; font-size: .6rem; padding: 4px 6px; cursor: pointer; text-align: left; transition: background 160ms, border-color 160ms, color 160ms; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sl-state-btn:hover { background: #0e1e2e; border-color: #1e3a50; color: #7abcc8; }
    .sl-state-btn.active { background: #0a2422; border-color: #1f5e5a; color: #3ec9b8; }
    /* ── Street-level right tactical panel (dark CRT console) ───────────── */
    #sl-right-panel { width: 118px; flex-shrink: 0; background: #05060aee; border-left: 1px solid #141820; display: flex; flex-direction: column; overflow-y: auto; }
    .sl-mono { font-family: 'Cascadia Code', 'Fira Code', monospace; }
    /* Monitor module */
    #sl-monitor { border-bottom: 1px solid #1a2030; padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    #sl-monitor-hdr { display: flex; align-items: center; gap: 4px; font-size: .55rem; }
    #sl-rec-dot { color: #c05050; font-size: .66rem; animation: rec-pulse 1.4s ease-in-out infinite; }
    #sl-monitor-hdr .sl-mono { font-size: .55rem; letter-spacing: .1em; color: #3ec9b8; }
    #sl-timestamp { color: #4e9888; font-size: .5rem; margin-left: auto; }
    #sl-monitor-status { font-size: .5rem; letter-spacing: .08em; text-transform: uppercase; color: #b89040; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    #sl-monitor-window { width: 100%; aspect-ratio: 16/9; background: #030408; border: 1px solid #141e2a; border-radius: 2px; overflow: hidden; position: relative; }
    #sl-monitor-window::after { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(to bottom, rgba(180,255,240,.04) 0, rgba(180,255,240,.04) 1px, transparent 1px, transparent 3px); pointer-events: none; }
    /* Tactical controls */
    #sl-tac-panel { display: flex; flex-direction: column; gap: 2px; padding: 5px 6px; flex: 1; }
    .sl-tac-btn { border: 1px solid #161e2a; background: #0c1219; color: #384e60; border-radius: 3px; font-size: .54rem; font-weight: 700; letter-spacing: .09em; padding: 6px 4px; cursor: pointer; text-align: center; transition: background 160ms, border-color 160ms, color 160ms; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .sl-tac-btn:hover { background: #111e2e; border-color: #224060; color: #6ab0c8; }
    .sl-tac-btn.active { background: #0a2422; border-color: #1f5e5a; color: #3ec9b8; }
    /* ── Header tab button ───────────────────────────────────────────────── */
    .header-tab { border: 1px solid #1c2a36; background: #0e1520; color: #6898aa; border-radius: 4px; font-size: .66rem; padding: 3px 8px; cursor: pointer; white-space: nowrap; transition: background 160ms, border-color 160ms, color 160ms; }
    .header-tab:hover { background: #111e2a; border-color: #254056; color: #8abccc; }
    .header-tab.active { background: #0a2422; color: #3ec9b8; border-color: #1f5e5a; }
  </style>
</head>
<body>
<header>
  <h1>RW Worldview</h1>
  <span id="status" class="disconnected">disconnected</span>
  <div id="telemetry-bar" aria-live="polite">
    <span class="telemetry-item"><span class="telemetry-label">MODE</span><span class="telemetry-value" id="telemetry-mode">CRT</span></span>
    <span class="telemetry-item"><span class="telemetry-label">REC</span><span class="telemetry-value" id="telemetry-rec">●</span></span>
    <span class="telemetry-item"><span class="telemetry-label">LAT/LNG</span><span class="telemetry-value" id="telemetry-coords">--.--, --.--</span></span>
    <span class="telemetry-item"><span class="telemetry-label">UTC</span><span class="telemetry-value" id="telemetry-utc">--:--:--</span></span>
  </div>
  <span id="style-indicator">mode: crt</span>
  <button id="pause-btn" type="button" aria-pressed="false">Pause</button>
</header>
<div id="globe-shell">

  <!-- Launcher rail -->
  <nav id="rail" aria-label="Panel launcher">
    <button class="rail-btn" type="button" data-panel="layers" title="Data Layers" aria-label="Toggle Layers panel">☰</button>
    <button class="rail-btn" type="button" data-panel="events" title="Event Stream" aria-label="Toggle Events panel">◉</button>
    <button class="rail-btn" type="button" data-panel="target" title="Selected Target" aria-label="Toggle Target panel">⊕</button>
    <button class="rail-btn" type="button" data-panel="stats"  title="Stats" aria-label="Toggle Stats panel">▦</button>
    <button class="rail-btn" type="button" data-panel="style"  title="Style / FX" aria-label="Toggle Style panel">◈</button>
    <button class="rail-btn" id="rail-btn-street-level" type="button" title="Street Level" aria-label="Street Level" aria-pressed="false">⊞</button>
  </nav>

  <!-- Layers drawer (left) -->
  <div id="drawer-layers" class="drawer drawer-left" role="region" aria-label="Data Layers">
    <div class="drawer-header"><span class="drawer-title">Data Layers</span><button class="drawer-close" type="button" aria-label="Close">✕</button></div>
    <div class="drawer-body">
      <div class="layer-row on" data-layer="liveFlights">
        <div class="layer-icon">✈</div>
        <div class="layer-info">
          <div class="layer-name">Live Flights</div>
          <div class="layer-provider">OpenSky Network</div>
          <div class="layer-freshness" id="layer-status-liveFlights">—</div>
        </div>
        <button class="layer-toggle active" id="toggle-layer-flights" type="button" aria-pressed="true">ON</button>
      </div>
      <div class="layer-row unavailable" data-layer="militaryFlights">
        <div class="layer-icon">★</div>
        <div class="layer-info">
          <div class="layer-name">Military Flights</div>
          <div class="layer-provider">ADS-B Exchange</div>
          <div class="layer-freshness" id="layer-status-militaryFlights">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-militaryFlights" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="layer-row unavailable" data-layer="earthquakes">
        <div class="layer-icon">◎</div>
        <div class="layer-info">
          <div class="layer-name">Earthquakes</div>
          <div class="layer-provider">USGS NEIC</div>
          <div class="layer-freshness" id="layer-status-earthquakes">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-earthquakes" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="layer-row on" data-layer="satellites">
        <div class="layer-icon">●</div>
        <div class="layer-info">
          <div class="layer-name">Satellites</div>
          <div class="layer-provider">Celestrak / TLE</div>
          <div class="layer-freshness" id="layer-status-satellites">—</div>
        </div>
        <button class="layer-toggle active" id="toggle-layer-satellites" type="button" aria-pressed="true">ON</button>
      </div>
      <div class="layer-row unavailable" data-layer="traffic">
        <div class="layer-icon">≡</div>
        <div class="layer-info">
          <div class="layer-name">Street Traffic</div>
          <div class="layer-provider">HERE / TomTom</div>
          <div class="layer-freshness" id="layer-status-traffic">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-traffic" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="layer-row unavailable" data-layer="weather">
        <div class="layer-icon">☁</div>
        <div class="layer-info">
          <div class="layer-name">Weather Radar</div>
          <div class="layer-provider">NOAA / NWS</div>
          <div class="layer-freshness" id="layer-status-weather">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-weather" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="layer-row unavailable" data-layer="cctvMesh">
        <div class="layer-icon">□</div>
        <div class="layer-info">
          <div class="layer-name">CCTV Mesh</div>
          <div class="layer-provider">City Feed</div>
          <div class="layer-freshness" id="layer-status-cctvMesh">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-cctvMesh" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="layer-row unavailable" data-layer="bikeshare">
        <div class="layer-icon">⊕</div>
        <div class="layer-info">
          <div class="layer-name">Bikeshare</div>
          <div class="layer-provider">GBFS Network</div>
          <div class="layer-freshness" id="layer-status-bikeshare">UNAVAILABLE</div>
        </div>
        <button class="layer-toggle" id="toggle-layer-bikeshare" type="button" aria-pressed="false" disabled>—</button>
      </div>
      <div class="lp-divider"></div>
      <div class="lp-title">Visibility</div>
      <label class="lp-toggle"><input type="checkbox" id="toggle-agents" checked><span>Agents</span></label>
      <label class="lp-toggle"><input type="checkbox" id="toggle-regions" checked><span>Regions</span></label>
      <label class="lp-toggle"><input type="checkbox" id="toggle-trails" checked><span>Trails</span></label>
      <div class="lp-divider"></div>
      <div class="lp-title">Entity Types</div>
      <label class="lp-toggle"><span class="lp-dot" style="background:#3ec9b8"></span><input type="checkbox" id="toggle-type-agent" checked><span>Agents</span></label>
      <label class="lp-toggle"><span class="lp-dot" style="background:#c8884a"></span><input type="checkbox" id="toggle-type-flight" checked><span>Flights</span></label>
      <label class="lp-toggle"><span class="lp-dot" style="background:#9a70d8"></span><input type="checkbox" id="toggle-type-satellite" checked><span>Sats</span></label>
      <div class="lp-divider"></div>
      <div class="lp-title">Region Layer</div>
      <label class="lp-toggle"><input type="checkbox" id="toggle-layer-regions" checked><span>Regions</span></label>
    </div>
  </div>

  <!-- Events drawer (bottom) -->
  <div id="drawer-events" class="drawer drawer-bottom" role="region" aria-label="Event Stream">
    <div class="drawer-header"><span class="drawer-title">Event Stream</span><button class="drawer-close" type="button" aria-label="Close">✕</button></div>
    <div class="drawer-body">
      <div id="event-tools">
        <input id="event-search" type="text" placeholder="Search events" aria-label="Search events">
        <div id="event-chip-row">
          <button class="event-chip active" type="button" data-event-filter="all">All</button>
          <button class="event-chip" type="button" data-event-filter="tick">Tick</button>
          <button class="event-chip" type="button" data-event-filter="movement">Movement / state events</button>
          <button class="event-chip" type="button" data-event-filter="region">Region events</button>
          <button class="event-chip" type="button" data-event-filter="operator">Operator events</button>
        </div>
      </div>
      <div id="event-log"></div>
    </div>
  </div>

  <!-- Right drawer (Target / Stats tabs) -->
  <div id="drawer-right" class="drawer drawer-right" role="region" aria-label="Target and Stats">
    <div class="drawer-tabs">
      <button class="dtab active" type="button" data-tab="target">Target</button>
      <button class="dtab" type="button" data-tab="stats">Stats</button>
    </div>
    <div id="rtab-target" class="rtab-content">
      <div class="panel-title">Selected Target</div>
      <div id="selected-panel"></div>
      <div id="action-panel">
        <div class="action-row">
          <button id="action-focus" class="action-btn" type="button">Focus</button>
          <button id="action-ping" class="action-btn" type="button">Ping</button>
          <button id="action-flag" class="action-btn" type="button">Flag</button>
        </div>
        <div class="action-row secondary">
          <label class="ctrl-toggle"><input type="checkbox" id="toggle-follow-target">Follow Target</label>
        </div>
      </div>
    </div>
    <div id="rtab-stats" class="rtab-content hidden">
      <div class="panel-title">Stats</div>
      <div id="stats">
        <span class="stat-label">Tick</span><span class="stat-value" id="s-tick">—</span>
        <span class="stat-label">Agents</span><span class="stat-value" id="s-agents">—</span>
        <span class="stat-label">Regions</span><span class="stat-value" id="s-regions">—</span>
        <span class="stat-label">FlightsDbg</span><span class="stat-value" id="s-flights-debug">—</span>
        <span class="stat-label">Layers</span><span class="stat-value" id="s-layers-debug">—</span>
        <span class="stat-label">RenderDbg</span><span class="stat-value" id="s-render-debug">—</span>
        <span class="stat-label">Speed</span><span class="stat-value" id="s-speed">1x</span>
        <span class="stat-label">Uptime</span><span class="stat-value" id="s-uptime">—</span>
      </div>
      <div class="panel-title">Pod 1 Run Coach</div>
      <section id="pod-lab" class="pod-lab">
        <div class="pod-stepper" aria-label="Pod run steps">
          <span class="pod-step-chip active" data-pod-step="1">1 Prompt</span>
          <span class="pod-step-chip" data-pod-step="2">2 AI Gate</span>
          <span class="pod-step-chip" data-pod-step="3">3 Verify</span>
          <span class="pod-step-chip" data-pod-step="4">4 Compare</span>
        </div>
        <div id="pod-ai-lock" class="pod-lock">AI locked — submit your first answer to unlock.</div>
        <label class="pod-field">Prompt
          <textarea id="pod-user-answer" placeholder="Write your Pod 1 answer first..."></textarea>
        </label>
        <label class="pod-field">AI output (gated)
          <textarea id="pod-ai-output" disabled placeholder="Locked until your first answer is submitted."></textarea>
        </label>
        <label class="pod-field">Verification: what's wrong
          <textarea id="pod-verify-wrong" disabled placeholder="Required critique section #1"></textarea>
        </label>
        <label class="pod-field">Verification: what's missing
          <textarea id="pod-verify-missing" disabled placeholder="Required critique section #2"></textarea>
        </label>
        <label class="pod-field">Verification: what would you change
          <textarea id="pod-verify-change" disabled placeholder="Required critique section #3"></textarea>
        </label>
        <div id="pod-compare-box" class="pod-compare" hidden>
          Compare moment (required): explicitly contrast your answer and AI output to continue.
        </div>
        <div class="pod-live-score" aria-live="polite">
          <div class="pod-live-score-row"><span>Current step</span><strong id="pod-score-step">1 / 4</strong></div>
          <div class="pod-live-score-row"><span>Structured critique</span><strong id="pod-score-critique">0 / 3</strong></div>
          <div class="pod-live-score-row"><span>Comparison complete</span><strong id="pod-score-compare">No</strong></div>
          <div class="pod-live-score-row"><span>Live score</span><strong id="pod-score-total">0</strong></div>
        </div>
        <div class="pod-actions">
          <button id="pod-unlock-ai-btn" type="button">Unlock AI</button>
          <button id="pod-compare-btn" type="button" disabled>Complete Compare</button>
        </div>
      </section>
    </div>
  </div>

  <!-- Style / FX drawer (top) -->
  <div id="drawer-style" class="drawer drawer-top" role="region" aria-label="Style and FX">
    <div class="drawer-header"><span class="drawer-title">Style / FX</span><button class="drawer-close" type="button" aria-label="Close">✕</button></div>
    <div id="style-drawer-body">
      <label class="ctrl-inline" for="speed-select">Speed
        <select id="speed-select" aria-label="Simulation speed">
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="2">2x</option>
          <option value="4">4x</option>
        </select>
      </label>
      <label class="ctrl-compact" for="style-mode-select">Style
        <select id="style-mode-select" aria-label="Visual style mode">
          <option value="crt" selected>CRT</option>
          <option value="nvg">NVG</option>
          <option value="flir">FLIR</option>
        </select>
      </label>
      <div class="preset-row">
        <button class="preset-btn active" type="button" data-style-preset="tactical">Tactical</button>
        <button class="preset-btn" type="button" data-style-preset="surveillance">Surveillance</button>
        <button class="preset-btn" type="button" data-style-preset="cinematic">Cinematic</button>
        <button class="preset-btn" type="button" data-style-preset="minimal">Minimal</button>
      </div>
      <div class="fx-grid">
        <label class="ctrl-compact" for="fx-bloom">Bloom<input id="fx-bloom" type="range" min="0" max="100" value="20"></label>
        <label class="ctrl-compact" for="fx-sharpen">Sharp<input id="fx-sharpen" type="range" min="0" max="100" value="30"></label>
        <label class="ctrl-compact" for="fx-noise">Noise<input id="fx-noise" type="range" min="0" max="100" value="18"></label>
        <label class="ctrl-compact" for="fx-vignette">Vignette<input id="fx-vignette" type="range" min="0" max="100" value="50"></label>
        <label class="ctrl-compact" for="fx-pixelation">Density<input id="fx-pixelation" type="range" min="0" max="100" value="14"></label>
        <label class="ctrl-compact" for="fx-glow">Glow<input id="fx-glow" type="range" min="0" max="100" value="18"></label>
      </div>
    </div>
  </div>

  <!-- Globe viewport -->
  <div id="viewport-controls">
    <div class="viewport-row">
      <button id="zoom-out-btn" class="viewport-btn" type="button" title="Zoom out">−</button>
      <button id="zoom-in-btn" class="viewport-btn" type="button" title="Zoom in">+</button>
    </div>
    <div class="viewport-row">
      <button id="pan-left-btn" class="viewport-btn" type="button" title="Pan left">←</button>
      <button id="pan-up-btn" class="viewport-btn" type="button" title="Pan up">↑</button>
      <button id="pan-down-btn" class="viewport-btn" type="button" title="Pan down">↓</button>
      <button id="pan-right-btn" class="viewport-btn" type="button" title="Pan right">→</button>
    </div>
    <button id="reset-view-btn" class="viewport-btn reset" type="button" title="Reset to default globe view">⌂ Reset</button>
    <div id="viewport-readout" class="viewport-readout">orbit free</div>
  </div>
  <div id="cesium-world"></div>
  <canvas id="world"></canvas>
  <div id="fx-overlay" aria-hidden="true">
    <div class="scanlines"></div>
    <div class="noise"></div>
    <div class="pixel-grid"></div>
    <div class="vignette"></div>
  </div>

  <!-- Street-view overlay panel (hidden until an entity is selected) -->
  <div id="street-view" role="region" aria-label="Street View">
    <button id="street-view-close" type="button" title="Close Street View and return to globe">✕ Globe</button>
    <div id="street-view-pano">
      <span id="sv-mode-hint">STREET LEVEL · WASD move · R/F altitude</span>
      <div class="sv-nav-row">
        <button id="sv-fwd-btn" class="sv-nav-btn" type="button" title="Forward (W)">↑ FWD</button>
      </div>
      <div class="sv-nav-row">
        <button id="sv-left-btn" class="sv-nav-btn" type="button" title="Strafe left (A)">← LEFT</button>
        <button id="sv-back-btn" class="sv-nav-btn" type="button" title="Backward (S)">↓ BACK</button>
        <button id="sv-right-btn" class="sv-nav-btn" type="button" title="Strafe right (D)">RIGHT →</button>
      </div>
      <div class="sv-nav-row">
        <button id="sv-asc-btn" class="sv-nav-btn" type="button" title="Ascend (R)">▲ ASC</button>
        <span id="sv-alt-readout" class="sv-alt-text">—m</span>
        <button id="sv-desc-btn" class="sv-nav-btn" type="button" title="Descend (F)">▼ DES</button>
      </div>
    </div>
  </div>

  <!-- Street-level tab view — absolute overlay inside globe-shell for seamless Cesium transitions -->
  <div id="street-level-view" role="region" aria-label="Street Level View">

  <!-- Left panel: world controls -->
  <div id="sl-left-panel">
    <button id="street-level-back-btn" type="button" title="Return to globe view">←</button>
    <div class="rail-sep"></div>
    <button class="sl-world-btn active" id="street-level-tab" type="button" aria-pressed="false" title="Street Level mode active">⊞<br>Street Level</button>
    <button class="sl-world-btn" data-sl-world="citymesh" type="button" title="City Mesh">⬡<br>City Mesh</button>
    <button class="sl-world-btn" data-sl-world="layers" type="button" title="Data Layers">☰<br>Layers</button>
    <button class="sl-world-btn" data-sl-world="scenes" type="button" title="Scenes">◈<br>Scenes</button>
    <div class="rail-sep"></div>
    <button class="sl-world-btn" id="sl-states-toggle" type="button" title="Open States drawer">▤<br>States</button>
    <div class="rail-sep"></div>
    <span id="street-level-target-label"></span>
  </div>

  <!-- Center: panorama viewport -->
  <div id="sl-viewport">
    <div id="street-level-no-target">Select a target first.</div>
    <div id="street-level-pano">
      <span class="sv-alt-text" id="sl-alt-readout">—m</span>
      <div class="sv-nav-row">
        <button id="sl-fwd-btn" class="sv-nav-btn" type="button" title="Forward (W)">↑ FWD</button>
      </div>
      <div class="sv-nav-row">
        <button id="sl-left-btn" class="sv-nav-btn" type="button" title="Left (A)">← LEFT</button>
        <button id="sl-back-btn" class="sv-nav-btn" type="button" title="Back (S)">↓ BACK</button>
        <button id="sl-right-btn" class="sv-nav-btn" type="button" title="Right (D)">RIGHT →</button>
      </div>
      <div class="sv-nav-row">
        <button id="sl-asc-btn" class="sv-nav-btn" type="button" title="Ascend (R)">▲ ASC</button>
        <button id="sl-desc-btn" class="sv-nav-btn" type="button" title="Descend (F)">▼ DES</button>
      </div>
    </div>

    <!-- States pop-up drawer (slides up from bottom inside viewport) -->
    <div id="sl-states-drawer" role="dialog" aria-label="States navigator" aria-hidden="true">
      <div id="sl-states-hdr">
        <span class="sl-states-title">STATES</span>
        <button id="sl-states-close" type="button" title="Close States drawer">✕</button>
      </div>
      <div id="sl-states-grid">
        <button class="sl-state-btn" data-lat="32.3617" data-lng="-86.2792">Alabama</button>
        <button class="sl-state-btn" data-lat="64.2008" data-lng="-153.4937">Alaska</button>
        <button class="sl-state-btn" data-lat="34.0489" data-lng="-111.0937">Arizona</button>
        <button class="sl-state-btn" data-lat="34.7999" data-lng="-92.1996">Arkansas</button>
        <button class="sl-state-btn" data-lat="36.7783" data-lng="-119.4179">California</button>
        <button class="sl-state-btn" data-lat="39.5501" data-lng="-105.7821">Colorado</button>
        <button class="sl-state-btn" data-lat="41.6032" data-lng="-73.0877">Connecticut</button>
        <button class="sl-state-btn" data-lat="38.9108" data-lng="-75.5277">Delaware</button>
        <button class="sl-state-btn" data-lat="27.9944" data-lng="-81.7603">Florida</button>
        <button class="sl-state-btn" data-lat="32.1656" data-lng="-82.9001">Georgia</button>
        <button class="sl-state-btn" data-lat="19.8968" data-lng="-155.5828">Hawaii</button>
        <button class="sl-state-btn" data-lat="44.0682" data-lng="-114.7421">Idaho</button>
        <button class="sl-state-btn" data-lat="40.6331" data-lng="-89.3985">Illinois</button>
        <button class="sl-state-btn" data-lat="40.2672" data-lng="-86.1349">Indiana</button>
        <button class="sl-state-btn" data-lat="41.8780" data-lng="-93.0977">Iowa</button>
        <button class="sl-state-btn" data-lat="39.0119" data-lng="-98.4842">Kansas</button>
        <button class="sl-state-btn" data-lat="37.8393" data-lng="-84.2700">Kentucky</button>
        <button class="sl-state-btn" data-lat="31.2448" data-lng="-92.1451">Louisiana</button>
        <button class="sl-state-btn" data-lat="45.2538" data-lng="-69.4455">Maine</button>
        <button class="sl-state-btn" data-lat="39.0458" data-lng="-76.6413">Maryland</button>
        <button class="sl-state-btn" data-lat="42.4072" data-lng="-71.3824">Massachusetts</button>
        <button class="sl-state-btn" data-lat="44.3148" data-lng="-85.6024">Michigan</button>
        <button class="sl-state-btn" data-lat="46.7296" data-lng="-94.6859">Minnesota</button>
        <button class="sl-state-btn" data-lat="32.3547" data-lng="-89.3985">Mississippi</button>
        <button class="sl-state-btn" data-lat="37.9643" data-lng="-91.8318">Missouri</button>
        <button class="sl-state-btn" data-lat="46.8797" data-lng="-110.3626">Montana</button>
        <button class="sl-state-btn" data-lat="41.4925" data-lng="-99.9018">Nebraska</button>
        <button class="sl-state-btn" data-lat="38.8026" data-lng="-116.4194">Nevada</button>
        <button class="sl-state-btn" data-lat="43.1939" data-lng="-71.5724">New Hampshire</button>
        <button class="sl-state-btn" data-lat="40.0583" data-lng="-74.4057">New Jersey</button>
        <button class="sl-state-btn" data-lat="34.5199" data-lng="-105.8701">New Mexico</button>
        <button class="sl-state-btn" data-lat="42.1657" data-lng="-74.9481">New York</button>
        <button class="sl-state-btn" data-lat="35.7596" data-lng="-79.0193">North Carolina</button>
        <button class="sl-state-btn" data-lat="47.5515" data-lng="-101.002">North Dakota</button>
        <button class="sl-state-btn" data-lat="40.4173" data-lng="-82.9071">Ohio</button>
        <button class="sl-state-btn" data-lat="35.4676" data-lng="-97.5164">Oklahoma</button>
        <button class="sl-state-btn" data-lat="43.8041" data-lng="-120.5542">Oregon</button>
        <button class="sl-state-btn" data-lat="41.2033" data-lng="-77.1945">Pennsylvania</button>
        <button class="sl-state-btn" data-lat="41.5801" data-lng="-71.4774">Rhode Island</button>
        <button class="sl-state-btn" data-lat="33.8361" data-lng="-81.1637">South Carolina</button>
        <button class="sl-state-btn" data-lat="44.2998" data-lng="-99.4388">South Dakota</button>
        <button class="sl-state-btn" data-lat="35.5175" data-lng="-86.5804">Tennessee</button>
        <button class="sl-state-btn" data-lat="31.9686" data-lng="-99.9018">Texas</button>
        <button class="sl-state-btn" data-lat="39.3210" data-lng="-111.0937">Utah</button>
        <button class="sl-state-btn" data-lat="44.5588" data-lng="-72.5778">Vermont</button>
        <button class="sl-state-btn" data-lat="37.4316" data-lng="-78.6569">Virginia</button>
        <button class="sl-state-btn" data-lat="47.7511" data-lng="-120.7401">Washington</button>
        <button class="sl-state-btn" data-lat="38.5976" data-lng="-80.4549">West Virginia</button>
        <button class="sl-state-btn" data-lat="43.7844" data-lng="-88.7879">Wisconsin</button>
        <button class="sl-state-btn" data-lat="43.0760" data-lng="-107.2903">Wyoming</button>
      </div>
    </div>

    <!-- Bottom bar: locations/landmarks navigator -->
    <div id="sl-bottom-bar" aria-label="Locations navigator">
      <span class="sl-bottom-label">LOCATIONS</span>
      <div id="sl-landmarks">
        <button class="sl-landmark-btn" data-lat="40.7128" data-lng="-74.006">New York</button>
        <button class="sl-landmark-btn" data-lat="34.0522" data-lng="-118.2437">Los Angeles</button>
        <button class="sl-landmark-btn" data-lat="41.8781" data-lng="-87.6298">Chicago</button>
        <button class="sl-landmark-btn" data-lat="29.7604" data-lng="-95.3698">Houston</button>
        <button class="sl-landmark-btn" data-lat="33.4484" data-lng="-112.074">Phoenix</button>
        <button class="sl-landmark-btn" data-lat="39.9526" data-lng="-75.1652">Philadelphia</button>
        <button class="sl-landmark-btn" data-lat="29.4241" data-lng="-98.4936">San Antonio</button>
        <button class="sl-landmark-btn" data-lat="32.7767" data-lng="-96.797">Dallas</button>
        <button class="sl-landmark-btn" data-lat="37.7749" data-lng="-122.4194">San Francisco</button>
        <button class="sl-landmark-btn" data-lat="47.6062" data-lng="-122.3321">Seattle</button>
        <button class="sl-landmark-btn" data-lat="42.3601" data-lng="-71.0589">Boston</button>
        <button class="sl-landmark-btn" data-lat="25.7617" data-lng="-80.1918">Miami</button>
      </div>
    </div>
  </div>

  <!-- Right panel: tactical controls + monitor -->
  <div id="sl-right-panel">
    <!-- Record / Monitor module -->
    <div id="sl-monitor">
      <div id="sl-monitor-hdr">
        <span id="sl-rec-dot" aria-label="REC indicator">●</span>
        <span class="sl-mono">REC</span>
        <span id="sl-timestamp" class="sl-mono">00:00:00Z</span>
      </div>
      <div id="sl-monitor-status" class="sl-mono">STANDBY</div>
      <div id="sl-monitor-window" aria-label="Monitor preview"></div>
    </div>
    <!-- Tactical controls -->
    <div id="sl-tac-panel">
      <button class="sl-tac-btn" data-tac="move">MOVE</button>
      <button class="sl-tac-btn" data-tac="bloom">BLOOM</button>
      <button class="sl-tac-btn" data-tac="sharpen">SHARPEN</button>
      <button class="sl-tac-btn" data-tac="hud">HUD</button>
      <button class="sl-tac-btn" data-tac="layout">LAYOUT</button>
      <button class="sl-tac-btn" data-tac="panoptic">PANOPTIC</button>
      <button class="sl-tac-btn" data-tac="density">DENSITY</button>
      <button class="sl-tac-btn" data-tac="cleanui">CLEAN UI</button>
    </div>
  </div>

  </div>

</div>

<script src="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Cesium.js"></script>
<script id="rw-bootstrap" type="application/json">__RW_BOOTSTRAP__</script>
<script>
(function () {
  'use strict';
  function togglePanel(name) {
    document.querySelectorAll('.panel').forEach((p) => {
      p.style.display = 'none';
    });
    const panel = document.getElementById('panel-' + name);
    if (panel) {
      panel.style.display = 'block';
    }
  }
  window.togglePanel = togglePanel;
  const canvas  = document.getElementById('world');
  const ctx     = canvas.getContext('2d');
  const cesiumContainer = document.getElementById('cesium-world');
  const bootstrapRaw = document.getElementById('rw-bootstrap');
  const BOOTSTRAP = bootstrapRaw ? JSON.parse(bootstrapRaw.textContent || '{}') : {};
  const USE_CESIUM = true;
  const LEGACY_CANVAS_RENDERER = false;
  const DEFAULT_VIEW = BOOTSTRAP.defaultView || 'earth';
  const GOOGLE_TILESET_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
  let cesiumViewer = null;
  let cesiumGoogleTileset = null;
  const cesiumEntityRefs = { agents: {}, regions: {}, trails: {} };
  let cesiumSelectionHandler = null;
  let cesiumSafetyViewApplied = false;
  let streetViewPanorama = null;
  let streetViewVisible = false;
  let streetLevelPanorama = null;
  let streetLevelActive = false;
  let cesiumStreetLevelMode = false;
  let cesiumPreStreetLevelPos = null;
  let cesiumFocusModeActive = false;
  const cesiumDroneKeys = {};
  let droneMoveFrameId = null;
  let lastCesiumRenderCounts = {
    entities: 0,
    regions: 0,
    satellites: 0,
    flightsDrawn: 0,
    earthInitialized: false,
    tilesLoaded: false,
    tilesState: 'pending',
    tilesError: null,
  };
  let lastCesiumDiagAt = 0;
  const log     = document.getElementById('event-log');
  const eventSearchEl = document.getElementById('event-search');
  const eventChipRowEl = document.getElementById('event-chip-row');
  const selectedPanel = document.getElementById('selected-panel');
  const focusActionBtn = document.getElementById('action-focus');
  const pingActionBtn = document.getElementById('action-ping');
  const flagActionBtn = document.getElementById('action-flag');
  const followTargetToggleEl = document.getElementById('toggle-follow-target');
  const statusEl = document.getElementById('status');
  const toggleAgentsEl = document.getElementById('toggle-agents');
  const toggleRegionsEl = document.getElementById('toggle-regions');
  const toggleTrailsEl = document.getElementById('toggle-trails');
  // Layer toggle buttons (now <button> elements, not checkboxes)
  const toggleLayerFlightsEl     = document.getElementById('toggle-layer-flights');
  const toggleLayerSatellitesEl  = document.getElementById('toggle-layer-satellites');
  const toggleLayerRegionsEl     = document.getElementById('toggle-layer-regions');
  // kept for title-init compatibility; these are disabled buttons in unavailable state
  const toggleLayerTrafficEl     = document.getElementById('toggle-layer-traffic');
  const toggleLayerWeatherEl     = document.getElementById('toggle-layer-weather');
  const toggleTypeAgentEl = document.getElementById('toggle-type-agent');
  const toggleTypeFlightEl = document.getElementById('toggle-type-flight');
  const toggleTypeSatelliteEl = document.getElementById('toggle-type-satellite');
  const pauseBtnEl = document.getElementById('pause-btn');
  const speedSelectEl = document.getElementById('speed-select');
  const zoomOutBtnEl = document.getElementById('zoom-out-btn');
  const zoomInBtnEl = document.getElementById('zoom-in-btn');
  const resetViewBtnEl = document.getElementById('reset-view-btn');
  const panLeftBtnEl = document.getElementById('pan-left-btn');
  const panRightBtnEl = document.getElementById('pan-right-btn');
  const panUpBtnEl = document.getElementById('pan-up-btn');
  const panDownBtnEl = document.getElementById('pan-down-btn');
  const viewportReadoutEl = document.getElementById('viewport-readout');
  const styleModeSelectEl = document.getElementById('style-mode-select');
  const styleIndicatorEl = document.getElementById('style-indicator');
  const telemetryModeEl = document.getElementById('telemetry-mode');
  const telemetryRecEl = document.getElementById('telemetry-rec');
  const telemetryCoordsEl = document.getElementById('telemetry-coords');
  const telemetryUtcEl = document.getElementById('telemetry-utc');
  const presetButtons = Array.from(document.querySelectorAll('[data-style-preset]'));
  const fxOverlayEl = document.getElementById('fx-overlay');
  const fxBloomEl = document.getElementById('fx-bloom');
  const fxSharpenEl = document.getElementById('fx-sharpen');
  const fxNoiseEl = document.getElementById('fx-noise');
  const fxVignetteEl = document.getElementById('fx-vignette');
  const fxPixelationEl = document.getElementById('fx-pixelation');
  const fxGlowEl = document.getElementById('fx-glow');
  const podUserAnswerEl = document.getElementById('pod-user-answer');
  const podAiOutputEl = document.getElementById('pod-ai-output');
  const podVerifyWrongEl = document.getElementById('pod-verify-wrong');
  const podVerifyMissingEl = document.getElementById('pod-verify-missing');
  const podVerifyChangeEl = document.getElementById('pod-verify-change');
  const podAiLockEl = document.getElementById('pod-ai-lock');
  const podCompareBoxEl = document.getElementById('pod-compare-box');
  const podUnlockAiBtnEl = document.getElementById('pod-unlock-ai-btn');
  const podCompareBtnEl = document.getElementById('pod-compare-btn');
  const podScoreStepEl = document.getElementById('pod-score-step');
  const podScoreCritiqueEl = document.getElementById('pod-score-critique');
  const podScoreCompareEl = document.getElementById('pod-score-compare');
  const podScoreTotalEl = document.getElementById('pod-score-total');
  const podStepChipEls = Array.from(document.querySelectorAll('[data-pod-step]'));
  const AGENT_RENDER_RADIUS = 5;
  const AGENT_HIT_RADIUS = 11;
  const TRAIL_MAX_POINTS = 10;
  const FLIGHT_TRAIL_MAX_POINTS = 24;
  const FLIGHT_TRACK_EXTRAPOLATION_MAX_MS = 20000;
  const FORWARD_VECTOR_LOOKAHEAD_SEC = 90;
  const FORWARD_VECTOR_MIN_SPEED_MPS = 15;
  const FORWARD_VECTOR_MAX_DISTANCE_KM = 180;
  const GLOBE_FLIGHT_ARC_SEGMENTS = 18;
  const GLOBE_ORBIT_SEGMENTS = 48;
  const GLOBE_REGION_OUTLINE_MIN_Z = 0.02;
  const GLOBE_ENTITY_MIN_Z = 0.03;
  const GLOBE_FLIGHT_MIN_Z = -1;
  const GLOBE_PATH_MIN_Z = 0.01;
  const GLOBE_CONTINENT_MIN_Z = -1;
  const GLOBE_DISABLE_VISIBILITY_CULLING = true; // temporary: verify render path while debugging
  const FORCE_RENDER_ALL_OPENSKY_FLIGHTS = true; // debug: render all fetched OpenSky flights globally
  const HIDE_GRID_REGIONS_ON_GLOBE = true;

  if (USE_CESIUM) {
    canvas.style.display = 'none';
    canvas.style.pointerEvents = 'none';
  }

  const GLOBE_OVERLAY_DEBUG = false;
  const GLOBE_DEBUG_LOG_INTERVAL_MS = 1500;
  const SNAPSHOT_BASE_INTERVAL_MS = 4000;
  const podState = {
    aiUnlocked: false,
    compared: false,
  };

  function getStructuredCritiqueCount() {
    return [podVerifyWrongEl, podVerifyMissingEl, podVerifyChangeEl]
      .filter((el) => el && el.value.trim().length > 0).length;
  }

  function getPodCurrentStep() {
    if (!podState.aiUnlocked) return 1;
    if (getStructuredCritiqueCount() < 3) return 3;
    if (!podState.compared) return 4;
    return 4;
  }

  function syncPodRunCoachUI() {
    const hasUserAnswer = podUserAnswerEl.value.trim().length > 0;
    const critiqueCount = getStructuredCritiqueCount();
    const hasAiText = podAiOutputEl.value.trim().length > 0;
    podUnlockAiBtnEl.disabled = !hasUserAnswer || podState.aiUnlocked;
    podAiOutputEl.disabled = !podState.aiUnlocked;
    podVerifyWrongEl.disabled = !podState.aiUnlocked;
    podVerifyMissingEl.disabled = !podState.aiUnlocked;
    podVerifyChangeEl.disabled = !podState.aiUnlocked;
    podCompareBoxEl.hidden = !(podState.aiUnlocked && critiqueCount === 3 && hasAiText);
    podCompareBtnEl.disabled = !(podState.aiUnlocked && critiqueCount === 3 && hasAiText) || podState.compared;

    podAiLockEl.textContent = podState.aiUnlocked
      ? 'AI unlocked — now verify and compare before completion.'
      : 'AI locked — submit your first answer to unlock.';
    podAiLockEl.classList.toggle('unlocked', podState.aiUnlocked);

    const currentStep = getPodCurrentStep();
    podScoreStepEl.textContent = String(currentStep) + ' / 4';
    podScoreCritiqueEl.textContent = String(critiqueCount) + ' / 3';
    podScoreCompareEl.textContent = podState.compared ? 'Yes' : 'No';
    const totalScore = (podState.aiUnlocked ? 30 : 0) + (critiqueCount * 20) + (podState.compared ? 10 : 0);
    podScoreTotalEl.textContent = String(totalScore);

    podStepChipEls.forEach((chip) => {
      const stepNum = Number(chip.getAttribute('data-pod-step'));
      chip.classList.toggle('active', stepNum === currentStep);
      chip.classList.toggle('done', stepNum < currentStep || (stepNum === 4 && podState.compared));
    });
  }

  podUnlockAiBtnEl.addEventListener('click', () => {
    if (podState.aiUnlocked || podUserAnswerEl.value.trim().length === 0) return;
    podState.aiUnlocked = true;
    podAiOutputEl.value = 'AI suggestion: tighten your thesis, include one counterpoint, and make your next step explicit.';
    podAiLockEl.classList.add('flash');
    window.setTimeout(() => podAiLockEl.classList.remove('flash'), 900);
    syncPodRunCoachUI();
  });

  podCompareBtnEl.addEventListener('click', () => {
    if (!podState.aiUnlocked || getStructuredCritiqueCount() < 3) return;
    podState.compared = true;
    syncPodRunCoachUI();
  });

  [podUserAnswerEl, podAiOutputEl, podVerifyWrongEl, podVerifyMissingEl, podVerifyChangeEl].forEach((el) => {
    el.addEventListener('input', () => {
      if (el === podUserAnswerEl && podState.compared) podState.compared = false;
      syncPodRunCoachUI();
    });
  });
  syncPodRunCoachUI();
  const VIEWPORT_ZOOM_MIN = 0.5;
  const VIEWPORT_ZOOM_MAX = 3;
  const VIEWPORT_ZOOM_STEP = 0.2;
  const VIEWPORT_PAN_STEP = 36;
  const CAMERA_LERP_FACTOR = 0.18;
  const CAMERA_EPSILON_PX = 0.6;
  const CESIUM_PICK_RADIUS_PX = 18;
  const CESIUM_FOLLOW_LERP = 0.16;
  const CESIUM_FOCUS_LERP = 0.24;
  const STREET_LEVEL_ALTITUDE_M = 60;
  const STREET_LEVEL_PITCH_DEG = -10;
  const STREET_LEVEL_AUTO_TILT_ALT = 250;
  const REGION_ACTIVITY_WINDOW_TICKS = 24;
  const REGION_ACTIVE_EVENT_THRESHOLD = 2;
  const REGION_HOT_EVENT_THRESHOLD = 5;
  const REGION_ACTIVE_MOVEMENT_THRESHOLD = 2;
  const REGION_HOT_MOVEMENT_THRESHOLD = 5;
  let state = { agents: {}, regions: {}, tick: 0, started: null };
  let eventLog = [];
  let previousAgentsById = {};
  let agentTrails = {};
  let flightTrackingById = {};
  let selectedAgentId = null;
  let selectedRegionId = null;
  let selectedTargetCoords = null;
  let latestSelectedEvent = null;
  let ws, wsRetryDelay = 1000;
  let showAgents = true;
  let showRegions = true;
  let showTrails = true;
  let visibleEntityTypes = { agent: true, flight: true, satellite: true, other: true };
  const layerState = {
    liveFlights:     true,   // OpenSky API + file source
    militaryFlights: false,  // UNAVAILABLE — no data source wired
    earthquakes:     false,  // UNAVAILABLE — no data source wired
    satellites:      true,   // Celestrak / TLE
    traffic:         false,  // UNAVAILABLE — incompatible with Cesium 3D Tiles renderer
    weather:         false,  // UNAVAILABLE — stub only, not configured
    cctvMesh:        false,  // UNAVAILABLE — no data source wired
    bikeshare:       false,  // UNAVAILABLE — no data source wired
    regions:         true,   // region overlay
  };
  // Which layers have a real data pipeline (others show UNAVAILABLE and cannot be toggled)
  const LAYER_AVAILABLE = {
    liveFlights: true, militaryFlights: false, earthquakes: false,
    satellites: true,  traffic: false, weather: false, cctvMesh: false, bikeshare: false,
  };
  let paused = false;
  let simulationSpeed = 1;
  let snapshotQueue = [];
  let lastSnapshotApplyAt = 0;
  let flaggedTargets = {};
  let lastOperatorActionByTarget = {};
  let focusTargetKey = null;
  let focusEffectUntil = 0;
  let eventSearchQuery = '';
  let activeEventFilter = 'all';
  let styleMode = 'crt';
  const STYLE_PRESETS = {
    tactical:     { bloom: 20, sharpen: 30, noise: 18, vignette: 50, pixelation: 14, glow: 18 },
    surveillance: { bloom: 14, sharpen: 52, noise: 12, vignette: 60, pixelation: 20, glow: 10 },
    cinematic:    { bloom: 38, sharpen: 18, noise: 28, vignette: 68, pixelation: 10, glow: 32 },
    minimal:      { bloom: 6,  sharpen: 32, noise: 4,  vignette: 30, pixelation: 4,  glow: 6  },
  };
  let activeStylePreset = 'tactical';
  let styleFx = { ...STYLE_PRESETS.tactical };
  let viewport = { zoom: 1, offsetX: 0, offsetY: 0 };
  let followTargetEnabled = false;
  let cameraLerpTarget = null;
  let cesiumCameraLerpState = null;
  let cesiumCameraMoveInternal = false;
  let cesiumFollowDisengageMutedUntil = 0;
  let latestRegionIntelligence = {};
  let lastGlobeDebugLogAt = 0;
  let styleAnimationLoopActive = false;
  let globeOverlayDiagnostics = null;
  let globeRegionOverlaySuppressed = false;
  const OPENSKY_STATUS_DEFAULTS = { enabled: false, authConfigured: false, fetched: 0, normalized: 0, merged: 0, lastPollAt: null, lastErrorAt: null, pollingRunning: false, lastRequestUrl: null, lastRequestStatus: null, authMode: 'none', hasClientId: false, hasClientSecret: false, lastFetchStatus: 'none', lastFetchError: 'none' };
  let openskyStatus = Object.assign({}, OPENSKY_STATUS_DEFAULTS);
  let lastFlightDebugCounts = { merged: 0, visible: 0, drawn: 0, errors: 0 };
  let lastLayerDiagnostics = {};
  let apiFetchedFlights = {};   // normalized flights keyed by id, populated by fetchFlights()
  let lastApiFetchedCount = 0;  // raw states.length from last /api/flights call
  // per-layer last-update timestamps (ms since epoch, null = never fetched yet)
  const layerLastUpdated = {
    liveFlights: null,
    satellites:  null,
  };

  // ── Layer UI helpers ──────────────────────────────────────────────────────
  function timeSinceStr(tsMs) {
    if (!tsMs) return '—';
    const secs = Math.floor((Date.now() - tsMs) / 1000);
    if (secs < 10) return 'just now';
    if (secs < 60) return secs + 's ago';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    return Math.floor(mins / 60) + 'h ago';
  }

  function setLayerStatus(key, text) {
    const el = document.getElementById('layer-status-' + key);
    if (el) el.textContent = text;
  }

  function setLayerOn(key, on) {
    if (key in LAYER_AVAILABLE && !LAYER_AVAILABLE[key]) return; // can't toggle unavailable
    layerState[key] = on;
    const btn = document.getElementById('toggle-layer-' + key);
    if (btn) {
      btn.textContent = on ? 'ON' : 'OFF';
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('active', on);
    }
    const row = btn ? btn.closest('.layer-row') : null;
    if (row) row.classList.toggle('on', on);
    if (!on) setLayerStatus(key, 'paused');
  }

  // ── Panel / drawer state ──────────────────────────────────────────────────
  let activePanelId = null;
  let activeRightTab = 'target';

  function openPanel(id) {
    if (activePanelId === id) { closePanel(); return; }
    closePanel();
    activePanelId = id;
    const drawerId = (id === 'target' || id === 'stats') ? 'drawer-right' : 'drawer-' + id;
    const drawerEl = document.getElementById(drawerId);
    if (drawerEl) drawerEl.classList.add('open');
    if (id === 'target') switchRightTab('target');
    if (id === 'stats') switchRightTab('stats');
    document.querySelectorAll('.rail-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.panel === id);
    });
  }

  function closePanel() {
    if (!activePanelId) return;
    const drawerId = (activePanelId === 'target' || activePanelId === 'stats') ? 'drawer-right' : 'drawer-' + activePanelId;
    const drawerEl = document.getElementById(drawerId);
    if (drawerEl) drawerEl.classList.remove('open');
    document.querySelectorAll('.rail-btn').forEach(function (b) { b.classList.remove('active'); });
    activePanelId = null;
  }

  function switchRightTab(tab) {
    activeRightTab = tab;
    document.querySelectorAll('.dtab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const targetContent = document.getElementById('rtab-target');
    const statsContent  = document.getElementById('rtab-stats');
    if (targetContent) targetContent.classList.toggle('hidden', tab !== 'target');
    if (statsContent)  statsContent.classList.toggle('hidden', tab !== 'stats');
  }

  const TYPE_STYLE = {
    agent: { fill: '#7cc4ff', stroke: '#abd8ff', trail: '#7cc4ff55', trailSelected: '#bfe4ffcc' },
    flight: { fill: '#ffb77d', stroke: '#ffd2ad', trail: '#ffb77d55', trailSelected: '#ffe0c4cc' },
    satellite: { fill: '#d0a3ff', stroke: '#e2c7ff', trail: '#d0a3ff55', trailSelected: '#ecdfffcc' },
    other: { fill: '#8ea0b4', stroke: '#bac7d6', trail: '#8ea0b455', trailSelected: '#d6deebcc' },
  };
  const TYPE_STYLE_BY_MODE = {
    crt: {
      agent: { fill: '#8fd6ff', stroke: '#c5e9ff', trail: '#8fd6ff57', trailSelected: '#d4efffcc' },
      flight: { fill: '#ffc38f', stroke: '#ffe2bd', trail: '#ffc38f57', trailSelected: '#ffedd6cc' },
      satellite: { fill: '#d6b2ff', stroke: '#ead7ff', trail: '#d6b2ff57', trailSelected: '#f0e6ffcc' },
      other: { fill: '#93a6b8', stroke: '#c2cfdb', trail: '#93a6b857', trailSelected: '#dde4ebcc' },
    },
    nvg: {
      agent: { fill: '#93ff79', stroke: '#d5ffc5', trail: '#93ff7958', trailSelected: '#e7ffd9d9' },
      flight: { fill: '#bcff70', stroke: '#e2ffc7', trail: '#bcff7052', trailSelected: '#f0ffd9d2' },
      satellite: { fill: '#75ff95', stroke: '#c7ffd7', trail: '#75ff954c', trailSelected: '#e1ffe8d0' },
      other: { fill: '#6cb484', stroke: '#bde6c8', trail: '#6cb4844f', trailSelected: '#d9efe0c6' },
    },
    flir: {
      agent: { fill: '#ffe88f', stroke: '#fff5c5', trail: '#ffe88f66', trailSelected: '#fff9dddb' },
      flight: { fill: '#ff9348', stroke: '#ffbb8d', trail: '#ff934866', trailSelected: '#ffd4b8db' },
      satellite: { fill: '#ff5f62', stroke: '#ff9b9d', trail: '#ff5f6266', trailSelected: '#ffc5c7db' },
      other: { fill: '#5c5474', stroke: '#9f94c8', trail: '#5c54745a', trailSelected: '#c8c0e2c9' },
    },
  };

  const GLOBE_CONTINENT_OUTLINES = [
    // North America
    [
      { lat: 72, lng: -168 }, { lat: 70, lng: -150 }, { lat: 66, lng: -135 }, { lat: 60, lng: -125 },
      { lat: 52, lng: -128 }, { lat: 48, lng: -124 }, { lat: 43, lng: -124 }, { lat: 36, lng: -120 },
      { lat: 30, lng: -112 }, { lat: 24, lng: -106 }, { lat: 18, lng: -95 }, { lat: 16, lng: -84 },
      { lat: 21, lng: -80 }, { lat: 26, lng: -82 }, { lat: 31, lng: -79 }, { lat: 37, lng: -75 },
      { lat: 45, lng: -66 }, { lat: 52, lng: -60 }, { lat: 59, lng: -64 }, { lat: 66, lng: -78 },
      { lat: 72, lng: -95 }, { lat: 74, lng: -120 }, { lat: 72, lng: -168 },
    ],
    // South America
    [
      { lat: 12, lng: -81 }, { lat: 8, lng: -76 }, { lat: 2, lng: -79 }, { lat: -8, lng: -78 },
      { lat: -18, lng: -75 }, { lat: -27, lng: -71 }, { lat: -35, lng: -71 }, { lat: -44, lng: -72 },
      { lat: -54, lng: -68 }, { lat: -55, lng: -63 }, { lat: -50, lng: -58 }, { lat: -42, lng: -53 },
      { lat: -30, lng: -49 }, { lat: -18, lng: -44 }, { lat: -8, lng: -38 }, { lat: 2, lng: -45 },
      { lat: 8, lng: -54 }, { lat: 12, lng: -64 }, { lat: 12, lng: -81 },
    ],
    // Eurasia
    [
      { lat: 71, lng: -10 }, { lat: 70, lng: 12 }, { lat: 67, lng: 30 }, { lat: 64, lng: 50 },
      { lat: 68, lng: 80 }, { lat: 72, lng: 110 }, { lat: 72, lng: 145 }, { lat: 66, lng: 165 },
      { lat: 58, lng: 168 }, { lat: 51, lng: 155 }, { lat: 45, lng: 144 }, { lat: 38, lng: 132 },
      { lat: 30, lng: 122 }, { lat: 22, lng: 114 }, { lat: 16, lng: 108 }, { lat: 10, lng: 104 },
      { lat: 7, lng: 98 }, { lat: 9, lng: 86 }, { lat: 16, lng: 74 }, { lat: 24, lng: 66 },
      { lat: 28, lng: 56 }, { lat: 27, lng: 46 }, { lat: 31, lng: 36 }, { lat: 36, lng: 28 },
      { lat: 43, lng: 20 }, { lat: 49, lng: 10 }, { lat: 56, lng: 2 }, { lat: 62, lng: -2 },
      { lat: 67, lng: -8 }, { lat: 71, lng: -10 },
    ],
    // Africa
    [
      { lat: 37, lng: -17 }, { lat: 32, lng: -8 }, { lat: 30, lng: 3 }, { lat: 31, lng: 16 },
      { lat: 31, lng: 28 }, { lat: 24, lng: 35 }, { lat: 14, lng: 43 }, { lat: 4, lng: 44 },
      { lat: -8, lng: 41 }, { lat: -18, lng: 36 }, { lat: -30, lng: 31 }, { lat: -34, lng: 20 },
      { lat: -35, lng: 11 }, { lat: -30, lng: 5 }, { lat: -20, lng: 2 }, { lat: -5, lng: 9 },
      { lat: 8, lng: 1 }, { lat: 15, lng: -5 }, { lat: 24, lng: -15 }, { lat: 32, lng: -17 },
      { lat: 37, lng: -17 },
    ],
    // Australia
    [
      { lat: -10, lng: 113 }, { lat: -16, lng: 121 }, { lat: -20, lng: 132 }, { lat: -27, lng: 139 },
      { lat: -35, lng: 146 }, { lat: -39, lng: 149 }, { lat: -42, lng: 145 }, { lat: -38, lng: 136 },
      { lat: -34, lng: 126 }, { lat: -25, lng: 116 }, { lat: -15, lng: 113 }, { lat: -10, lng: 113 },
    ],
    // Greenland
    [
      { lat: 82, lng: -73 }, { lat: 78, lng: -44 }, { lat: 72, lng: -24 }, { lat: 66, lng: -20 },
      { lat: 60, lng: -34 }, { lat: 61, lng: -48 }, { lat: 66, lng: -54 }, { lat: 73, lng: -60 },
      { lat: 79, lng: -66 }, { lat: 82, lng: -73 },
    ],
  ];

  // ── Canvas resize ──
  function resize() {
    const wrap = canvas.parentElement;
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    if (cesiumViewer) {
      cesiumViewer.resize();
    }
    draw();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Draw ──
  function draw() {
    const W = canvas.width, H = canvas.height;
    const cameraUpdated = updateCameraMotion(W, H);
    const now = Date.now();
    if (USE_CESIUM) {
      syncCesiumScene(now);
      updateViewportReadout();
      if (cameraUpdated && (followTargetEnabled || cameraLerpTarget)) requestAnimationFrame(draw);
      return;
    }
    ctx.clearRect(0, 0, W, H);
    const globeDebug = isGlobeRenderMode()
      ? {
          projected: 0,
          skipped: 0,
          entitiesVisible: 0,
          regionsVisible: 0,
          trailsVisible: 0,
          pathSegmentsDrawn: 0,
          zMin: Infinity,
          zMax: -Infinity,
          invalidProjected: 0,
          entitiesUsingLatLng: 0,
          entitiesUsingGrid: 0,
        }
      : null;

    renderBaseSurface(W, H);
    renderWorldOverlays(W, H, now, globeDebug);
    if (isGlobeRenderMode()) updateViewportReadout();

    // tick label
    ctx.fillStyle = '#222';
    ctx.font = '11px monospace';
    ctx.fillText('tick ' + state.tick, 8, H - 8);

    if (cameraUpdated && (followTargetEnabled || cameraLerpTarget)) {
      requestAnimationFrame(draw);
    }
  }

  function styleTuningByMode(mode) {
    if (mode === 'nvg') return { tint: 'rgba(32, 255, 96, 0.34)', sat: 0.38, hue: 76, baseBright: 0.95, baseContrast: 1.44, scanline: 0.06, vignetteBoost: 0.22, overlayBlend: 'screen' };
    if (mode === 'flir') return { tint: 'linear-gradient(155deg, rgba(14,18,34,.78) 0%, rgba(61,31,83,.42) 42%, rgba(255,106,42,.36) 84%, rgba(255,226,149,.24) 100%)', sat: 1.78, hue: -18, baseBright: 0.88, baseContrast: 1.52, scanline: 0.02, vignetteBoost: 0.18, overlayBlend: 'hard-light' };
    return { tint: 'rgba(126, 211, 255, 0.18)', sat: 0.78, hue: -6, baseBright: 0.97, baseContrast: 1.18, scanline: 0.26, vignetteBoost: 0.15, overlayBlend: 'screen' };
  }

  function updateTelemetryBar() {
    const now = new Date();
    telemetryUtcEl.textContent = now.toISOString().slice(11, 19);
    telemetryModeEl.textContent = styleMode.toUpperCase();
    telemetryRecEl.classList.toggle('live', !paused);
    const anchor = (selectedAgentId && state.agents[selectedAgentId]) || Object.values(state.agents || {})[0] || null;
    const point = anchor ? getAgentBasePoint(anchor) : null;
    telemetryCoordsEl.textContent = point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
      ? (point.lat.toFixed(3) + ', ' + point.lng.toFixed(3))
      : '--.--, --.--';
  }

  function syncPresetUi() {
    for (const btn of presetButtons) {
      btn.classList.toggle('active', btn.dataset.stylePreset === activeStylePreset);
    }
  }

  function applyTypeStyleByMode(mode) {
    const modeStyles = TYPE_STYLE_BY_MODE[mode] || TYPE_STYLE_BY_MODE.crt;
    for (const key of Object.keys(TYPE_STYLE)) {
      if (!modeStyles[key]) continue;
      TYPE_STYLE[key] = { ...modeStyles[key] };
    }
  }

  function setStylePreset(name, silent) {
    if (!Object.prototype.hasOwnProperty.call(STYLE_PRESETS, name)) return;
    activeStylePreset = name;
    styleFx = { ...STYLE_PRESETS[name] };
    fxBloomEl.value = String(styleFx.bloom);
    fxSharpenEl.value = String(styleFx.sharpen);
    fxNoiseEl.value = String(styleFx.noise);
    fxVignetteEl.value = String(styleFx.vignette);
    fxPixelationEl.value = String(styleFx.pixelation);
    fxGlowEl.value = String(styleFx.glow);
    syncPresetUi();
    applyVisualStyle();
    if (!silent) pushOperatorEvent('operator style preset set to ' + name);
  }

  function applyVisualStyle() {
    const tuning = styleTuningByMode(styleMode);
    const bloomPx = (styleFx.bloom / 100) * 4.2;
    const sharpenEmphasis = 1 + ((styleFx.sharpen / 100) * 0.45);
    const glowStrength = styleFx.glow / 100;
    const brightness = tuning.baseBright + glowStrength * 0.16 + (styleFx.bloom / 100) * 0.08;
    const contrast = tuning.baseContrast + (styleFx.sharpen / 100) * 0.22;
    const saturate = Math.max(0.2, tuning.sat + (glowStrength * 0.22));
    const hueRotate = tuning.hue;
    const flicker = (styleMode === 'crt')
      ? ((Math.sin(Date.now() / 780) + 1) / 2) * 0.06
      : (styleMode === 'nvg' ? 0.02 : 0.01);

    document.body.setAttribute('data-style-mode', styleMode);
    applyTypeStyleByMode(styleMode);
    styleIndicatorEl.textContent = 'mode: ' + styleMode;
    styleIndicatorEl.style.boxShadow = '0 0 ' + (6 + glowStrength * 12).toFixed(1) + 'px rgba(120,255,220,' + (0.12 + glowStrength * 0.22).toFixed(2) + ')';
    const sceneFilter = 'brightness(' + (brightness + flicker).toFixed(3) + ') contrast(' + contrast.toFixed(3) + ') saturate(' + saturate.toFixed(3) + ') hue-rotate(' + hueRotate.toFixed(1) + 'deg)';
    const bloomColor = styleMode === 'nvg'
      ? 'rgba(114,255,141,' + (0.1 + glowStrength * 0.28).toFixed(2) + ')'
      : (styleMode === 'flir'
        ? 'rgba(255,164,89,' + (0.1 + glowStrength * 0.24).toFixed(2) + ')'
        : 'rgba(160,255,220,' + (0.08 + glowStrength * 0.2).toFixed(2) + ')');
    cesiumContainer.style.filter = sceneFilter + ' drop-shadow(0 0 ' + bloomPx.toFixed(2) + 'px ' + bloomColor + ')';
    canvas.style.filter = sceneFilter;

    const scan = fxOverlayEl.querySelector('.scanlines');
    const noise = fxOverlayEl.querySelector('.noise');
    const vignette = fxOverlayEl.querySelector('.vignette');
    const pixel = fxOverlayEl.querySelector('.pixel-grid');
    fxOverlayEl.style.background = tuning.tint.startsWith('linear-gradient')
      ? tuning.tint
      : ('linear-gradient(120deg, transparent 0%, ' + tuning.tint + ' 100%)');
    fxOverlayEl.style.mixBlendMode = tuning.overlayBlend;
    fxOverlayEl.style.opacity = (0.24 + glowStrength * 0.42 + flicker).toFixed(3);
    scan.style.opacity = (tuning.scanline + (styleFx.bloom / 100) * 0.08 + flicker * 0.5).toFixed(3);
    scan.style.backgroundSize = '100% ' + (styleMode === 'crt' ? '2px' : '3px');
    noise.style.opacity = (styleFx.noise / 100 * (styleMode === 'flir' ? 0.28 : 0.34)).toFixed(3);
    noise.style.filter = 'blur(' + ((100 - styleFx.sharpen) / 100 * 0.8).toFixed(2) + 'px)';
    vignette.style.opacity = Math.min(0.95, (styleFx.vignette / 100 * 0.82) + tuning.vignetteBoost).toFixed(3);
    vignette.style.background = styleMode === 'flir'
      ? 'radial-gradient(circle at center, rgba(0,0,0,.05) 38%, rgba(0,0,0,.78) 100%)'
      : 'radial-gradient(circle at center, transparent 45%, rgba(0,0,0,.62) 100%)';
    const pixelSize = (4 + (styleFx.pixelation / 100) * 18).toFixed(1) + 'px';
    pixel.style.backgroundSize = pixelSize + ' ' + pixelSize;
    pixel.style.opacity = (styleFx.pixelation / 100 * (activeStylePreset === 'minimal' ? 0.08 : 0.2)).toFixed(3);

    // lightweight faux sharpen by balancing global contrast without replacing renderer.
    document.documentElement.style.setProperty('--rw-sharpen-emphasis', sharpenEmphasis.toFixed(3));
    updateTelemetryBar();
  }

  function ensureStyleAnimationLoop() {
    if (styleAnimationLoopActive) return;
    styleAnimationLoopActive = true;
    function tickStyleAnimation() {
      applyVisualStyle();
      requestAnimationFrame(tickStyleAnimation);
    }
    requestAnimationFrame(tickStyleAnimation);
  }

  function getRegionPaletteByMode(status, isSelected) {
    if (styleMode === 'flir') {
      if (status === 'HOT') return { stroke: '#ffb36bcc', strokeBold: '#ffd49fcc', fill: isSelected ? '#ff9b4a3a' : '#ff9b4a1f', label: '#ffd18e' };
      if (status === 'ACTIVE') return { stroke: '#c482ffbb', strokeBold: '#d7a7ffcc', fill: isSelected ? '#8a5dca36' : '#8a5dca1e', label: '#e4c4ff' };
      return { stroke: '#625b84aa', strokeBold: '#857ca7bb', fill: isSelected ? '#47405f38' : '#47405f20', label: '#a9a0cc' };
    }
    if (styleMode === 'nvg') {
      if (status === 'HOT') return { stroke: '#c8ff8ecc', strokeBold: '#deffacdd', fill: isSelected ? '#8cd8632f' : '#8cd8631b', label: '#dbffb6' };
      if (status === 'ACTIVE') return { stroke: '#97ff84cc', strokeBold: '#b8ff9edd', fill: isSelected ? '#74cb6430' : '#74cb641a', label: '#c9ffb2' };
      return { stroke: '#85b89499', strokeBold: '#9ccfabaa', fill: isSelected ? '#5b7f6730' : '#5b7f6718', label: '#b1dcbe' };
    }
    if (status === 'HOT') return { stroke: '#ff8e8ecc', strokeBold: '#ff9b9bcc', fill: isSelected ? '#ff8e8e26' : '#ff8e8e1d', label: '#ffc57f' };
    if (status === 'ACTIVE') return { stroke: '#fccb88cc', strokeBold: '#ffd293dd', fill: isSelected ? '#fccb8824' : '#fccb881b', label: '#ffc57f' };
    return { stroke: '#a8b0cc88', strokeBold: '#b8d2ffaa', fill: isSelected ? '#8ec5ff22' : '#8ec5ff14', label: '#ffc57f' };
  }

  function renderBaseSurface(width, height) {
    drawGlobeBase(width, height);
    drawGlobeContinents(width, height);
  }

  function isGlobeRenderMode() {
    return LEGACY_CANVAS_RENDERER;
  }

  async function initCesium() {
    if (!USE_CESIUM || typeof Cesium === 'undefined') return;
    if (BOOTSTRAP.cesiumAccessToken) Cesium.Ion.defaultAccessToken = BOOTSTRAP.cesiumAccessToken;
    // Build terrain provider: use Cesium World Terrain when Ion token available for realistic elevation
    let terrainProvider;
    if (BOOTSTRAP.cesiumAccessToken) {
      try {
        terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true, requestWaterMask: false });
        console.info('[RW Cesium] World Terrain loaded');
      } catch (terrainErr) {
        console.warn('[RW Cesium] World Terrain unavailable, using ellipsoid', terrainErr);
      }
    }
    cesiumViewer = new Cesium.Viewer('cesium-world', {
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
      navigationHelpButton: false, sceneModePicker: false, infoBox: false, selectionIndicator: false,
      shouldAnimate: true,
      terrainProvider: terrainProvider || new Cesium.EllipsoidTerrainProvider(),
    });
    // Immediately anchor the camera to a valid global view so the Earth fills the viewport
    // before any async tile loading; this prevents the camera from starting off-screen.
    cesiumViewer.trackedEntity = undefined;
    cesiumViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-95, 25, 20000000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    cesiumViewer.scene.skyBox.show = true;
    cesiumViewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#04050a');
    cesiumViewer.scene.globe.show = true;
    cesiumViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#080e1a');
    cesiumViewer.scene.globe.depthTestAgainstTerrain = true;
    cesiumViewer.scene.globe.enableLighting = false;
    cesiumViewer.scene.skyAtmosphere.show = true;
    cesiumViewer.scene.skyAtmosphere.atmosphereLightIntensity = 6.0;
    cesiumViewer.scene.sun.show = true;
    cesiumViewer.scene.moon.show = false;
    cesiumViewer.scene.requestRenderMode = false;
    // Camera controls: full orbit, tilt, zoom, and first-person look for street-level navigation
    const ssc = cesiumViewer.scene.screenSpaceCameraController;
    ssc.enableRotate = true;
    ssc.enableTilt   = true;
    ssc.enableZoom   = true;
    ssc.enableTranslate = true;
    ssc.enableLook   = true;
    ssc.minimumZoomDistance = 10;
    ssc.maximumZoomDistance = 40000000;
    try {
      if (BOOTSTRAP.googleMapsApiKey) {
        console.info('[RW Cesium] Google Photorealistic 3D Tiles request started');
        lastCesiumRenderCounts.tilesState = 'loading';
        lastCesiumRenderCounts.tilesError = null;
        const tileset = await Cesium.Cesium3DTileset.fromUrl(
          GOOGLE_TILESET_ROOT + '?key=' + encodeURIComponent(BOOTSTRAP.googleMapsApiKey)
        );
        cesiumViewer.scene.primitives.add(tileset);
        cesiumGoogleTileset = tileset;
        if (typeof tileset.readyPromise?.then === 'function') {
          tileset.readyPromise.then(function () {
            if (cesiumGoogleTileset === tileset) {
              console.info('[RW Cesium] Google Photorealistic 3D Tiles ready');
              lastCesiumRenderCounts.tilesLoaded = true;
              lastCesiumRenderCounts.tilesState = 'ok';
              lastCesiumRenderCounts.tilesError = null;
            }
          }).catch(function (err) {
            console.error('[RW Cesium] Google Photorealistic 3D Tiles readyPromise failed', err);
            lastCesiumRenderCounts.tilesLoaded = false;
            lastCesiumRenderCounts.tilesState = 'failed';
            lastCesiumRenderCounts.tilesError = (err && err.message) ? err.message : String(err || 'unknown');
          });
        }
        console.info('[RW Cesium] Google Photorealistic 3D Tiles loaded');
        lastCesiumRenderCounts.tilesLoaded = true;
        lastCesiumRenderCounts.tilesState = 'ok';
        lastCesiumRenderCounts.tilesError = null;
        cesiumViewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(-95, 25, 20000000),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        });
      } else {
        console.warn('[RW Cesium] No Google Maps API key — using built-in Natural Earth imagery');
        lastCesiumRenderCounts.tilesLoaded = false;
        lastCesiumRenderCounts.tilesState = 'no-key';
        lastCesiumRenderCounts.tilesError = null;
        // Natural Earth II ships bundled with CesiumJS — no API key, no network required
        try {
          const naturalEarth = await Cesium.TileMapServiceImageryProvider.fromUrl(
            Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
          );
          cesiumViewer.imageryLayers.removeAll();
          cesiumViewer.imageryLayers.addImageryProvider(naturalEarth);
        } catch (imgErr) {
          console.warn('[RW Cesium] Natural Earth fallback failed, keeping default imagery', imgErr);
        }
        cesiumViewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(-95, 25, 20000000),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        });
      }
      lastCesiumRenderCounts.earthInitialized = true;
      lastCesiumRenderCounts.tilesLoaded = !!cesiumGoogleTileset;
      console.info('[RW Cesium] initialized');
      const _cp = cesiumViewer.camera.positionCartographic;
      console.info('[RW Cesium] camera init: lat=' + Cesium.Math.toDegrees(_cp.latitude).toFixed(2) + ' lng=' + Cesium.Math.toDegrees(_cp.longitude).toFixed(2) + ' alt=' + (_cp.height / 1000).toFixed(0) + 'km pitch=' + Cesium.Math.toDegrees(cesiumViewer.camera.pitch).toFixed(1) + 'deg');
    } catch (err) {
      console.error('[RW Cesium] init failed', err);
      lastCesiumRenderCounts.tilesLoaded = false;
      lastCesiumRenderCounts.tilesState = 'failed';
      lastCesiumRenderCounts.tilesError = (err && err.message) ? err.message : String(err || 'unknown');
    }
    // OSM Buildings: adds 3D building geometry when Cesium Ion token available
    if (BOOTSTRAP.cesiumAccessToken) {
      try {
        const osmBuildings = await Cesium.createOsmBuildingsAsync();
        cesiumViewer.scene.primitives.add(osmBuildings);
        console.info('[RW Cesium] OSM Buildings loaded');
      } catch (osmErr) {
        console.warn('[RW Cesium] OSM Buildings unavailable', osmErr);
      }
    }
    // Auto-tilt: when user finishes zooming below STREET_LEVEL_AUTO_TILT_ALT and camera
    // is pointing near-nadir, smoothly pitch forward for a human-perspective ground view
    cesiumViewer.camera.moveEnd.addEventListener(function () {
      if (cesiumCameraMoveInternal || cesiumStreetLevelMode) return;
      const alt = cesiumViewer.camera.positionCartographic.height;
      if (alt < STREET_LEVEL_AUTO_TILT_ALT && cesiumViewer.camera.pitch < Cesium.Math.toRadians(-60)) {
        cesiumCameraMoveInternal = true;
        cesiumFollowDisengageMutedUntil = Date.now() + 1500;
        cesiumViewer.camera.flyTo({
          destination: cesiumViewer.camera.position,
          orientation: {
            heading: cesiumViewer.camera.heading,
            pitch: Cesium.Math.toRadians(STREET_LEVEL_PITCH_DEG),
            roll: 0,
          },
          duration: 0.8,
          complete: function () { cesiumCameraMoveInternal = false; },
          cancel:   function () { cesiumCameraMoveInternal = false; },
        });
      }
    });
    bindCesiumSelection();
    cesiumViewer.resize();
    draw();
  }

  function bindCesiumSelection() {
    if (!cesiumViewer || cesiumSelectionHandler) return;
    cesiumSelectionHandler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
    cesiumSelectionHandler.setInputAction(function (click) {
      const meta = pickCesiumTarget(click.position);
      if (meta) {
        if (meta.kind === 'agent') { selectAgent(meta.id); return; }
        if (meta.kind === 'region') { selectRegion(meta.id); return; }
      }
      selectAgent(null);
      selectRegion(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    if (cesiumViewer && cesiumViewer.camera) {
      cesiumViewer.camera.moveStart.addEventListener(function () {
        if (!followTargetEnabled) return;
        if (Date.now() < cesiumFollowDisengageMutedUntil) return;
        if (cesiumCameraMoveInternal) return;
        disableFollowTarget('manual camera control');
      });
    }
  }

  function pickCesiumTarget(clickPosition) {
    if (!cesiumViewer || !clickPosition) return null;
    const picks = cesiumViewer.scene.drillPick(clickPosition, 10) || [];
    for (const picked of picks) {
      if (picked && picked.id && picked.id.rwMeta) return picked.id.rwMeta;
    }
    let nearest = null;
    let nearestDistSq = Infinity;
    const refs = [
      ...Object.values(cesiumEntityRefs.agents || {}),
      ...Object.values(cesiumEntityRefs.regions || {}),
    ];
    for (const ref of refs) {
      if (!ref || !ref.position || !ref.rwMeta) continue;
      const pos = Cesium.Property.getValueOrUndefined(ref.position, cesiumViewer.clock.currentTime);
      if (!pos) continue;
      const canvasPos = Cesium.SceneTransforms.wgs84ToWindowCoordinates(cesiumViewer.scene, pos);
      if (!canvasPos) continue;
      const dx = clickPosition.x - canvasPos.x;
      const dy = clickPosition.y - canvasPos.y;
      const distSq = (dx * dx) + (dy * dy);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = ref.rwMeta;
      }
    }
    return nearestDistSq <= (CESIUM_PICK_RADIUS_PX * CESIUM_PICK_RADIUS_PX) ? nearest : null;
  }

  // ── Cesium street-level navigation helpers ──────────────────────────────────
  // loadGoogleMapsApi — replaced by Cesium street-level; kept as a compat stub
  // so existing callers (openStreetLevelTab, slNavigateTo) continue to work.
  function loadGoogleMapsApi(apiKey, callback) {
    // Google Maps Street View replaced by Cesium street-level navigation.
    // Invoke callback immediately so callers proceed with Cesium-based init.
    if (typeof callback === 'function') callback();
  }

  // initStreetView — fly Cesium camera to street-level at the given coordinates
  function initStreetView(lat, lng) {
    if (!cesiumViewer) return;
    enterCesiumStreetLevel(lat, lng);
  }

  // showStreetView — enter Cesium street-level mode and show the HUD overlay
  function showStreetView(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!cesiumViewer) return;
    const streetViewEl = document.getElementById('street-view');
    if (!streetViewEl) return;
    initStreetView(lat, lng);
    streetViewEl.style.display = 'block';
    requestAnimationFrame(function () {
      streetViewEl.classList.add('visible');
    });
    streetViewVisible = true;
  }

  // hideStreetView — exit Cesium street-level mode and hide the HUD overlay
  function hideStreetView() {
    const streetViewEl = document.getElementById('street-view');
    if (!streetViewEl) return;
    streetViewEl.classList.remove('visible');
    streetViewVisible = false;
    exitCesiumStreetLevel();
    streetViewEl.addEventListener('transitionend', function () {
      if (!streetViewVisible) streetViewEl.style.display = 'none';
    }, { once: true });
  }

  const streetViewCloseBtn = document.getElementById('street-view-close');
  if (streetViewCloseBtn) {
    streetViewCloseBtn.addEventListener('click', function () {
      hideStreetView();
    });
  }

  // ── Street-level tab — Cesium-powered ground-mode view ───────────────────────
  // initStreetLevelPanorama — fly Cesium to street-level at the given coords
  function initStreetLevelPanorama(lat, lng) {
    if (!cesiumViewer) return;
    enterCesiumStreetLevel(lat, lng);
  }

  function openStreetLevelTab() {
    const globeShell = document.getElementById('globe-shell');
    const streetLevelView = document.getElementById('street-level-view');
    const noTargetEl = document.getElementById('street-level-no-target');
    const panoEl = document.getElementById('street-level-pano');
    const targetLabelEl = document.getElementById('street-level-target-label');
    const tabBtn = document.getElementById('street-level-tab');
    const railBtn = document.getElementById('rail-btn-street-level');
    if (!streetLevelView) return;
    // Keep globe-shell visible so Cesium renders through the transparent overlay
    if (globeShell) globeShell.style.display = '';
    streetLevelView.classList.add('active');
    streetLevelActive = true;
    if (tabBtn) { tabBtn.classList.add('active'); tabBtn.setAttribute('aria-pressed', 'true'); }
    if (railBtn) { railBtn.classList.add('active'); railBtn.setAttribute('aria-pressed', 'true'); }
    startSlMonitor();
    if (selectedTargetCoords) {
      if (noTargetEl) noTargetEl.style.display = 'none';
      if (panoEl) panoEl.classList.add('visible');
      if (targetLabelEl) {
        targetLabelEl.textContent = selectedTargetCoords.lat.toFixed(4) + ', ' + selectedTargetCoords.lng.toFixed(4);
      }
      loadGoogleMapsApi(BOOTSTRAP.googleMapsApiKey, function () {
        initStreetLevelPanorama(selectedTargetCoords.lat, selectedTargetCoords.lng);
      });
    } else {
      if (noTargetEl) noTargetEl.style.display = 'flex';
      if (panoEl) panoEl.classList.remove('visible');
      if (targetLabelEl) targetLabelEl.textContent = '';
    }
  }

  function closeStreetLevelTab() {
    const globeShell = document.getElementById('globe-shell');
    const streetLevelView = document.getElementById('street-level-view');
    const tabBtn = document.getElementById('street-level-tab');
    const railBtn = document.getElementById('rail-btn-street-level');
    if (streetLevelView) streetLevelView.classList.remove('active');
    if (globeShell) globeShell.style.display = '';
    streetLevelActive = false;
    exitCesiumStreetLevel();
    stopSlMonitor();
    if (tabBtn) { tabBtn.classList.remove('active'); tabBtn.setAttribute('aria-pressed', 'false'); }
    if (railBtn) { railBtn.classList.remove('active'); railBtn.setAttribute('aria-pressed', 'false'); }
  }

  const streetLevelTabBtn = document.getElementById('street-level-tab');
  if (streetLevelTabBtn) {
    streetLevelTabBtn.addEventListener('click', openStreetLevelTab);
  }

  const streetLevelRailBtn = document.getElementById('rail-btn-street-level');
  if (streetLevelRailBtn) {
    streetLevelRailBtn.addEventListener('click', openStreetLevelTab);
  }

  const streetLevelBackBtn = document.getElementById('street-level-back-btn');
  if (streetLevelBackBtn) {
    streetLevelBackBtn.addEventListener('click', closeStreetLevelTab);
  }

  // ── Street-level: States drawer ────────────────────────────────────────
  function openStatesDrawer() {
    const drawer = document.getElementById('sl-states-drawer');
    if (drawer) { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); }
  }
  function closeStatesDrawer() {
    const drawer = document.getElementById('sl-states-drawer');
    if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
  }
  const slStatesToggle = document.getElementById('sl-states-toggle');
  if (slStatesToggle) { slStatesToggle.addEventListener('click', openStatesDrawer); }
  const slStatesClose = document.getElementById('sl-states-close');
  if (slStatesClose) { slStatesClose.addEventListener('click', closeStatesDrawer); }

  // ── Street-level: state/landmark navigation ────────────────────────────
  function slNavigateTo(lat, lng, label) {
    const panoEl = document.getElementById('street-level-pano');
    const noTargetEl = document.getElementById('street-level-no-target');
    const targetLabelEl = document.getElementById('street-level-target-label');
    const monitorStatus = document.getElementById('sl-monitor-status');
    if (targetLabelEl) targetLabelEl.textContent = label || (lat.toFixed(4) + ', ' + lng.toFixed(4));
    if (monitorStatus) monitorStatus.textContent = label ? label.toUpperCase() : 'LIVE';
    if (noTargetEl) noTargetEl.style.display = 'none';
    if (panoEl) panoEl.classList.add('visible');
    loadGoogleMapsApi(BOOTSTRAP.googleMapsApiKey, function () {
      initStreetLevelPanorama(lat, lng);
    });
    closeStatesDrawer();
    document.querySelectorAll('.sl-state-btn, .sl-landmark-btn').forEach(function (b) { b.classList.remove('active'); });
  }

  document.querySelectorAll('.sl-state-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const lat = parseFloat(btn.dataset.lat);
      const lng = parseFloat(btn.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      btn.classList.add('active');
      slNavigateTo(lat, lng, btn.textContent);
    });
  });

  document.querySelectorAll('.sl-landmark-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const lat = parseFloat(btn.dataset.lat);
      const lng = parseFloat(btn.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      btn.classList.add('active');
      slNavigateTo(lat, lng, btn.textContent);
    });
  });

  // ── Street-level: tactical button toggles ─────────────────────────────
  document.querySelectorAll('.sl-tac-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.classList.toggle('active');
    });
  });

  // ── Street-level: monitor timestamp ───────────────────────────────────
  var slTimestampInterval = null;
  function updateSlTimestamp() {
    var el = document.getElementById('sl-timestamp');
    if (!el) return;
    var now = new Date();
    el.textContent = now.toUTCString().slice(17, 25) + 'Z';
  }
  function startSlMonitor() {
    updateSlTimestamp();
    if (!slTimestampInterval) { slTimestampInterval = setInterval(updateSlTimestamp, 1000); }
    var status = document.getElementById('sl-monitor-status');
    if (status && status.textContent === 'STANDBY') status.textContent = 'LIVE';
  }
  function stopSlMonitor() {
    if (slTimestampInterval) { clearInterval(slTimestampInterval); slTimestampInterval = null; }
    var status = document.getElementById('sl-monitor-status');
    if (status) status.textContent = 'STANDBY';
  }

  // ── Cesium street-level: enter / exit / focus / drone controls ────────────────

  // enterCesiumStreetLevel — fly Cesium camera to street-level altitude at lat/lng
  // with a forward-facing pitch for a human-perspective ground view.
  function enterCesiumStreetLevel(lat, lng) {
    if (!cesiumViewer) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    // Save current orbit position so we can return to it on exit
    const cPos = cesiumViewer.camera.positionCartographic;
    cesiumPreStreetLevelPos = {
      lng: Cesium.Math.toDegrees(cPos.longitude),
      lat: Cesium.Math.toDegrees(cPos.latitude),
      height: cPos.height,
      heading: cesiumViewer.camera.heading,
      pitch: cesiumViewer.camera.pitch,
    };
    cesiumStreetLevelMode = true;
    cesiumCameraMoveInternal = true;
    cesiumFollowDisengageMutedUntil = Date.now() + 3000;
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, STREET_LEVEL_ALTITUDE_M),
      orientation: {
        heading: cesiumViewer.camera.heading,
        pitch: Cesium.Math.toRadians(STREET_LEVEL_PITCH_DEG),
        roll: 0,
      },
      duration: 2.0,
      complete: function () { cesiumCameraMoveInternal = false; },
      cancel:   function () { cesiumCameraMoveInternal = false; },
    });
  }

  // exitCesiumStreetLevel — return camera to the pre-street-level orbit position
  function exitCesiumStreetLevel() {
    if (!cesiumViewer) return;
    cesiumStreetLevelMode = false;
    // Release lookAt constraint if focus mode was active
    if (cesiumFocusModeActive) {
      cesiumFocusModeActive = false;
      cesiumViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    if (cesiumPreStreetLevelPos) {
      const pos = cesiumPreStreetLevelPos;
      cesiumCameraMoveInternal = true;
      cesiumFollowDisengageMutedUntil = Date.now() + 2500;
      cesiumViewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, pos.height),
        orientation: {
          heading: pos.heading,
          pitch: Cesium.Math.clamp(pos.pitch, Cesium.Math.toRadians(-90), Cesium.Math.toRadians(-20)),
          roll: 0,
        },
        duration: 2.0,
        complete: function () { cesiumCameraMoveInternal = false; },
        cancel:   function () { cesiumCameraMoveInternal = false; },
      });
      cesiumPreStreetLevelPos = null;
    }
  }

  // activateFocusMode — lock camera onto target for orbit/tilt/approach navigation
  function activateFocusMode(target) {
    if (!cesiumViewer) return;
    const ll = resolveTargetLatLng(target);
    if (!ll) return;
    const dist = getTargetOrbitDistance(target);
    cesiumFocusModeActive = true;
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, dist),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 1.8,
      complete: function () {
        if (!cesiumFocusModeActive) return;
        // Lock lookAt so orbit/tilt revolves around the target
        const center = Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, 0);
        cesiumViewer.camera.lookAt(
          center,
          new Cesium.HeadingPitchRange(cesiumViewer.camera.heading, Cesium.Math.toRadians(-45), dist)
        );
      },
      cancel: function () {},
    });
  }

  // deactivateFocusMode — release lookAt constraint and restore free-orbit
  function deactivateFocusMode() {
    if (!cesiumViewer || !cesiumFocusModeActive) return;
    cesiumFocusModeActive = false;
    cesiumViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  // ── Drone keyboard navigation (WASD + R/F keys) ────────────────────────────
  // Movement speed scales with current altitude for smooth low/high navigation
  var DRONE_MOVE_PER_FRAME = 1.5;

  function droneMoveLoop() {
    if (!cesiumViewer || !cesiumStreetLevelMode) {
      droneMoveFrameId = null;
      return;
    }
    const anyKey = Object.values(cesiumDroneKeys).some(Boolean);
    if (!anyKey) {
      droneMoveFrameId = null;
      return;
    }
    const alt = cesiumViewer.camera.positionCartographic.height;
    const speed = DRONE_MOVE_PER_FRAME * (alt < 50 ? 1 : alt < 200 ? 3 : 8);
    if (cesiumDroneKeys['w']) cesiumViewer.camera.moveForward(speed);
    if (cesiumDroneKeys['s']) cesiumViewer.camera.moveBackward(speed);
    if (cesiumDroneKeys['a']) cesiumViewer.camera.moveLeft(speed);
    if (cesiumDroneKeys['d']) cesiumViewer.camera.moveRight(speed);
    if (cesiumDroneKeys['r']) cesiumViewer.camera.moveUp(speed * 0.5);
    if (cesiumDroneKeys['f']) cesiumViewer.camera.moveDown(speed * 0.5);
    droneMoveFrameId = requestAnimationFrame(droneMoveLoop);
  }

  // Wire drone button press/release to key state for button-based control
  function bindDroneButton(btnId, key) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    function startMove(e) {
      e.preventDefault();
      cesiumDroneKeys[key] = true;
      if (!droneMoveFrameId) droneMoveFrameId = requestAnimationFrame(droneMoveLoop);
    }
    function stopMove() { cesiumDroneKeys[key] = false; }
    btn.addEventListener('mousedown',  startMove);
    btn.addEventListener('touchstart', startMove, { passive: false });
    btn.addEventListener('mouseup',    stopMove);
    btn.addEventListener('mouseleave', stopMove);
    btn.addEventListener('touchend',   stopMove);
  }

  bindDroneButton('sv-fwd-btn',  'w');
  bindDroneButton('sv-back-btn', 's');
  bindDroneButton('sv-left-btn', 'a');
  bindDroneButton('sv-right-btn','d');
  bindDroneButton('sv-asc-btn',  'r');
  bindDroneButton('sv-desc-btn', 'f');
  bindDroneButton('sl-fwd-btn',  'w');
  bindDroneButton('sl-back-btn', 's');
  bindDroneButton('sl-left-btn', 'a');
  bindDroneButton('sl-right-btn','d');
  bindDroneButton('sl-asc-btn',  'r');
  bindDroneButton('sl-desc-btn', 'f');

  document.addEventListener('keydown', function (e) {
    if (!cesiumStreetLevelMode) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'r', 'f'].includes(k)) {
      e.preventDefault();
      cesiumDroneKeys[k] = true;
      if (!droneMoveFrameId) droneMoveFrameId = requestAnimationFrame(droneMoveLoop);
    }
  });

  document.addEventListener('keyup', function (e) {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'r', 'f'].includes(k)) cesiumDroneKeys[k] = false;
  });

  // ── Altitude readout: update sv-alt-readout and sl-alt-readout every second ──
  setInterval(function () {
    if (!cesiumViewer || !cesiumStreetLevelMode) return;
    const alt = cesiumViewer.camera.positionCartographic.height;
    const text = Math.round(alt) + 'm';
    var svEl = document.getElementById('sv-alt-readout');
    if (svEl) svEl.textContent = text;
    var slEl = document.getElementById('sl-alt-readout');
    if (slEl) slEl.textContent = text;
  }, 500);

  function toLatLngWithFallback(entity) {
    if (!entity) return null;
    if (Number.isFinite(entity.lat) && Number.isFinite(entity.lng)) return { lat: entity.lat, lng: entity.lng };
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return null;
    return { lat: 90 - ((entity.y / 100) * 180), lng: ((entity.x / 100) * 360) - 180 };
  }

  function syncCesiumScene(nowMs) {
    if (!cesiumViewer) return;
    let entitiesVisible = 0;
    let regionsVisible = 0;
    let flightsMerged = 0;
    let flightsVisibleAfterFilters = 0;
    let flightsDrawn = 0;
    let flightsErrored = 0;
    let satellitesRendered = 0;
    const allAgents = Object.values(state.agents || {});
    const flights = allAgents.filter(function (a) { return getEntityType(a) === 'flight'; });
    flightsMerged = flights.length;
    if (flights.length) {
      console.log('FLIGHT SAMPLE', flights[0]);
    }

    cesiumViewer.entities.removeAll();
    cesiumEntityRefs.agents = {};
    cesiumEntityRefs.regions = {};
    cesiumEntityRefs.trails = {};

    viewerCameraSafetyCheck();

    const flightsLayerBlocked = !layerState.liveFlights;
    if (flightsLayerBlocked) {
      console.log('Flights skipped due to layer toggle');
    }
    for (const a of allAgents) {
      const entityType = getEntityType(a);
      const forceRender = shouldForceRenderOpenSkyFlight(a);
      if (entityType === 'flight') flightsMerged++;
      if (!(forceRender || (showAgents && isEntityTypeVisible(entityType)))) continue;
      if (!showAgents || !isEntityTypeVisible(entityType)) continue;
      if (entityType === 'flight') flightsVisibleAfterFilters++;
      const p = getEntityWorldPoint(a, nowMs);
      const ll = toLatLngWithFallback(p);
      if (!ll) continue;
      const isFlight = entityType === 'flight';
      const isSatellite = entityType === 'satellite';
      const isSelected = selectedAgentId === a.id;
      const typeStyle = getEntityTypeStyle(a);
      if (isFlight && flightsLayerBlocked) continue;
      if (isFlight && (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng))) continue;
      const entityId = isFlight ? 'flight-' + a.id : 'agent-' + a.id;
      try {
        let marker;
        if (isFlight) {
          const rawAltitude = Number(a.altitude);
          const safeAltitude = Number.isFinite(rawAltitude) ? Math.max(0, rawAltitude) : 10000;
          const pointColor = isSelected ? '#ffe8a8' : '#67f5ff';
          marker = cesiumViewer.entities.add({
            id: entityId,
            rwMeta: { kind: 'agent', id: a.id },
            position: Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, safeAltitude),
            point: {
              pixelSize: isSelected ? 15 : 10,
              color: Cesium.Color.fromCssColorString(pointColor),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: isSelected ? 2 : 1,
            },
          });
          flightsDrawn++;
        } else {
          const height = isSatellite ? 400000 : 10;
          marker = cesiumViewer.entities.add({
            id: entityId,
            rwMeta: { kind: 'agent', id: a.id },
          });
          marker.position = Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, height);
          marker.point = {
            pixelSize: isSatellite ? (isSelected ? 14 : 10) : (isSelected ? 12 : 8),
            color: Cesium.Color.fromCssColorString(isSelected ? '#e8f5ff' : (isSatellite ? '#f0b7ff' : typeStyle.fill)),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: isSelected ? 2 : 1,
          };
          marker.label = {
            text: a.id,
            font: '12px monospace',
            fillColor: Cesium.Color.WHITE,
            pixelOffset: new Cesium.Cartesian2(10, -8),
          };
        }
        cesiumEntityRefs.agents[a.id] = marker;
        marker.show = true;
        entitiesVisible++;
        if (isSatellite) satellitesRendered++;
        if (isSelected) {
          const selectedPulseColor = Cesium.Color.fromCssColorString(isFlight ? '#ffe8a8' : '#9fd9ff');
          cesiumViewer.entities.add({
            id: 'selection-ring-' + a.id,
            rwMeta: { kind: 'agent', id: a.id },
            position: marker.position,
            ellipse: {
              semiMajorAxis: new Cesium.CallbackProperty(function () {
                return isSatellite ? 220000 : (isFlight ? 45000 + (Math.sin(Date.now() / 250) * 5000) : 28000 + (Math.sin(Date.now() / 250) * 3000));
              }, false),
              semiMinorAxis: new Cesium.CallbackProperty(function () {
                return isSatellite ? 220000 : (isFlight ? 45000 + (Math.sin(Date.now() / 250) * 5000) : 28000 + (Math.sin(Date.now() / 250) * 3000));
              }, false),
              material: selectedPulseColor.withAlpha(0.12),
              outline: true,
              outlineColor: selectedPulseColor.withAlpha(0.9),
              outlineWidth: 2,
              height: isSatellite ? 380000 : (isFlight ? Math.max(1500, Number(a.altitude) || 10000) : 0),
            },
          });
        }
      } catch (err) {
        if (isFlight) {
          flightsErrored++;
          const rawAltitude = Number(a.altitude);
          const safeAltitude = Number.isFinite(rawAltitude) ? Math.max(0, rawAltitude) : 10000;
          console.error('[RW Cesium] flight draw error', {
            id: a.id,
            lat: ll.lat,
            lng: ll.lng,
            altitude: a.altitude,
            safeAltitude,
            heading: a.heading,
            error: err && err.message ? err.message : String(err),
            flight: a,
          });
        } else {
          console.error('[RW Cesium] entity draw error', err);
        }
        continue;
      }

      if (showTrails && !isFlight) {
        const trailPoints = getCesiumTrailPointsForEntity(a);
        if (trailPoints.length >= 2) {
          const trailEntity = cesiumViewer.entities.add({
            id: 'trail-' + a.id,
            rwMeta: { kind: 'agent', id: a.id },
          });
          cesiumEntityRefs.trails[a.id] = trailEntity;
          trailEntity.polyline = {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(trailPoints),
            width: selectedAgentId === a.id ? 3 : 2,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: selectedAgentId === a.id ? 0.25 : 0.12,
              color: Cesium.Color.fromCssColorString(selectedAgentId === a.id ? typeStyle.trailSelected : typeStyle.trail),
            }),
            clampToGround: false,
          };
          trailEntity.show = true;
        }
      }
      const lookahead = getCesiumLookaheadPoint(a, ll);
      if (lookahead) {
        cesiumViewer.entities.add({
          id: 'forward-' + a.id,
          rwMeta: { kind: 'agent', id: a.id },
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
              ll.lng, ll.lat, (isSatellite ? 400000 : Math.max(10, Number(a.altitude) || 1000)),
              lookahead.lng, lookahead.lat, (isSatellite ? 400000 : Math.max(10, Number(a.altitude) || 1000)),
            ]),
            width: isSelected ? 2.8 : 1.5,
            material: Cesium.Color.fromCssColorString(isSelected ? '#e7f5ff' : '#9cc6e6').withAlpha(isSelected ? 0.95 : 0.6),
          },
        });
      }
    }
    lastFlightDebugCounts = { merged: flightsMerged, visible: flightsVisibleAfterFilters, drawn: flightsDrawn, errors: flightsErrored };
    for (const r of Object.values(state.regions || {})) {
      if (!showRegions || !layerState.regions) break;
      const ll = toLatLngWithFallback(r);
      if (!ll) continue;
      const reg = cesiumViewer.entities.add({ id: 'region-' + r.id, rwMeta: { kind: 'region', id: r.id } });
      cesiumEntityRefs.regions[r.id] = reg;
      reg.polygon = undefined;
      reg.ellipse = undefined;
      reg.polyline = undefined;
      reg.position = Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, 0);
      reg.point = {
        pixelSize: selectedRegionId === r.id ? 10 : 5,
        color: Cesium.Color.CYAN.withAlpha(selectedRegionId === r.id ? 1 : 0.75),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: selectedRegionId === r.id ? 2 : 1,
      };
      reg.label = {
        text: r.name || r.id,
        font: '12px monospace',
        fillColor: Cesium.Color.ORANGE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
      };
      reg.show = true;
      if (selectedRegionId === r.id) {
        const intel = latestRegionIntelligence[r.id] || null;
        const status = intel ? intel.status : 'IDLE';
        const color = status === 'HOT' ? '#ff8f8f' : (status === 'ACTIVE' ? '#ffd08f' : '#8fc5ff');
        cesiumViewer.entities.add({
          id: 'region-emphasis-' + r.id,
          rwMeta: { kind: 'region', id: r.id },
          position: Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, 0),
          ellipse: {
            semiMajorAxis: 220000,
            semiMinorAxis: 220000,
            material: Cesium.Color.fromCssColorString(color).withAlpha(0.08),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
            outlineWidth: 2,
          },
        });
      }
      regionsVisible++;
    }
    lastCesiumRenderCounts = {
      entities: entitiesVisible,
      regions: regionsVisible,
      satellites: satellitesRendered,
      flightsDrawn,
      earthInitialized: !!cesiumViewer,
      tilesLoaded: !!cesiumGoogleTileset,
      tilesState: lastCesiumRenderCounts.tilesState,
      tilesError: lastCesiumRenderCounts.tilesError,
    };
    const now = Date.now();
    if (now - lastCesiumDiagAt > 15000) {
      lastCesiumDiagAt = now;
      console.info('[RW Cesium] render counts', {
        earthInitialized: !!cesiumViewer,
        tilesLoaded: !!cesiumGoogleTileset,
        entities: entitiesVisible,
        satellites: satellitesRendered,
        regions: regionsVisible,
        flightsFetched: lastApiFetchedCount > 0 ? lastApiFetchedCount : (Number.isFinite(Number(openskyStatus.fetched)) ? Number(openskyStatus.fetched) : 0),
        flightsMerged,
        flightsVisible: flightsVisibleAfterFilters,
        flightsDrawn: flightsDrawn,
        flightsErrors: flightsErrored,
        layers: {
          liveFlights: layerState.liveFlights,
          satellites: layerState.satellites,
          regions: layerState.regions,
          traffic: layerState.traffic,
          weather: layerState.weather,
        },
      });
    }
    cesiumViewer.scene.requestRender();
  }

  function viewerCameraSafetyCheck() {
    if (!cesiumViewer || !cesiumViewer.camera || cesiumSafetyViewApplied) return;
    cesiumViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-100, 40, 20000000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
    cesiumSafetyViewApplied = true;
  }

  function getCesiumTrailPointsForEntity(agent) {
    const entityType = getEntityType(agent);
    const trail = entityType === 'flight'
      ? getFlightTrailPoints(agent)
      : (agentTrails[agent.id] || []);
    if (!Array.isArray(trail) || trail.length < 2) return [];
    const points = [];
    for (const point of trail) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      const height = entityType === 'satellite'
        ? 400000
        : (entityType === 'flight' ? Math.max(500, Number(agent.altitude) || 2000) : 12);
      points.push(point.lng, point.lat, height);
    }
    return points;
  }

  function getCesiumLookaheadPoint(agent, ll) {
    if (!agent || !ll) return null;
    const headingDeg = Number(agent.heading);
    if (!Number.isFinite(headingDeg)) return null;
    const speedMps = Number.isFinite(Number(agent.speed)) ? Number(agent.speed) : 0;
    if (speedMps < FORWARD_VECTOR_MIN_SPEED_MPS) return null;
    const lookAheadKm = Math.min(FORWARD_VECTOR_MAX_DISTANCE_KM, Math.max(8, (speedMps * FORWARD_VECTOR_LOOKAHEAD_SEC) / 1000));
    const distanceRatio = lookAheadKm / 111;
    const headingRad = headingDeg * (Math.PI / 180);
    const latDelta = Math.cos(headingRad) * distanceRatio;
    const lngDenom = Math.max(0.2, Math.cos((ll.lat || 0) * (Math.PI / 180)));
    const lngDelta = (Math.sin(headingRad) * distanceRatio) / lngDenom;
    return {
      lat: Math.max(-89.8, Math.min(89.8, ll.lat + latDelta)),
      lng: ((((ll.lng + lngDelta) + 540) % 360) - 180),
    };
  }

  function renderWorldOverlays(width, height, now, globeDebug) {
    const deferredLabelDraws = [];
    const deferredSelectionDraws = [];
    const regions = Object.values(state.regions);
    const agents = Object.values(state.agents);
    const visibleAgents = agents.filter(function (a) {
      return shouldForceRenderOpenSkyFlight(a) || isEntityTypeVisible(getEntityType(a));
    });
    const flightsMerged = agents.filter(a => getEntityType(a) === 'flight').length;
    const flightsVisibleAfterFilters = visibleAgents.filter(a => getEntityType(a) === 'flight').length;
    const drawCounts = { flightsDrawn: 0 };
    latestRegionIntelligence = computeRegionIntelligence();

    globeRegionOverlaySuppressed = false;
    renderRegionOverlays(regions, width, height, now, globeDebug, deferredLabelDraws);
    renderTrailsAndArcs(visibleAgents, width, height, globeDebug);
    renderEntityMarkers(visibleAgents, width, height, now, globeDebug, deferredLabelDraws, deferredSelectionDraws, drawCounts, showAgents);
    lastFlightDebugCounts = { merged: flightsMerged, visible: flightsVisibleAfterFilters, drawn: drawCounts.flightsDrawn };
    console.info('[RW Flights][canvas]', {
      flightsFetched: openskyStatus.fetched,
      flightsMerged,
      flightsRendered: drawCounts.flightsDrawn,
    });
    renderEntityMarkers(visibleAgents, width, height, now, globeDebug, deferredLabelDraws, deferredSelectionDraws, drawCounts);
    lastFlightDebugCounts = { merged: flightsMerged, visible: flightsVisibleAfterFilters, drawn: drawCounts.flightsDrawn, errors: 0 };

    deferredLabelDraws.forEach(function (drawLabel) { drawLabel(); });
    deferredSelectionDraws.forEach(function (drawSelection) { drawSelection(); });

    globeOverlayDiagnostics = globeDebug
      ? {
          entitiesVisible: globeDebug.entitiesVisible,
          regionsVisible: globeDebug.regionsVisible,
          trailsVisible: globeDebug.trailsVisible,
          regionOverlaySuppressed: globeRegionOverlaySuppressed,
        }
      : null;

    if (globeDebug && GLOBE_OVERLAY_DEBUG && now - lastGlobeDebugLogAt >= GLOBE_DEBUG_LOG_INTERVAL_MS) {
      lastGlobeDebugLogAt = now;
      console.debug('globe-overlay-debug', {
        entitiesVisible: globeDebug.entitiesVisible,
        regionsVisible: globeDebug.regionsVisible,
        trailsVisible: globeDebug.trailsVisible,
        projected: globeDebug.projected,
        skippedProjections: globeDebug.skipped,
        pathSegmentsDrawn: globeDebug.pathSegmentsDrawn,
        zRange: {
          min: Number.isFinite(globeDebug.zMin) ? globeDebug.zMin : null,
          max: Number.isFinite(globeDebug.zMax) ? globeDebug.zMax : null,
        },
        invalidProjected: globeDebug.invalidProjected,
        coordinateSources: {
          latLng: globeDebug.entitiesUsingLatLng,
          gridXY: globeDebug.entitiesUsingGrid,
        },
      });
    }
  }

  function renderRegionOverlays(regions, width, height, now, globeDebug, deferredLabelDraws) {
    if (!showRegions || !layerState.regions) return;
    if (isGlobeRenderMode() && HIDE_GRID_REGIONS_ON_GLOBE) {
      globeRegionOverlaySuppressed = true;
      return;
    }
    regions.forEach(function (r) {
      const regionPoint = getEntityWorldPoint(r);
      const regionPos = worldPointToCanvas(regionPoint, width, height, GLOBE_REGION_OUTLINE_MIN_Z, globeDebug);
      if (!regionPos) return;
      const rx = regionPos.x, ry = regionPos.y;
      const regionIntel = latestRegionIntelligence[r.id] || null;
      const occupancy = regionIntel ? regionIntel.occupancy : 0;
      const status = regionIntel ? regionIntel.status : 'IDLE';
      const isSelected = selectedRegionId === r.id;
      const regionKey = getCurrentTargetKey('region', r.id);
      const isFlagged = !!flaggedTargets[regionKey];
      const isFocused = focusTargetKey === regionKey && now < focusEffectUntil;
      const palette = getRegionPaletteByMode(status, isSelected);
      const regionSize = 60 * viewport.zoom;
      const overlay = isGlobeRenderMode() ? getRegionGlobeOverlay(r, width, height, globeDebug) : null;
      ctx.save();
      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = isSelected ? 2.25 : 1.5;
      if (isFlagged) {
        ctx.shadowBlur = 6;
        ctx.shadowColor = '#ffd37a';
      }
      if (overlay) {
        if (globeDebug) globeDebug.regionsVisible++;
        ctx.strokeStyle = palette.strokeBold;
        ctx.fillStyle = palette.fill;
        drawRegionOverlayShape(overlay);
        ctx.fill();
        ctx.setLineDash([6, 5]);
        drawRegionOverlayShape(overlay);
        ctx.stroke();
        ctx.setLineDash([]);
        if (status === 'HOT') {
          ctx.shadowBlur = 10;
          ctx.shadowColor = styleMode === 'flir' ? '#ffd09799' : '#ff9b9b88';
          ctx.strokeStyle = palette.strokeBold;
          ctx.lineWidth = Math.max(ctx.lineWidth, 2.2);
          drawRegionOverlayShape(overlay, 2);
          ctx.stroke();
        }
        if (isFocused) {
          ctx.strokeStyle = '#9cf';
          ctx.lineWidth = 3;
          drawRegionOverlayShape(overlay, 4);
          ctx.stroke();
        }
      } else {
        const rectX = rx - (regionSize / 2);
        const rectY = ry - (regionSize / 2);
        if (isSelected) {
          ctx.fillStyle = palette.fill;
          ctx.fillRect(rectX, rectY, regionSize, regionSize);
        }
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(rectX, rectY, regionSize, regionSize);
        ctx.setLineDash([]);
        if (status === 'HOT') {
          ctx.strokeStyle = palette.strokeBold;
          ctx.lineWidth = 2;
          ctx.strokeRect(rectX - 1, rectY - 1, regionSize + 2, regionSize + 2);
        }
        if (isFocused) {
          ctx.strokeStyle = '#9cf';
          ctx.lineWidth = 3;
          ctx.strokeRect(rectX - 3, rectY - 3, regionSize + 6, regionSize + 6);
        }
      }
      const regionLabel = r.name || r.id;
      const labelX = overlay ? overlay.labelX : (rx - (28 * viewport.zoom));
      const labelY = overlay ? (overlay.labelY - (6 * viewport.zoom)) : (ry - (33 * viewport.zoom));
      const occupancyX = (overlay ? overlay.labelX : rx) - (3 * viewport.zoom);
      const occupancyY = (overlay ? overlay.labelY : ry) + (4 * viewport.zoom);
      deferredLabelDraws.push(function drawRegionLabel() {
        ctx.save();
        if (labelX >= -60 && labelX <= width + 60 && labelY >= -30 && labelY <= height + 30) {
          ctx.fillStyle = palette.label;
          ctx.font = Math.max(8, 10 * viewport.zoom).toFixed(1) + 'px monospace';
          ctx.fillText(regionLabel, labelX, labelY);
        }
        ctx.fillStyle = '#d8e2f0';
        ctx.font = Math.max(9, 11 * viewport.zoom).toFixed(1) + 'px monospace';
        ctx.fillText(String(occupancy), occupancyX, occupancyY);
        ctx.restore();
      });
      ctx.restore();
    });
  }

  function renderTrailsAndArcs(visibleAgents, width, height, globeDebug) {
    if (!showTrails) return;
    const now = Date.now();
    visibleAgents.forEach(function (a) {
      const entityType = getEntityType(a);
      const trail = (entityType === 'flight' && isOpenSkyFlight(a))
        ? getFlightTrailPoints(a)
        : agentTrails[a.id];
      const isSelected = selectedAgentId === a.id;
      const typeStyle = getEntityTypeStyle(a);
      if (isGlobeRenderMode() && entityType === 'satellite') {
        if (drawSatelliteOrbitBand(a, width, height, isSelected, typeStyle, globeDebug) && globeDebug) globeDebug.trailsVisible++;
      }
      if (isGlobeRenderMode() && entityType === 'flight') {
        if (trail && trail.length >= 2 && drawFlightArcPath(a, trail, width, height, isSelected, typeStyle, globeDebug, now) && globeDebug) {
          globeDebug.trailsVisible++;
        }
        if (drawFlightForwardVector(a, width, height, isSelected, typeStyle, globeDebug, now) && globeDebug) globeDebug.trailsVisible++;
        return;
      }
      if (!trail || trail.length < 2) {
        return;
      }
      let hasSegment = false;
      for (let i = 1; i < trail.length; i++) {
        const prevPt = worldPointToCanvas(trail[i - 1], width, height, GLOBE_PATH_MIN_Z, globeDebug);
        const pt = worldPointToCanvas(trail[i], width, height, GLOBE_PATH_MIN_Z, globeDebug);
        if (!prevPt || !pt) continue;
        const ageRatio = i / (trail.length - 1);
        const alpha = isSelected ? (0.35 + (ageRatio * 0.65)) : (0.18 + (ageRatio * 0.45));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(prevPt.x, prevPt.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.strokeStyle = hexToRgba(isSelected ? typeStyle.stroke : typeStyle.fill, alpha);
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();
        ctx.restore();
        hasSegment = true;
        if (globeDebug) globeDebug.pathSegmentsDrawn++;
      }
      if (hasSegment && globeDebug) globeDebug.trailsVisible++;
    });
  }

  function renderEntityMarkers(visibleAgents, width, height, now, globeDebug, deferredLabelDraws, deferredSelectionDraws, drawCounts, agentsLayerEnabled) {
    visibleAgents.forEach(function (a) {
      const forceRender = shouldForceRenderOpenSkyFlight(a);
      if (!agentsLayerEnabled && !forceRender) return;
      const agentPoint = getEntityWorldPoint(a, now);
      if (globeDebug) {
        if (Number.isFinite(agentPoint.lat) && Number.isFinite(agentPoint.lng)) globeDebug.entitiesUsingLatLng++;
        else globeDebug.entitiesUsingGrid++;
      }
      const entityMinZ = a && a.type === 'flight' && a.source === 'opensky' ? GLOBE_FLIGHT_MIN_Z : GLOBE_ENTITY_MIN_Z;
      const agentPos = worldPointToCanvas(agentPoint, width, height, entityMinZ, globeDebug);
      if (!agentPos) return;
      if (globeDebug) globeDebug.entitiesVisible++;
      const ax = agentPos.x;
      const ay = agentPos.y;
      const isSelected = selectedAgentId === a.id;
      const agentKey = getCurrentTargetKey('agent', a.id);
      const isFlagged = !!flaggedTargets[agentKey];
      const isFocused = focusTargetKey === agentKey && now < focusEffectUntil;
      const typeStyle = getEntityTypeStyle(a);
      const entityType = getEntityType(a);
      const isFlight = entityType === 'flight';
      ctx.save();
      ctx.beginPath();
      const renderRadius = isFlight
        ? (isSelected ? AGENT_RENDER_RADIUS * 1.9 : AGENT_RENDER_RADIUS * 1.5)
        : AGENT_RENDER_RADIUS;
      ctx.arc(ax, ay, renderRadius * viewport.zoom, 0, Math.PI * 2);
      ctx.fillStyle = isFlight
        ? (a.active ? '#ffd24d' : '#8a7640')
        : (a.active ? typeStyle.fill : '#2b3544');
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#e8f7ff' : (a.active ? typeStyle.stroke : '#223041');
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
      const headingDeg = Number(a.heading);
      const speedMps = Number(a.speed);
      if (Number.isFinite(headingDeg) && Number.isFinite(speedMps) && speedMps >= FORWARD_VECTOR_MIN_SPEED_MPS) {
        const lookLen = Math.min(26, Math.max(10, (speedMps / 14))) * viewport.zoom;
        const headingRad = headingDeg * (Math.PI / 180);
        const tx = ax + (Math.sin(headingRad) * lookLen);
        const ty = ay - (Math.cos(headingRad) * lookLen);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = isSelected ? '#ecf7ff' : '#9fc6e2';
        ctx.lineWidth = isSelected ? 2 : 1.2;
        ctx.stroke();
      }
      if (isFlight) {
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#ffe27a';
      }
      if (isFlight && drawCounts) drawCounts.flightsDrawn++;
      if (isFlagged) {
        ctx.beginPath();
        ctx.arc(ax, ay, (AGENT_RENDER_RADIUS + 3.5) * viewport.zoom, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd37a88';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      const labelX = ax + (7 * viewport.zoom);
      const labelY = ay + (4 * viewport.zoom);
      deferredLabelDraws.push(function drawEntityLabel() {
        ctx.save();
        ctx.fillStyle = '#dbe5f2';
        ctx.font = Math.max(7, 9 * viewport.zoom).toFixed(1) + 'px monospace';
        ctx.fillText(a.id, labelX, labelY);
        ctx.restore();
      });
      if (isSelected) {
        deferredSelectionDraws.push(function drawSelectionRing() {
          const pulse = 1 + ((Math.sin(now / 220) + 1) * (isFocused ? 0.3 : 0.18));
          ctx.save();
          ctx.shadowBlur = 12;
          ctx.shadowColor = isFocused ? '#cfeaff' : '#9cf';
          ctx.beginPath();
          ctx.arc(ax, ay, ((isFocused ? 11 : 8) * viewport.zoom) * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = isFocused ? '#d7edff' : '#9cf8';
          ctx.lineWidth = isFocused ? 2.2 : 1.5;
          ctx.stroke();
          ctx.restore();
        });
      }
      ctx.restore();
    });
  }

  // ── Event log ──
  function renderEventLog() {
    const prevScrollTop = log.scrollTop;
    const prevScrollHeight = log.scrollHeight;
    const stickToTop = prevScrollTop <= 2;
    const entries = eventLog.slice().reverse().filter(function (ev) {
      return eventMatchesFilters(ev);
    });
    log.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'event-empty';
      empty.textContent = 'No matching events';
      log.appendChild(empty);
      return;
    }
    for (const ev of entries) {
      log.appendChild(createEventEntry(ev));
    }
    if (stickToTop) {
      log.scrollTop = 0;
    } else {
      const delta = log.scrollHeight - prevScrollHeight;
      log.scrollTop = prevScrollTop + delta;
    }
  }

  function createEventEntry(ev) {
    const div = document.createElement('div');
    div.className = 'event-entry ' + (ev.kind || 'system');
    const evType = eventEntityType(ev);
    if (evType && !isEntityTypeVisible(evType)) div.classList.add('dimmed');
    if ((selectedAgentId || selectedRegionId) && eventMatchesSelected(ev)) div.classList.add('related');
    // Attach target identity for click-to-jump from event stream
    if (ev.agentId)  div.dataset.agentId  = ev.agentId;
    if (ev.regionId) div.dataset.regionId = ev.regionId;
    const ts = new Date(ev.ts || Date.now()).toISOString().substr(11, 8);
    div.innerHTML = '<span class="ts">' + ts + '</span>' + escHtml(ev.msg || JSON.stringify(ev));
    return div;
  }

  function pushEvent(ev) {
    renderEventLog();
    if ((selectedAgentId || selectedRegionId) && eventMatchesSelected(ev)) {
      latestSelectedEvent = ev;
      renderSelectedPanel();
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function hexToRgba(hex, alpha) {
    const clean = String(hex || '').replace('#', '').trim();
    if (clean.length !== 6) return 'rgba(160,190,220,' + alpha + ')';
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function eventMatchesSelected(ev) {
    if (!ev || typeof ev.msg !== 'string') return false;
    if (selectedAgentId && ev.msg.includes(selectedAgentId)) return true;
    if (selectedRegionId && eventRelatesToSelectedRegion(ev, selectedRegionId)) return true;
    return false;
  }

  function eventMatchesFilters(ev) {
    const msg = String((ev && ev.msg) || '');
    const filter = activeEventFilter;
    if (selectedRegionId && !latestRegionIntelligence[selectedRegionId]) {
      latestRegionIntelligence = computeRegionIntelligence();
    }
    if (filter === 'tick' && !msg.startsWith('tick ')) return false;
    if (filter === 'movement' && ev.kind !== 'agent') return false;
    if (filter === 'region' && ev.kind !== 'region') return false;
    if (filter === 'operator' && !msg.startsWith('operator ')) return false;
    if (selectedRegionId && !eventRelatesToSelectedRegion(ev, selectedRegionId)) return false;
    if (!eventSearchQuery) return true;
    const haystack = [msg, ev.kind || '', ev.entityType || ''].join(' ').toLowerCase();
    return haystack.includes(eventSearchQuery);
  }

  function eventRelatesToSelectedRegion(ev, regionId) {
    if (!regionId || !ev) return true;
    const msg = String(ev.msg || '');
    if (msg.includes(regionId)) return true;
    const intel = latestRegionIntelligence[regionId];
    const entityIds = intel ? intel.entitiesInside : [];
    for (const id of entityIds) {
      if (msg.includes(id)) return true;
    }
    if (intel && Array.isArray(intel.relatedEntities)) {
      for (const id of intel.relatedEntities) {
        if (msg.includes(id)) return true;
      }
    }
    if (ev.kind === 'region' && typeof ev.msg === 'string' && /occupancy|status|activity|region/i.test(ev.msg)) {
      return true;
    }
    return false;
  }

  function refreshRelatedEventHighlight() {
    renderEventLog();
  }

  function updateLatestSelectedEventFromLog() {
    latestSelectedEvent = null;
    if (!selectedAgentId && !selectedRegionId) return;
    for (const ev of eventLog.slice().reverse()) {
      if (eventMatchesSelected(ev)) {
        latestSelectedEvent = ev;
        return;
      }
    }
  }

  function getEntityType(agent) {
    const type = agent && agent.type ? String(agent.type).toLowerCase() : 'agent';
    return Object.prototype.hasOwnProperty.call(TYPE_STYLE, type) ? type : 'other';
  }

  function getEntityTypeStyle(agent) {
    return TYPE_STYLE[getEntityType(agent)] || TYPE_STYLE.other;
  }

  function shouldForceRenderOpenSkyFlight(agent) {
    return !!(FORCE_RENDER_ALL_OPENSKY_FLIGHTS && isOpenSkyFlight(agent));
  }

  function isEntityTypeVisible(type) {
    if (!visibleEntityTypes[type]) return false;
    if (type === 'flight' && !layerState.liveFlights) return false;
    if (type === 'satellite' && !layerState.satellites) return false;
    return true;
  }

  function buildLayerDiagnostics() {
    const allAgents = Object.values(state.agents || {});
    const flightsInState = allAgents.filter(a => getEntityType(a) === 'flight').length;
    const satellitesInState = allAgents.filter(a => getEntityType(a) === 'satellite').length;
    const regionsInState = Object.keys(state.regions || {}).length;
    return {
      liveFlights:     layerState.liveFlights ? (flightsInState > 0 ? 'active' : 'no data') : 'off',
      militaryFlights: 'unavailable',
      earthquakes:     'unavailable',
      satellites:      layerState.satellites ? (satellitesInState > 0 ? 'active' : 'no data') : 'off',
      traffic:         'unavailable',
      weather:         'unavailable',
      cctvMesh:        'unavailable',
      bikeshare:       'unavailable',
      regions:         layerState.regions ? (regionsInState > 0 ? 'active' : 'no data') : 'off',
    };
  }

  function eventEntityType(ev) {
    if (!ev || !ev.entityType) return null;
    const type = String(ev.entityType).toLowerCase();
    return Object.prototype.hasOwnProperty.call(visibleEntityTypes, type) ? type : null;
  }

  function renderSelectedPanel() {
    const selectedAgent = selectedAgentId ? state.agents[selectedAgentId] : null;
    const selectedRegion = selectedRegionId ? state.regions[selectedRegionId] : null;
    if (!selectedAgent && !selectedRegion) {
      selectedPanel.innerHTML = '<div class="selected-empty">No target selected</div>';
      syncActionButtons();
      return;
    }
    const lastEvent = latestSelectedEvent ? (latestSelectedEvent.msg || '—') : '—';
    if (selectedRegion) {
      const regionKey = getCurrentTargetKey('region', selectedRegion.id);
      const isFlagged = !!flaggedTargets[regionKey];
      const lastAction = lastOperatorActionByTarget[regionKey] || '—';
      const intel = latestRegionIntelligence[selectedRegion.id] || computeRegionIntelligence()[selectedRegion.id] || null;
      const occupancy = intel ? intel.occupancy : (getRegionOccupancy()[selectedRegion.id] || 0);
      const status = intel ? intel.status : 'IDLE';
      const insideIds = intel ? intel.entitiesInside : Object.values(state.agents)
        .filter(a => isEntityTypeVisible(getEntityType(a)))
        .filter(a => a.region === selectedRegion.id)
        .map(a => a.id);
      const insideSummary = insideIds.length > 8 ? (insideIds.length + ' agents') : insideIds.join(', ');
      const relatedSummary = intel && intel.relatedEntities && intel.relatedEntities.length
        ? (intel.relatedEntities.length > 8 ? (intel.relatedEntities.length + ' nearby') : intel.relatedEntities.join(', '))
        : '—';
      const lastRegionEventTs = intel && intel.lastEventTs ? new Date(intel.lastEventTs).toISOString() : '—';
      selectedPanel.innerHTML =
        '<div class="selected-grid">' +
        '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selectedRegion.id) + '</span>' +
        '<span class="selected-label">NAME</span><span class="selected-value">' + escHtml(selectedRegion.name || selectedRegion.id) + '</span>' +
        '<span class="selected-label">TYPE</span><span class="selected-value">region</span>' +
        '<span class="selected-label">OCCUPANCY</span><span class="selected-value">' + occupancy + '</span>' +
        '<span class="selected-label">STATUS</span><span class="selected-value">' + status + '</span>' +
        '<span class="selected-label">ACTIVITY</span><span class="selected-value">' + (intel ? intel.activityLevel : 0) + '</span>' +
        '<span class="selected-label">LAST EVT TS</span><span class="selected-value">' + escHtml(lastRegionEventTs) + '</span>' +
        '<span class="selected-label">FLAGGED</span><span class="selected-value">' + (isFlagged ? 'yes' : 'no') + '</span>' +
        '<span class="selected-label">LAST ACTION</span><span class="selected-value">' + escHtml(lastAction) + '</span>' +
        '<span class="selected-label">ENTITIES</span><span class="selected-value">' + escHtml(insideSummary || '—') + '</span>' +
        '<span class="selected-label">NEARBY</span><span class="selected-value">' + escHtml(relatedSummary) + '</span>' +
        '<span class="selected-label">LAST EVENT</span><span class="selected-value">' + escHtml(lastEvent) + '</span>' +
        '</div>';
      syncActionButtons();
      return;
    }

    const selected = selectedAgent;
    const agentKey = getCurrentTargetKey('agent', selected.id);
    const isFlagged = !!flaggedTargets[agentKey];
    const lastAction = lastOperatorActionByTarget[agentKey] || '—';
    const selectedPoint = getEntityWorldPoint(selected);
    const speed = Number.isFinite(Number(selected.speed)) ? Number(selected.speed) : null;
    const heading = Number.isFinite(Number(selected.heading)) ? Number(selected.heading) : null;
    const altitude = Number.isFinite(Number(selected.altitude)) ? Number(selected.altitude) : null;
    const source = selected.source || (isOpenSkyFlight(selected) ? 'opensky' : 'sim');
    const lastUpdate = Number.isFinite(Number(selected.lastUpdateMs))
      ? new Date(Number(selected.lastUpdateMs)).toISOString()
      : (selected.updatedAt || selected.lastSeen || '—');
    selectedPanel.innerHTML =
      '<div class="selected-grid">' +
      '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selected.id) + '</span>' +
      '<span class="selected-label">TYPE</span><span class="selected-value">' + escHtml(getEntityType(selected)) + '</span>' +
      '<span class="selected-label">SOURCE</span><span class="selected-value">' + escHtml(source) + '</span>' +
      '<span class="selected-label">X</span><span class="selected-value">' + selected.x.toFixed(2) + '</span>' +
      '<span class="selected-label">Y</span><span class="selected-value">' + selected.y.toFixed(2) + '</span>' +
      '<span class="selected-label">LAT</span><span class="selected-value">' + (Number.isFinite(selectedPoint.lat) ? selectedPoint.lat.toFixed(4) : '—') + '</span>' +
      '<span class="selected-label">LNG</span><span class="selected-value">' + (Number.isFinite(selectedPoint.lng) ? selectedPoint.lng.toFixed(4) : '—') + '</span>' +
      '<span class="selected-label">SPEED</span><span class="selected-value">' + (speed === null ? '—' : (speed.toFixed(1) + ' m/s')) + '</span>' +
      '<span class="selected-label">HEADING</span><span class="selected-value">' + (heading === null ? '—' : (heading.toFixed(0) + '°')) + '</span>' +
      '<span class="selected-label">ALTITUDE</span><span class="selected-value">' + (altitude === null ? '—' : (altitude.toFixed(0) + ' m')) + '</span>' +
      '<span class="selected-label">STATUS</span><span class="selected-value">' + escHtml(selected.state || (selected.active ? 'active' : 'inactive')) + '</span>' +
      '<span class="selected-label">LAST UPDATE</span><span class="selected-value">' + escHtml(lastUpdate) + '</span>' +
      '<span class="selected-label">FLAGGED</span><span class="selected-value">' + (isFlagged ? 'yes' : 'no') + '</span>' +
      '<span class="selected-label">LAST ACTION</span><span class="selected-value">' + escHtml(lastAction) + '</span>' +
      '<span class="selected-label">LAST EVENT</span><span class="selected-value">' + escHtml(lastEvent) + '</span>' +
      '</div>';
    syncActionButtons();
  }

  function getCurrentTargetKey(explicitType, explicitId) {
    const type = explicitType || (selectedAgentId ? 'agent' : (selectedRegionId ? 'region' : null));
    const id = explicitId || selectedAgentId || selectedRegionId;
    return type && id ? (type + ':' + id) : null;
  }

  function syncActionButtons() {
    const hasSelection = !!getCurrentTargetKey();
    focusActionBtn.disabled = !hasSelection;
    pingActionBtn.disabled = !hasSelection;
    flagActionBtn.disabled = !hasSelection;
    followTargetToggleEl.disabled = !hasSelection;
    if (!hasSelection && followTargetEnabled) {
      disableFollowTarget('no selection');
    }
  }

  function pushOperatorEvent(msg) {
    const ev = { kind: 'system', msg: msg, ts: new Date().toISOString(), entityType: null, _tick: state.tick };
    eventLog.push(ev);
    if (eventLog.length > 120) eventLog.shift();
    pushEvent(ev);
  }

  function disableFollowTarget(reason) {
    if (!followTargetEnabled && !cameraLerpTarget && !cesiumCameraLerpState) return;
    followTargetEnabled = false;
    cameraLerpTarget = null;
    cesiumCameraLerpState = null;
    followTargetToggleEl.checked = false;
    if (reason) pushOperatorEvent('operator follow disabled (' + reason + ')');
  }

  function runFocusAction() {
    const targetKey = getCurrentTargetKey();
    if (!targetKey) return;
    const focusPoint = getSelectedFocusPoint();
    if (!focusPoint) return;
    focusTargetKey = targetKey;
    focusEffectUntil = Date.now() + 2200;
    const targetId = selectedAgentId || selectedRegionId;
    const label = selectedAgentId ? targetId : ('region ' + targetId);
    lastOperatorActionByTarget[targetKey] = 'focus';
    pushOperatorEvent('operator focused ' + label);
    jumpToTarget(focusPoint);
    activateFocusMode(focusPoint);
    renderSelectedPanel();
    draw();
  }

  function runPingAction() {
    const targetKey = getCurrentTargetKey();
    if (!targetKey) return;
    const targetId = selectedAgentId || selectedRegionId;
    lastOperatorActionByTarget[targetKey] = 'ping';
    if (selectedAgentId) {
      pushOperatorEvent('operator pinged ' + targetId);
    } else {
      pushOperatorEvent('operator pinged region ' + targetId);
    }
    renderSelectedPanel();
  }

  function runFlagAction() {
    const targetKey = getCurrentTargetKey();
    if (!targetKey) return;
    flaggedTargets[targetKey] = !flaggedTargets[targetKey];
    lastOperatorActionByTarget[targetKey] = flaggedTargets[targetKey] ? 'flag' : 'unflag';
    const targetId = selectedAgentId || selectedRegionId;
    const label = selectedAgentId ? targetId : ('region ' + targetId);
    pushOperatorEvent('operator ' + (flaggedTargets[targetKey] ? 'flagged ' : 'unflagged ') + label);
    renderSelectedPanel();
    draw();
  }

  function selectAgent(agentId) {
    selectedAgentId = agentId || null;
    selectedRegionId = null;
    updateLatestSelectedEventFromLog();
    refreshRelatedEventHighlight();
    renderSelectedPanel();
    syncFollowTargetState();
    if (agentId) {
      openPanel('target');
      const fp = getSelectedFocusPoint();
      if (fp) {
        jumpToTarget(fp);
        if (Number.isFinite(fp.lat) && Number.isFinite(fp.lng)) {
          selectedTargetCoords = { lat: fp.lat, lng: fp.lng };
          showStreetView(fp.lat, fp.lng);
        }
      }
    } else {
      selectedTargetCoords = null;
      hideStreetView();
    }
    draw();
  }

  function selectRegion(regionId) {
    selectedRegionId = regionId || null;
    selectedAgentId = null;
    updateLatestSelectedEventFromLog();
    refreshRelatedEventHighlight();
    renderSelectedPanel();
    syncFollowTargetState();
    if (regionId) {
      openPanel('target');
      const fp = getSelectedFocusPoint();
      if (fp) {
        jumpToTarget(fp);
        if (Number.isFinite(fp.lat) && Number.isFinite(fp.lng)) {
          selectedTargetCoords = { lat: fp.lat, lng: fp.lng };
          showStreetView(fp.lat, fp.lng);
        }
      }
    } else {
      selectedTargetCoords = null;
      hideStreetView();
    }
    draw();
  }

  function getSelectedFocusPoint() {
    if (selectedAgentId && state.agents[selectedAgentId]) {
      const selected = state.agents[selectedAgentId];
      const point = getEntityWorldPoint(selected);
      return { x: point.x, y: point.y, lat: point.lat, lng: point.lng, kind: 'agent' };
    }
    if (selectedRegionId && state.regions[selectedRegionId]) {
      const selected = state.regions[selectedRegionId];
      const point = getEntityWorldPoint(selected);
      return { x: point.x, y: point.y, lat: point.lat, lng: point.lng, kind: 'region' };
    }
    return null;
  }

  function getViewportOffsetToCenterWorld(worldX, worldY, width, height, lat, lng) {
    if (isGlobeRenderMode()) {
      const globePoint = projectGlobePosition(worldX, worldY, width, height, lat, lng, GLOBE_ENTITY_MIN_Z);
      if (!globePoint) return { x: viewport.offsetX, y: viewport.offsetY };
      return {
        x: -((globePoint.baseX - (width / 2)) * viewport.zoom),
        y: -((globePoint.baseY - (height / 2)) * viewport.zoom),
      };
    }
    const baseX = (worldX / 100) * width;
    const baseY = (worldY / 100) * height;
    return {
      x: -((baseX - (width / 2)) * viewport.zoom),
      y: -((baseY - (height / 2)) * viewport.zoom),
    };
  }

  // Camera auto-motion is disabled. This stub resets any stale follow/lerp state
  // on each draw tick and returns false so the render loop does not reschedule
  // on its behalf.
  function updateCameraMotion(width, height) {
    // Cesium orbital motion is handled natively by the screenSpaceCameraController.
    // Follow state (followTargetEnabled, cameraLerpTarget) is managed by the toggle
    // and disengaged via camera.moveStart — do NOT clear it here every tick.
    return false;
  }

  function syncFollowTargetState() {
    if (!followTargetEnabled) return;
    const selectedFocusPoint = getSelectedFocusPoint();
    if (!selectedFocusPoint) {
      followTargetEnabled = false;
      cameraLerpTarget = null;
      followTargetToggleEl.checked = false;
      return;
    }
    cameraLerpTarget = selectedFocusPoint;
  }

  function worldToCanvas(x, y, width, height, lat, lng, minZ, globeDebug) {
    return worldPointToCanvas({ x, y, lat, lng }, width, height, minZ, globeDebug);
  }

  function worldPointToCanvas(point, width, height, minZ, globeDebug) {
    return projectWorldPosition(
      Number.isFinite(point && point.x) ? point.x : 50,
      Number.isFinite(point && point.y) ? point.y : 50,
      width,
      height,
      point ? point.lat : null,
      point ? point.lng : null,
      minZ,
      globeDebug
    );
  }

  function projectWorldPosition(worldX, worldY, width, height, lat, lng, minZ, globeDebug) {
    if (isGlobeRenderMode()) {
      const minVisibleZ = Number.isFinite(minZ) ? minZ : 0;
      const globePoint = projectGlobePosition(worldX, worldY, width, height, lat, lng, minVisibleZ, globeDebug);
      if (!globePoint) return null;
      return { x: applyViewportX(globePoint.baseX, width), y: applyViewportY(globePoint.baseY, height) };
    }
    return projectGridPosition(worldX, worldY, width, height);
  }

  function projectGridPosition(worldX, worldY, width, height) {
    const baseX = (worldX / 100) * width;
    const baseY = (worldY / 100) * height;
    return { x: applyViewportX(baseX, width), y: applyViewportY(baseY, height) };
  }

  function getEntityWorldPoint(entity, nowMs) {
    if (!entity) return { x: 0, y: 0, lat: null, lng: null };
    if (isOpenSkyFlight(entity)) return getRenderableOpenSkyPoint(entity, nowMs);
    const hasLatLng = Number.isFinite(entity.lat) && Number.isFinite(entity.lng);
    return {
      x: Number.isFinite(entity.x) ? entity.x : 50,
      y: Number.isFinite(entity.y) ? entity.y : 50,
      lat: hasLatLng ? entity.lat : null,
      lng: hasLatLng ? entity.lng : null,
    };
  }

  function isOpenSkyFlight(entity) {
    return !!(entity && entity.type === 'flight' && entity.source === 'opensky');
  }

  function normalizeLng(lng) {
    if (!Number.isFinite(lng)) return lng;
    let normalized = lng;
    while (normalized > 180) normalized -= 360;
    while (normalized < -180) normalized += 360;
    return normalized;
  }

  function projectLatLngByHeading(lat, lng, headingDeg, distanceKm) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(headingDeg) || !Number.isFinite(distanceKm)) return null;
    const angularDistance = distanceKm / 6371;
    if (angularDistance <= 0) return { lat, lng };
    const bearing = headingDeg * (Math.PI / 180);
    const lat1 = lat * (Math.PI / 180);
    const lng1 = lng * (Math.PI / 180);
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    const sinAd = Math.sin(angularDistance);
    const cosAd = Math.cos(angularDistance);
    const lat2 = Math.asin((sinLat1 * cosAd) + (cosLat1 * sinAd * Math.cos(bearing)));
    const lng2 = lng1 + Math.atan2(
      Math.sin(bearing) * sinAd * cosLat1,
      cosAd - (sinLat1 * Math.sin(lat2))
    );
    return {
      lat: Math.max(-89.9, Math.min(89.9, lat2 * (180 / Math.PI))),
      lng: normalizeLng(lng2 * (180 / Math.PI)),
    };
  }

  function getRenderableOpenSkyPoint(entity, nowMs) {
    const tracking = flightTrackingById[entity.id];
    const hasLatLng = Number.isFinite(entity.lat) && Number.isFinite(entity.lng);
    const basePoint = {
      x: Number.isFinite(entity.x) ? entity.x : 50,
      y: Number.isFinite(entity.y) ? entity.y : 50,
      lat: hasLatLng ? entity.lat : null,
      lng: hasLatLng ? entity.lng : null,
      heading: Number.isFinite(entity.heading) ? entity.heading : null,
      speed: Number.isFinite(entity.speed) ? entity.speed : null,
      verticalRate: Number.isFinite(entity.verticalRate) ? entity.verticalRate : null,
      altitude: Number.isFinite(entity.altitude) ? entity.altitude : null,
    };
    if (!tracking || !Number.isFinite(basePoint.lat) || !Number.isFinite(basePoint.lng)) return basePoint;
    const tNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    const dtMs = Math.max(0, Math.min(FLIGHT_TRACK_EXTRAPOLATION_MAX_MS, tNow - (tracking.lastUpdateMs || tNow)));
    const speedMps = Number.isFinite(basePoint.speed) ? basePoint.speed : (Number.isFinite(tracking.speed) ? tracking.speed : null);
    const heading = Number.isFinite(basePoint.heading) ? basePoint.heading : (Number.isFinite(tracking.heading) ? tracking.heading : null);
    if (!Number.isFinite(speedMps) || !Number.isFinite(heading) || speedMps <= 0.5 || dtMs <= 0) return basePoint;
    const extrapolated = projectLatLngByHeading(basePoint.lat, basePoint.lng, heading, (speedMps * (dtMs / 1000)) / 1000);
    if (!extrapolated) return basePoint;
    const mapped = latLngToGrid(extrapolated.lat, extrapolated.lng);
    return {
      x: mapped.x,
      y: mapped.y,
      lat: extrapolated.lat,
      lng: extrapolated.lng,
      heading,
      speed: speedMps,
      verticalRate: Number.isFinite(basePoint.verticalRate) ? basePoint.verticalRate : tracking.verticalRate,
      altitude: Number.isFinite(basePoint.altitude) ? basePoint.altitude : tracking.altitude,
    };
  }

  function getFlightTrailPoints(agent) {
    const tracking = flightTrackingById[agent.id];
    if (tracking && Array.isArray(tracking.trail)) return tracking.trail.slice(-FLIGHT_TRAIL_MAX_POINTS);
    if (Array.isArray(agent.trail)) return agent.trail.slice(-FLIGHT_TRAIL_MAX_POINTS);
    return [];
  }

  function applyViewportX(baseX, width) {
    return ((baseX - (width / 2)) * viewport.zoom) + (width / 2) + viewport.offsetX;
  }

  function applyViewportY(baseY, height) {
    return ((baseY - (height / 2)) * viewport.zoom) + (height / 2) + viewport.offsetY;
  }

  function canvasToBase(mx, my) {
    const W = canvas.width;
    const H = canvas.height;
    return {
      x: ((mx - (W / 2) - viewport.offsetX) / viewport.zoom) + (W / 2),
      y: ((my - (H / 2) - viewport.offsetY) / viewport.zoom) + (H / 2),
    };
  }

  function updateViewportReadout() {
    let text;
    if (USE_CESIUM) {
      text = cesiumStreetLevelMode ? 'drone' : 'orbit free';
      if (cesiumViewer) {
        const h = cesiumViewer.camera.positionCartographic.height;
        const altKm = h >= 1000 ? (h / 1000).toFixed(0) + ' km' : Math.round(h) + ' m';
        text += ' · alt ' + altKm;
        const pitch = Cesium.Math.toDegrees(cesiumViewer.camera.pitch).toFixed(0);
        text += ' · pitch ' + pitch + '°';
        if (cesiumFocusModeActive) text += ' · focus lock';
      }
      text += ' · e:' + lastCesiumRenderCounts.entities + ' r:' + lastCesiumRenderCounts.regions + ' s:' + lastCesiumRenderCounts.satellites;
      text += ' · tiles:' + (lastCesiumRenderCounts.tilesState || (lastCesiumRenderCounts.tilesLoaded ? 'on' : 'off'));
    } else {
      text = 'zoom ' + viewport.zoom.toFixed(2) + 'x · pan ' + Math.round(viewport.offsetX) + ', ' + Math.round(viewport.offsetY);
    }
    if (USE_CESIUM) {
      if (layerState.weather) text += ' · weather:not configured';
    } else if (isGlobeRenderMode() && globeOverlayDiagnostics) {
      text += ' · vis e:' + globeOverlayDiagnostics.entitiesVisible
        + ' r:' + globeOverlayDiagnostics.regionsVisible
        + ' t:' + globeOverlayDiagnostics.trailsVisible;
      if (GLOBE_DISABLE_VISIBILITY_CULLING) text += ' · culling off';
      text += ' · dbg regions:' + (globeOverlayDiagnostics.regionOverlaySuppressed ? 'off' : 'on');
      text += ' entities:' + (globeOverlayDiagnostics.entitiesVisible > 0 ? 'visible' : 'none');
      text += ' trails:' + (globeOverlayDiagnostics.trailsVisible > 0 ? 'visible' : 'none');
    }
    viewportReadoutEl.textContent = text;
  }

  // ── Jump-to-target camera helpers ─────────────────────────────────────────

  // Extract {lat, lng} from any target type (agent, region, flight, event).
  // Returns null when coordinates are absent or non-finite.
  function resolveTargetLatLng(target) {
    if (!target) return null;
    // Direct lat/lng on the object (agent, flight, event)
    const ll = toLatLngWithFallback(target);
    if (ll) return ll;
    // Region: look up live state by id
    if ((target.kind === 'region' || target.type === 'region') && target.id) {
      const region = state.regions[target.id];
      if (region) return toLatLngWithFallback(region);
    }
    return null;
  }

  // Type-appropriate orbit altitude (metres) for a comfortable framing distance.
  function getTargetOrbitDistance(target) {
    if (!target) return 1500000;
    const kind = target.kind || getEntityType(target);
    if (kind === 'region')    return 1200000;
    if (kind === 'satellite') return 2000000;
    if (kind === 'flight')    return 600000;
    if (kind === 'point')     return 300000;
    return 800000; // agent / default
  }

  // Update follow-tracking state so continuous tracking uses the new target.
  function setOrbitTarget(target) {
    if (!target) { cesiumCameraLerpState = null; return; }
    const ll = resolveTargetLatLng(target);
    if (!ll) { cesiumCameraLerpState = null; return; }
    cesiumCameraLerpState = { lng: ll.lng, lat: ll.lat, height: getTargetOrbitDistance(target) };
  }

  // Smoothly fly to any target and frame it correctly.
  // Handles agents, regions, flights, and point events.
  // Fails gracefully when coordinates are missing.
  // If follow mode is on, tracking continues after landing.
  function jumpToTarget(target) {
    if (!target) return;
    if (!USE_CESIUM || !cesiumViewer) {
      // 2-D canvas fallback: set lerp target and let draw() handle it
      const ll = resolveTargetLatLng(target);
      if (!ll) return;
      cameraLerpTarget = { lat: ll.lat, lng: ll.lng, kind: target.kind || 'agent', x: 50, y: 50 };
      draw();
      return;
    }
    const ll = resolveTargetLatLng(target);
    if (!ll) return; // graceful: missing/invalid coords → no camera move, no error
    const dist  = getTargetOrbitDistance(target);
    const pitch = (target.kind === 'region')
      ? Cesium.Math.toRadians(-75)
      : Cesium.Math.toRadians(-55);
    cesiumCameraMoveInternal = true;
    cesiumFollowDisengageMutedUntil = Date.now() + 2500;
    cesiumViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, dist),
      orientation: { heading: 0, pitch: pitch, roll: 0 },
      duration: 1.8,
      complete: function () {
        cesiumCameraMoveInternal = false;
        if (followTargetEnabled) setOrbitTarget(target);
      },
      cancel: function () { cesiumCameraMoveInternal = false; },
    });
    // Clear 2-D lerp state; if free-orbit (no follow), also clear Cesium lerp
    cameraLerpTarget = null;
    if (!followTargetEnabled) cesiumCameraLerpState = null;
  }

    // Programmatic zoom for +/- buttons: move camera closer/farther by a factor.
  // factor < 1 = zoom in (e.g. 0.6 = 40% closer); factor > 1 = zoom out.
  // Scroll-wheel and pinch are handled natively by Cesium ssc (enableZoom = true).
  function zoomBy(factor) {
    if (!USE_CESIUM || !cesiumViewer) return;
    const h = cesiumViewer.camera.positionCartographic.height;
    const next = Math.max(10, Math.min(40000000, h * factor));
    const cart = cesiumViewer.camera.positionCartographic.clone();
    cart.height = next;
    cesiumViewer.camera.position = Cesium.Ellipsoid.WGS84.cartographicToCartesian(cart);
    updateViewportReadout();
  }

  function setViewportZoom(nextZoom) {
    // 2-D canvas renderer only; Cesium zoom goes through zoomBy() and native ssc.
    viewport.zoom = Math.max(VIEWPORT_ZOOM_MIN, Math.min(VIEWPORT_ZOOM_MAX, nextZoom));
    syncFollowTargetState();
    updateViewportReadout();
    draw();
  }

  function panViewport(dx, dy) {
    if (USE_CESIUM && cesiumViewer) {
      // Orbit the camera around the globe center (5 degrees per click)
      const panRad = 5 * Math.PI / 180;
      if (dx < 0) cesiumViewer.camera.rotateLeft(panRad);
      else if (dx > 0) cesiumViewer.camera.rotateRight(panRad);
      if (dy < 0) cesiumViewer.camera.rotateUp(panRad);
      else if (dy > 0) cesiumViewer.camera.rotateDown(panRad);
      return;
    }
    if (isGlobeRenderMode()) return;
    viewport.offsetX += dx;
    viewport.offsetY += dy;
    updateViewportReadout();
    draw();
  }

  function resetViewport() {
    viewport.zoom = 1;
    viewport.offsetX = 0;
    viewport.offsetY = 0;
    cameraLerpTarget = null;
    cesiumCameraLerpState = null;
    followTargetEnabled = false;
    followTargetToggleEl.checked = false;
    if (USE_CESIUM && cesiumViewer) {
      cesiumCameraMoveInternal = true;
      cesiumFollowDisengageMutedUntil = Date.now() + 2000;
      cesiumViewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-95, 25, 20000000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-82), roll: 0 },
        duration: 1.5,
        complete: function () { cesiumCameraMoveInternal = false; },
        cancel:   function () { cesiumCameraMoveInternal = false; },
      });
    }
    updateViewportReadout();
    draw();
  }

  function updateAgentTrails(prevAgents, nextAgents) {
    const prev = prevAgents || {};
    const next = nextAgents || {};
    const nextTrails = {};

    for (const id of Object.keys(next)) {
      const nextAgent = next[id];
      const prevAgent = prev[id];
      const existing = agentTrails[id] || [];
      const trail = existing.slice(-TRAIL_MAX_POINTS);

      if (trail.length === 0 || !prevAgent) {
        trail.push({ x: nextAgent.x, y: nextAgent.y, lat: nextAgent.lat, lng: nextAgent.lng });
      } else if (prevAgent.x !== nextAgent.x || prevAgent.y !== nextAgent.y) {
        trail.push({ x: nextAgent.x, y: nextAgent.y, lat: nextAgent.lat, lng: nextAgent.lng });
      }

      nextTrails[id] = trail.slice(-TRAIL_MAX_POINTS);
    }

    agentTrails = nextTrails;
  }

  function updateFlightTracking(prevAgents, nextAgents, snapshotTsMs) {
    const prev = prevAgents || {};
    const next = nextAgents || {};
    const nextTracking = {};
    for (const id of Object.keys(next)) {
      const nextAgent = next[id];
      if (!isOpenSkyFlight(nextAgent)) continue;
      const prevAgent = prev[id];
      const existing = flightTrackingById[id] || {};
      const priorTrail = Array.isArray(nextAgent.trail) ? nextAgent.trail : (Array.isArray(existing.trail) ? existing.trail : []);
      const trail = priorTrail.slice(-FLIGHT_TRAIL_MAX_POINTS);
      const lat = Number.isFinite(nextAgent.lat) ? nextAgent.lat : null;
      const lng = Number.isFinite(nextAgent.lng) ? nextAgent.lng : null;
      const hasTrailPoint = Number.isFinite(lat) && Number.isFinite(lng);
      const moved = !prevAgent
        || !Number.isFinite(prevAgent.lat)
        || !Number.isFinite(prevAgent.lng)
        || Math.abs(prevAgent.lat - lat) > 0.0001
        || Math.abs(prevAgent.lng - lng) > 0.0001;
      if (hasTrailPoint && (trail.length === 0 || moved)) {
        trail.push({ lat, lng, ts: snapshotTsMs });
      }
      nextTracking[id] = {
        prevLat: Number.isFinite(existing.lastLat) ? existing.lastLat : (prevAgent ? prevAgent.lat : null),
        prevLng: Number.isFinite(existing.lastLng) ? existing.lastLng : (prevAgent ? prevAgent.lng : null),
        lastLat: lat,
        lastLng: lng,
        trail: trail.slice(-FLIGHT_TRAIL_MAX_POINTS),
        lastUpdateMs: snapshotTsMs,
        heading: Number.isFinite(nextAgent.heading) ? nextAgent.heading : (existing.heading ?? null),
        speed: Number.isFinite(nextAgent.speed) ? nextAgent.speed : (existing.speed ?? null),
        verticalRate: Number.isFinite(nextAgent.verticalRate) ? nextAgent.verticalRate : (existing.verticalRate ?? null),
        altitude: Number.isFinite(nextAgent.altitude) ? nextAgent.altitude : (existing.altitude ?? null),
        source: 'opensky',
      };
    }
    flightTrackingById = nextTracking;
  }

  function findNearestAgentAtPoint(mx, my) {
    if (!showAgents) return { agent: null, distance: null };
    let nearest = null;
    let nearestDistSq = Infinity;
    for (const a of Object.values(state.agents)) {
      if (!isEntityTypeVisible(getEntityType(a))) continue;
      const point = getEntityWorldPoint(a);
      const pt = worldToCanvas(point.x, point.y, canvas.width, canvas.height, point.lat, point.lng);
      if (!pt) continue;
      const dx = mx - pt.x;
      const dy = my - pt.y;
      const distSq = (dx * dx) + (dy * dy);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = a;
      }
    }
    const hitRadiusSq = (AGENT_HIT_RADIUS / viewport.zoom) * (AGENT_HIT_RADIUS / viewport.zoom);
    return (nearest && nearestDistSq <= hitRadiusSq)
      ? { agent: nearest, distance: Math.sqrt(nearestDistSq) }
      : { agent: null, distance: null };
  }

  function findRegionAtPoint(mx, my) {
    if (!showRegions || !layerState.regions) return null;
    for (const r of Object.values(state.regions)) {
      if (isGlobeRenderMode()) {
        const overlay = getRegionGlobeOverlay(r, canvas.width, canvas.height);
        if (overlay) {
          if (overlay.shape === 'circle') {
            const d = Math.hypot(mx - overlay.cx, my - overlay.cy);
            if (d <= overlay.radius) return r;
          } else if (pointInPolygon(mx, my, overlay.points)) {
            return r;
          }
          continue;
        }
      }
      const point = getEntityWorldPoint(r);
      const pt = worldToCanvas(point.x, point.y, canvas.width, canvas.height, point.lat, point.lng);
      if (!pt) continue;
      const regionHalfSize = (30 * viewport.zoom);
      if (mx >= pt.x - regionHalfSize && mx <= pt.x + regionHalfSize && my >= pt.y - regionHalfSize && my <= pt.y + regionHalfSize) {
        return r;
      }
    }
    return null;
  }

  function drawGlobeBase(width, height) {
    if (!LEGACY_CANVAS_RENDERER) return;
    const radius = Math.min(width, height) * 0.35 * viewport.zoom;
    const cx = applyViewportX(width / 2, width);
    const cy = applyViewportY(height / 2, height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#10233c';
    ctx.fill();
    ctx.strokeStyle = '#355a86';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawGlobeContinents(width, height) {
    if (!LEGACY_CANVAS_RENDERER) return;
    ctx.save();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = '#9fc8f033';
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#8ec5ff22';
    GLOBE_CONTINENT_OUTLINES.forEach(function (polygon) {
      if (!polygon || polygon.length < 2) return;
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i];
        const projected = worldToCanvas(50, 50, width, height, p.lat, p.lng, GLOBE_CONTINENT_MIN_Z);
        if (!projected) {
          penDown = false;
          continue;
        }
        if (!penDown) {
          ctx.moveTo(projected.x, projected.y);
          penDown = true;
        } else {
          ctx.lineTo(projected.x, projected.y);
        }
      }
      if (penDown) ctx.stroke();
    });
    ctx.restore();
  }

  function drawGlobeGridOverlay(width, height) {
    ctx.save();
    ctx.strokeStyle = '#90b8dd2d';
    ctx.lineWidth = 1;
    for (let lat = -75; lat <= 75; lat += 15) {
      drawLatitudeLine(lat, width, height);
    }
    for (let lng = -180; lng < 180; lng += 15) {
      drawLongitudeLine(lng, width, height);
    }
    ctx.restore();
  }

  function drawLatitudeLine(lat, width, height) {
    let penDown = false;
    ctx.beginPath();
    for (let lng = -180; lng <= 180; lng += 4) {
      const point = worldToCanvas(50, 50, width, height, lat, lng, 0.005);
      if (!point) {
        penDown = false;
        continue;
      }
      if (!penDown) {
        ctx.moveTo(point.x, point.y);
        penDown = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    if (penDown) ctx.stroke();
  }

  function drawLongitudeLine(lng, width, height) {
    let penDown = false;
    ctx.beginPath();
    for (let lat = -85; lat <= 85; lat += 4) {
      const point = worldToCanvas(50, 50, width, height, lat, lng, 0.005);
      if (!point) {
        penDown = false;
        continue;
      }
      if (!penDown) {
        ctx.moveTo(point.x, point.y);
        penDown = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    if (penDown) ctx.stroke();
  }

  function pointInPolygon(mx, my, points) {
    if (!points || points.length < 3) return false;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const intersect = ((yi > my) !== (yj > my))
        && (mx < (((xj - xi) * (my - yi)) / ((yj - yi) || 1e-6)) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function drawRegionOverlayShape(overlay, expandPx) {
    const grow = Number.isFinite(expandPx) ? expandPx : 0;
    ctx.beginPath();
    if (overlay.shape === 'circle') {
      ctx.arc(overlay.cx, overlay.cy, Math.max(2, overlay.radius + grow), 0, Math.PI * 2);
      return;
    }
    const points = overlay.points || [];
    if (points.length < 2) return;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  function getRegionGlobeOverlay(region, width, height, globeDebug) {
    if (!hasLatLng(region)) return null;
    if (region.bounds) return getBoundsOverlay(region.bounds, width, height, GLOBE_REGION_OUTLINE_MIN_Z, globeDebug);
    const radiusDeg = Number.isFinite(region.radiusDeg) ? region.radiusDeg : null;
    if (!radiusDeg) return null;
    const center = worldToCanvas(region.x, region.y, width, height, region.lat, region.lng, GLOBE_REGION_OUTLINE_MIN_Z, globeDebug);
    if (!center) return null;
    const edge = worldToCanvas(region.x, region.y, width, height, region.lat + radiusDeg, region.lng, GLOBE_REGION_OUTLINE_MIN_Z, globeDebug);
    const radiusPx = edge ? Math.hypot(edge.x - center.x, edge.y - center.y) : Math.max(10, radiusDeg * 1.2);
    return { shape: 'circle', cx: center.x, cy: center.y, radius: radiusPx, labelX: center.x, labelY: center.y };
  }

  function getBoundsOverlay(bounds, width, height, minZ, globeDebug) {
    if (!bounds || !Number.isFinite(bounds.north) || !Number.isFinite(bounds.south)
      || !Number.isFinite(bounds.west) || !Number.isFinite(bounds.east)) return null;
    const b = bounds;
    const rawPoints = [];
    const segments = 8;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      rawPoints.push({ lat: b.north, lng: interpolateLng(b.west, b.east, t) });
    }
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      rawPoints.push({ lat: b.north + ((b.south - b.north) * t), lng: b.east });
    }
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      rawPoints.push({ lat: b.south, lng: interpolateLng(b.east, b.west, t) });
    }
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      rawPoints.push({ lat: b.south + ((b.north - b.south) * t), lng: b.west });
    }
    const points = rawPoints.map(function (p) {
      return worldToCanvas(50, 50, width, height, p.lat, p.lng, minZ, globeDebug);
    }).filter(Boolean);
    if (points.length < 3) return null;
    const labelPoint = averageCanvasPoint(points);
    return { shape: 'polygon', points, labelX: labelPoint.x, labelY: labelPoint.y };
  }

  function drawFlightArcPath(agent, trail, width, height, isSelected, typeStyle, globeDebug, nowMs) {
    const currentPoint = getEntityWorldPoint(agent, nowMs);
    const prior = trail[Math.max(0, trail.length - 2)] || trail[0];
    const start = worldPointToUnitVector(prior.x, prior.y, prior.lat, prior.lng);
    const end = worldPointToUnitVector(currentPoint.x, currentPoint.y, currentPoint.lat, currentPoint.lng);
    if (!start || !end) return false;
    const dot = Math.max(-1, Math.min(1, (start.x * end.x) + (start.y * end.y) + (start.z * end.z)));
    const omega = Math.acos(dot);
    const sinOmega = Math.sin(omega);
    const flightMinZ = agent && agent.source === 'opensky' ? GLOBE_FLIGHT_MIN_Z : GLOBE_PATH_MIN_Z;
    ctx.save();
    ctx.beginPath();
    let moved = false;
    for (let i = 0; i <= GLOBE_FLIGHT_ARC_SEGMENTS; i++) {
      const t = i / GLOBE_FLIGHT_ARC_SEGMENTS;
      const interpolation = slerp(start, end, t, omega, sinOmega);
      if (!interpolation) continue;
      const lift = 1 + (0.11 * Math.sin(Math.PI * t));
      const point = vectorToCanvas(interpolation.x * lift, interpolation.y * lift, interpolation.z * lift, width, height, flightMinZ);
      if (!point) continue;
      if (!moved) {
        ctx.moveTo(point.x, point.y);
        moved = true;
      } else {
        ctx.lineTo(point.x, point.y);
        if (globeDebug) globeDebug.pathSegmentsDrawn++;
      }
    }
    if (!moved) {
      ctx.restore();
      return false;
    }
    ctx.strokeStyle = isSelected ? typeStyle.trailSelected : typeStyle.trail;
    ctx.lineWidth = isSelected ? 2.6 : 1.4;
    if (isSelected) {
      ctx.shadowBlur = 8;
      ctx.shadowColor = typeStyle.stroke;
    }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  function drawFlightForwardVector(agent, width, height, isSelected, typeStyle, globeDebug, nowMs) {
    const point = getEntityWorldPoint(agent, nowMs);
    const headingRaw = Number(agent.heading);
    const speedRaw = Number(agent.speed);
    const heading = Number.isFinite(point.heading) ? point.heading : (Number.isFinite(headingRaw) ? headingRaw : null);
    const speedMps = Number.isFinite(point.speed) ? point.speed : (Number.isFinite(speedRaw) ? speedRaw : null);
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
    if (!Number.isFinite(heading) || !Number.isFinite(speedMps) || speedMps < FORWARD_VECTOR_MIN_SPEED_MPS) return false;
    const lookAheadKm = Math.min(FORWARD_VECTOR_MAX_DISTANCE_KM, Math.max(8, (speedMps * FORWARD_VECTOR_LOOKAHEAD_SEC) / 1000));
    const projected = projectLatLngByHeading(point.lat, point.lng, heading, lookAheadKm);
    if (!projected) return false;
    const nose = worldPointToCanvas(point, width, height, GLOBE_FLIGHT_MIN_Z, globeDebug);
    const future = worldPointToCanvas(projected, width, height, GLOBE_FLIGHT_MIN_Z, globeDebug);
    if (!nose || !future) return false;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(future.x, future.y);
    ctx.strokeStyle = isSelected ? '#ffeec8' : '#ffd8b4aa';
    ctx.lineWidth = isSelected ? 2.4 : 1.2;
    if (isSelected) {
      ctx.shadowBlur = 7;
      ctx.shadowColor = typeStyle.stroke;
    }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  function drawSatelliteOrbitBand(agent, width, height, isSelected, typeStyle, globeDebug) {
    const point = getEntityWorldPoint(agent);
    const centerLat = Number.isFinite(point.lat) ? point.lat : 0;
    const centerLng = Number.isFinite(point.lng) ? point.lng : ((point.x / 100) * 360) - 180;
    ctx.save();
    ctx.beginPath();
    let moved = false;
    for (let i = 0; i <= GLOBE_ORBIT_SEGMENTS; i++) {
      const t = i / GLOBE_ORBIT_SEGMENTS;
      const orbitLng = wrapLng(centerLng + ((t * 360) - 180));
      const orbitLat = Math.max(-70, Math.min(70, centerLat + (10 * Math.sin((t * Math.PI * 2) + (centerLng * Math.PI / 180)))));
      const vector = worldPointToUnitVector(50, 50, orbitLat, orbitLng);
      if (!vector) continue;
      const pointOnBand = vectorToCanvas(vector.x * 1.06, vector.y * 1.06, vector.z * 1.06, width, height, GLOBE_PATH_MIN_Z);
      if (!pointOnBand) continue;
      if (!moved) {
        ctx.moveTo(pointOnBand.x, pointOnBand.y);
        moved = true;
      } else {
        ctx.lineTo(pointOnBand.x, pointOnBand.y);
        if (globeDebug) globeDebug.pathSegmentsDrawn++;
      }
    }
    if (!moved) {
      ctx.restore();
      return false;
    }
    ctx.closePath();
    ctx.strokeStyle = isSelected ? typeStyle.trailSelected : typeStyle.trail;
    ctx.lineWidth = isSelected ? 2.4 : 1.1;
    if (isSelected) {
      ctx.shadowBlur = 7;
      ctx.shadowColor = typeStyle.stroke;
    }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  function wrapLng(lng) {
    if (!Number.isFinite(lng)) return 0;
    let wrapped = lng;
    while (wrapped > 180) wrapped -= 360;
    while (wrapped < -180) wrapped += 360;
    return wrapped;
  }

  function slerp(a, b, t, omega, sinOmega) {
    if (!Number.isFinite(omega) || Math.abs(sinOmega) < 1e-5) {
      return normalizeVector({
        x: a.x + ((b.x - a.x) * t),
        y: a.y + ((b.y - a.y) * t),
        z: a.z + ((b.z - a.z) * t),
      });
    }
    const scaleA = Math.sin((1 - t) * omega) / sinOmega;
    const scaleB = Math.sin(t * omega) / sinOmega;
    return normalizeVector({
      x: (a.x * scaleA) + (b.x * scaleB),
      y: (a.y * scaleA) + (b.y * scaleB),
      z: (a.z * scaleA) + (b.z * scaleB),
    });
  }

  function worldPointToUnitVector(worldX, worldY, lat, lng) {
    const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng);
    const lon = hasLatLng
      ? (Math.max(-180, Math.min(180, lng)) * (Math.PI / 180))
      : ((Math.max(0, Math.min(100, worldX)) / 100) * Math.PI * 2) - Math.PI;
    const latRad = hasLatLng
      ? (Math.max(-90, Math.min(90, lat)) * (Math.PI / 180))
      : ((0.5 - (Math.max(0, Math.min(100, worldY)) / 100)) * Math.PI);
    const cosLat = Math.cos(latRad);
    return normalizeVector({
      x: cosLat * Math.sin(lon),
      y: Math.sin(latRad),
      z: cosLat * Math.cos(lon),
    });
  }

  function normalizeVector(v) {
    const mag = Math.sqrt((v.x * v.x) + (v.y * v.y) + (v.z * v.z));
    if (!Number.isFinite(mag) || mag <= 1e-6) return null;
    return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
  }

  function vectorToCanvas(x, y, z, width, height, minZ) {
    if (!Number.isFinite(z)) return null;
    if (!GLOBE_DISABLE_VISIBILITY_CULLING && Number.isFinite(minZ) && z < minZ) return null;
    const radius = Math.min(width, height) * 0.35;
    const cx = width / 2;
    const cy = height / 2;
    const baseX = cx + (radius * x);
    const baseY = cy - (radius * y);
    return {
      x: applyViewportX(baseX, width),
      y: applyViewportY(baseY, height),
    };
  }

  function projectGlobePosition(worldX, worldY, width, height, lat, lng, minZ, globeDebug) {
    const radius = Math.min(width, height) * 0.35;
    const cx = width / 2;
    const cy = height / 2;
    const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng);
    const lon = hasLatLng
      ? (Math.max(-180, Math.min(180, lng)) * (Math.PI / 180))
      : ((Math.max(0, Math.min(100, worldX)) / 100) * Math.PI * 2) - Math.PI;
    const latRad = hasLatLng
      ? (Math.max(-90, Math.min(90, lat)) * (Math.PI / 180))
      : ((0.5 - (Math.max(0, Math.min(100, worldY)) / 100)) * Math.PI);
    const cosLat = Math.cos(latRad);
    const unitX = cosLat * Math.sin(lon);
    const unitY = Math.sin(latRad);
    const unitZ = cosLat * Math.cos(lon);
    if (globeDebug) globeDebug.projected++;
    if (!Number.isFinite(unitX) || !Number.isFinite(unitY) || !Number.isFinite(unitZ)) {
      if (globeDebug) { globeDebug.skipped++; globeDebug.invalidProjected++; }
      return null;
    }
    if (globeDebug) {
      globeDebug.zMin = Math.min(globeDebug.zMin, unitZ);
      globeDebug.zMax = Math.max(globeDebug.zMax, unitZ);
    }
    if (!GLOBE_DISABLE_VISIBILITY_CULLING && Number.isFinite(minZ) && unitZ < minZ) {
      if (globeDebug) globeDebug.skipped++;
      return null;
    }
    const baseX = cx + (radius * unitX);
    const baseY = cy - (radius * Math.sin(latRad));
    if (!Number.isFinite(baseX) || !Number.isFinite(baseY)) {
      if (globeDebug) { globeDebug.skipped++; globeDebug.invalidProjected++; }
      return null;
    }
    return { baseX, baseY, z: unitZ, x: unitX, y: unitY };
  }

  function averageCanvasPoint(points) {
    if (!points || points.length === 0) return { x: 0, y: 0 };
    const sums = points.reduce(function (acc, p) {
      acc.x += p.x;
      acc.y += p.y;
      return acc;
    }, { x: 0, y: 0 });
    return { x: sums.x / points.length, y: sums.y / points.length };
  }

  function interpolateLng(start, end, t) {
    return wrapLng(start + ((end - start) * t));
  }

  function getRegionOccupancy() {
    const occupancy = {};
    for (const id of Object.keys(state.regions || {})) occupancy[id] = 0;
    for (const a of Object.values(state.agents || {})) {
      if (!isEntityTypeVisible(getEntityType(a))) continue;
      if (typeof occupancy[a.region] !== 'number') occupancy[a.region] = 0;
      occupancy[a.region]++;
    }
    return occupancy;
  }

  function inferEventRegionIds(ev, regionToEntitySet) {
    const matched = {};
    const msg = String((ev && ev.msg) || '');
    for (const regionId of Object.keys(state.regions || {})) {
      if (msg.includes(regionId)) matched[regionId] = true;
    }
    for (const regionId of Object.keys(regionToEntitySet)) {
      if (matched[regionId]) continue;
      const entitySet = regionToEntitySet[regionId];
      for (const entityId of entitySet) {
        if (msg.includes(entityId)) {
          matched[regionId] = true;
          break;
        }
      }
    }
    return Object.keys(matched);
  }

  function deriveRegionStatus(eventCount, movementCount) {
    if (eventCount >= REGION_HOT_EVENT_THRESHOLD || movementCount >= REGION_HOT_MOVEMENT_THRESHOLD) return 'HOT';
    if (eventCount >= REGION_ACTIVE_EVENT_THRESHOLD || movementCount >= REGION_ACTIVE_MOVEMENT_THRESHOLD) return 'ACTIVE';
    return 'IDLE';
  }

  function computeRegionIntelligence() {
    const regionOccupancy = getRegionOccupancy();
    const intel = {};
    const regionToEntitySet = {};
    const movementCountByRegion = {};
    const currentTick = Number.isFinite(state.tick) ? state.tick : 0;
    const minTick = currentTick - REGION_ACTIVITY_WINDOW_TICKS;

    for (const regionId of Object.keys(state.regions || {})) {
      intel[regionId] = {
        occupancy: regionOccupancy[regionId] || 0,
        activityLevel: 0,
        lastEventTs: null,
        status: 'IDLE',
        entitiesInside: [],
        relatedEntities: [],
      };
      regionToEntitySet[regionId] = new Set();
      movementCountByRegion[regionId] = 0;
    }

    for (const agent of Object.values(state.agents || {})) {
      if (!isEntityTypeVisible(getEntityType(agent))) continue;
      if (!regionToEntitySet[agent.region]) regionToEntitySet[agent.region] = new Set();
      regionToEntitySet[agent.region].add(agent.id);

      const prev = previousAgentsById[agent.id];
      if (!prev || prev.region !== agent.region) continue;
      if ((prev.x !== agent.x) || (prev.y !== agent.y) || (prev.lat !== agent.lat) || (prev.lng !== agent.lng)) {
        movementCountByRegion[agent.region] = (movementCountByRegion[agent.region] || 0) + 1;
      }
    }

    const recentEventCounts = {};
    for (const ev of eventLog) {
      const eventTick = Number.isFinite(ev._tick) ? ev._tick : currentTick;
      if (eventTick < minTick) continue;
      const regions = inferEventRegionIds(ev, regionToEntitySet);
      for (const regionId of regions) {
        recentEventCounts[regionId] = (recentEventCounts[regionId] || 0) + 1;
        const existingTs = intel[regionId] ? intel[regionId].lastEventTs : null;
        if (intel[regionId] && (!existingTs || new Date(ev.ts || 0) > new Date(existingTs))) {
          intel[regionId].lastEventTs = ev.ts || null;
        }
      }
    }

    for (const regionId of Object.keys(intel)) {
      const eventCount = recentEventCounts[regionId] || 0;
      const movementCount = movementCountByRegion[regionId] || 0;
      intel[regionId].entitiesInside = Array.from(regionToEntitySet[regionId] || []);
      const region = state.regions[regionId];
      const related = [];
      if (region) {
        const rp = getEntityWorldPoint(region);
        for (const agent of Object.values(state.agents || {})) {
          if (!isEntityTypeVisible(getEntityType(agent))) continue;
          if (agent.region === regionId) continue;
          const ap = getEntityWorldPoint(agent);
          const dx = (Number(ap.x) - Number(rp.x));
          const dy = (Number(ap.y) - Number(rp.y));
          if (Math.hypot(dx, dy) <= 18) related.push(agent.id);
        }
      }
      intel[regionId].relatedEntities = related.slice(0, 12);
      intel[regionId].activityLevel = eventCount + movementCount;
      intel[regionId].status = deriveRegionStatus(eventCount, movementCount);
    }

    return intel;
  }

  // ── Stats ──
  function updateStats() {
    const allAgents = Object.values(state.agents || {});
    const visibleAgents = allAgents.filter(a => isEntityTypeVisible(getEntityType(a)));
    // Prefer API-polled count; fall back to WS-pushed count from server
    const fetched = lastApiFetchedCount > 0
      ? lastApiFetchedCount
      : (Number.isFinite(Number(openskyStatus.fetched)) ? Number(openskyStatus.fetched) : 0);
    const visibleFlights = Number.isFinite(Number(lastFlightDebugCounts.visible)) ? Number(lastFlightDebugCounts.visible) : 0;
    const drawnFlights = Number.isFinite(Number(lastFlightDebugCounts.drawn)) ? Number(lastFlightDebugCounts.drawn) : 0;
    // Compact UTC timestamp: "HH:MM:SS" or "—"
    const fetchAtStr = (function () {
      const raw = (layerLastUpdated.liveFlights && new Date(layerLastUpdated.liveFlights).toISOString())
        || (openskyStatus && openskyStatus.lastPollAt);
      if (!raw || raw === 'none') return '—';
      try { return new Date(raw).toISOString().slice(11, 19); } catch (e) { return raw; }
    }());
    const flightDebugText =
      'fetched:' + fetched +
      ' visible:' + visibleFlights +
      ' drawn:' + drawnFlights +
      ' | at:' + fetchAtStr;
    const layerDiagnostics = buildLayerDiagnostics();
    lastLayerDiagnostics = layerDiagnostics;
    const layerDebugText = 'L:' + layerDiagnostics.liveFlights
      + ' T:' + layerDiagnostics.traffic
      + ' S:' + layerDiagnostics.satellites
      + ' R:' + layerDiagnostics.regions
      + ' W:' + layerDiagnostics.weather;
    document.getElementById('s-tick').textContent    = state.tick;
    document.getElementById('s-agents').textContent  = visibleAgents.length + '/' + allAgents.length;
    document.getElementById('s-regions').textContent = Object.keys(state.regions).length;
    document.getElementById('s-flights-debug').textContent = flightDebugText;
    document.getElementById('s-layers-debug').textContent = layerDebugText;
    document.getElementById('s-render-debug').textContent =
      'earth:' + (lastCesiumRenderCounts.earthInitialized ? 'ok' : 'pending')
      + ' tiles:' + (lastCesiumRenderCounts.tilesState || (lastCesiumRenderCounts.tilesLoaded ? 'ok' : 'pending'))
      + (lastCesiumRenderCounts.tilesError ? ' (' + lastCesiumRenderCounts.tilesError + ')' : '')
      + ' sat:' + (Number.isFinite(lastCesiumRenderCounts.satellites) ? lastCesiumRenderCounts.satellites : 0)
      + ' reg:' + (Number.isFinite(lastCesiumRenderCounts.regions) ? lastCesiumRenderCounts.regions : 0);
    document.getElementById('s-speed').textContent   = simulationSpeed + 'x';
    if (state.started) {
      const sec = Math.floor((Date.now() - new Date(state.started)) / 1000);
      const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
      document.getElementById('s-uptime').textContent =
        (h ? h+'h ' : '') + (m ? m+'m ' : '') + s+'s';
    }
    // ── Layer freshness panel update ──────────────────────────────────────
    if (layerState.liveFlights) {
      const pollTs = openskyStatus && openskyStatus.lastPollAt
        ? new Date(openskyStatus.lastPollAt).getTime() : null;
      if (pollTs) layerLastUpdated.liveFlights = pollTs;
      setLayerStatus('liveFlights', openskyStatus && openskyStatus.lastErrorAt
        ? 'error · ' + timeSinceStr(layerLastUpdated.liveFlights)
        : timeSinceStr(layerLastUpdated.liveFlights));
    }
    const satCount = Object.values(state.agents || {}).filter(a => getEntityType(a) === 'satellite').length;
    if (layerState.satellites) {
      if (satCount > 0 && !layerLastUpdated.satellites) layerLastUpdated.satellites = Date.now();
      setLayerStatus('satellites', satCount > 0
        ? satCount + ' tracked · ' + timeSinceStr(layerLastUpdated.satellites)
        : 'no data');
    }
  }
  setInterval(updateStats, 1000);
  renderEventLog();
  renderSelectedPanel();
  syncActionButtons();
  focusActionBtn.addEventListener('click', runFocusAction);
  pingActionBtn.addEventListener('click', runPingAction);
  flagActionBtn.addEventListener('click', runFlagAction);
  followTargetToggleEl.addEventListener('change', function () {
    const shouldFollow = !!followTargetToggleEl.checked;
    if (!shouldFollow) {
      disableFollowTarget('toggle off');
      return;
    }
    const selectedFocusPoint = getSelectedFocusPoint();
    if (!selectedFocusPoint) {
      disableFollowTarget('no selection');
      return;
    }
    followTargetEnabled = true;
    cameraLerpTarget = selectedFocusPoint;
    const ll = toLatLngWithFallback(selectedFocusPoint);
    if (ll) {
      cesiumCameraLerpState = { lng: ll.lng, lat: ll.lat, height: 1400000 };
    }
    pushOperatorEvent('operator follow enabled for ' + (selectedAgentId || ('region ' + selectedRegionId)));
    draw();
  });

  function clearSelectionIfHidden() {
    if (!showAgents && selectedAgentId) {
      selectedAgentId = null;
      latestSelectedEvent = null;
    }
    if (selectedAgentId) {
      const selected = state.agents[selectedAgentId];
      if (!selected || !isEntityTypeVisible(getEntityType(selected))) {
        selectedAgentId = null;
        latestSelectedEvent = null;
      }
    }
    if ((!showRegions || !layerState.regions) && selectedRegionId) {
      selectedRegionId = null;
      latestSelectedEvent = null;
    }
    refreshRelatedEventHighlight();
    syncFollowTargetState();
    renderSelectedPanel();
  }

  function syncPauseButton() {
    pauseBtnEl.textContent = paused ? 'Resume Simulation' : 'Pause Simulation';
    pauseBtnEl.classList.toggle('active', paused);
    pauseBtnEl.setAttribute('aria-pressed', paused ? 'true' : 'false');
  }

  toggleAgentsEl.addEventListener('change', function () {
    showAgents = !!toggleAgentsEl.checked;
    clearSelectionIfHidden();
    draw();
  });
  toggleRegionsEl.addEventListener('change', function () {
    showRegions = !!toggleRegionsEl.checked;
    clearSelectionIfHidden();
    draw();
  });
  toggleTrailsEl.addEventListener('change', function () {
    showTrails = !!toggleTrailsEl.checked;
    draw();
  });
  // Layer toggle buttons — available layers use click to flip ON/OFF
  toggleLayerFlightsEl.addEventListener('click', function () {
    setLayerOn('liveFlights', !layerState.liveFlights);
    clearSelectionIfHidden();
    refreshEventVisibilityStyling();
    updateStats();
    draw();
  });
  toggleLayerSatellitesEl.addEventListener('click', function () {
    setLayerOn('satellites', !layerState.satellites);
    clearSelectionIfHidden();
    refreshEventVisibilityStyling();
    updateStats();
    draw();
  });
  toggleLayerRegionsEl.addEventListener('change', function () {
    layerState.regions = !!toggleLayerRegionsEl.checked;
    clearSelectionIfHidden();
    updateStats();
    draw();
  });
  function onTypeToggleChange() {
    visibleEntityTypes.agent = !!toggleTypeAgentEl.checked;
    visibleEntityTypes.flight = !!toggleTypeFlightEl.checked;
    visibleEntityTypes.satellite = !!toggleTypeSatelliteEl.checked;
    clearSelectionIfHidden();
    refreshEventVisibilityStyling();
    renderSelectedPanel();
    updateStats();
    draw();
  }
  toggleTypeAgentEl.addEventListener('change', onTypeToggleChange);
  toggleTypeFlightEl.addEventListener('change', onTypeToggleChange);
  toggleTypeSatelliteEl.addEventListener('change', onTypeToggleChange);
  pauseBtnEl.addEventListener('click', function () {
    paused = !paused;
    syncPauseButton();
    if (!paused) {
      processSnapshotQueue(true);
    }
  });
  syncPauseButton();
  updateStats();
  updateViewportReadout();
  setStylePreset('tactical', true);
  ensureStyleAnimationLoop();

  zoomInBtnEl.addEventListener('click', function () {
    if (USE_CESIUM && cesiumViewer) { zoomBy(0.60); return; }
    setViewportZoom(viewport.zoom + VIEWPORT_ZOOM_STEP);
  });
  zoomOutBtnEl.addEventListener('click', function () {
    if (USE_CESIUM && cesiumViewer) { zoomBy(1.65); return; }
    setViewportZoom(viewport.zoom - VIEWPORT_ZOOM_STEP);
  });
  resetViewBtnEl.addEventListener('click', resetViewport);
  panLeftBtnEl.addEventListener('click', function () { panViewport(-VIEWPORT_PAN_STEP, 0); });
  panRightBtnEl.addEventListener('click', function () { panViewport(VIEWPORT_PAN_STEP, 0); });
  panUpBtnEl.addEventListener('click', function () { panViewport(0, -VIEWPORT_PAN_STEP); });
  panDownBtnEl.addEventListener('click', function () { panViewport(0, VIEWPORT_PAN_STEP); });

  // ── Rail + drawer event listeners ─────────────────────────────────────────
  document.querySelectorAll('.rail-btn[data-panel]').forEach(function (btn) {
    btn.addEventListener('click', function () { openPanel(btn.dataset.panel); });
  });
  document.querySelectorAll('.drawer-close').forEach(function (btn) {
    btn.addEventListener('click', closePanel);
  });
  document.querySelectorAll('.dtab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchRightTab(btn.dataset.tab);
      activePanelId = btn.dataset.tab;
      document.querySelectorAll('.rail-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.panel === activePanelId);
      });
    });
  });

  speedSelectEl.addEventListener('change', function () {
    const nextSpeed = Number(speedSelectEl.value);
    simulationSpeed = Number.isFinite(nextSpeed) && nextSpeed > 0 ? nextSpeed : 1;
    updateStats();
  });
  styleModeSelectEl.addEventListener('change', function () {
    const nextMode = styleModeSelectEl.value;
    if (nextMode === 'crt' || nextMode === 'nvg' || nextMode === 'flir') {
      styleMode = nextMode;
      applyVisualStyle();
      pushOperatorEvent('operator style mode set to ' + styleMode);
    }
  });
  function bindFxSlider(inputEl, key) {
    inputEl.addEventListener('input', function () {
      const value = Number(inputEl.value);
      styleFx[key] = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : styleFx[key];
      activeStylePreset = 'custom';
      syncPresetUi();
      applyVisualStyle();
    });
  }
  bindFxSlider(fxBloomEl, 'bloom');
  bindFxSlider(fxSharpenEl, 'sharpen');
  bindFxSlider(fxNoiseEl, 'noise');
  bindFxSlider(fxVignetteEl, 'vignette');
  bindFxSlider(fxPixelationEl, 'pixelation');
  bindFxSlider(fxGlowEl, 'glow');
  for (const btn of presetButtons) {
    btn.addEventListener('click', function () {
      setStylePreset(btn.dataset.stylePreset || 'tactical', false);
    });
  }

  function applySnapshot(nextSnapshot) {
    mergeApiFlightsIntoSnapshot(nextSnapshot);
    const snapshotTsMs = Date.now();
    updateAgentTrails(state.agents, nextSnapshot.agents);
    // Gate flight tracking on live-flights layer — OFF layer must not process flight events
    if (layerState.liveFlights) {
      updateFlightTracking(state.agents, nextSnapshot.agents, snapshotTsMs);
    }
    const receivedFlightCount = Object.values(nextSnapshot && nextSnapshot.agents ? nextSnapshot.agents : {}).filter(function (a) {
      return a && a.type === 'flight';
    }).length;
    console.log('Flights received:', receivedFlightCount);
    previousAgentsById = state.agents || {};
    state = nextSnapshot;
    openskyStatus = nextSnapshot && nextSnapshot.opensky
      ? nextSnapshot.opensky
      : Object.assign({}, OPENSKY_STATUS_DEFAULTS);
    latestRegionIntelligence = computeRegionIntelligence();
    clearSelectionIfHidden();
    if (selectedAgentId && !state.agents[selectedAgentId]) {
      selectAgent(null);
      return;
    }
    if (selectedRegionId && !state.regions[selectedRegionId]) {
      selectRegion(null);
      return;
    }
    renderSelectedPanel();
    draw();
  }

  function processSnapshotQueue(force) {
    if (paused || snapshotQueue.length === 0) return;
    const now = Date.now();
    const applyEveryMs = SNAPSHOT_BASE_INTERVAL_MS / simulationSpeed;
    if (!force && now - lastSnapshotApplyAt < applyEveryMs) return;
    applySnapshot(snapshotQueue.shift());
    lastSnapshotApplyAt = now;
  }

  setInterval(function () {
    processSnapshotQueue(false);
  }, 100);

  function refreshEventVisibilityStyling() {
    renderEventLog();
  }

  eventSearchEl.addEventListener('input', function () {
    eventSearchQuery = eventSearchEl.value.trim().toLowerCase();
    renderEventLog();
  });

  eventChipRowEl.addEventListener('click', function (e) {
    const chip = e.target.closest('.event-chip');
    if (!chip) return;
    activeEventFilter = chip.getAttribute('data-event-filter') || 'all';
    for (const el of eventChipRowEl.querySelectorAll('.event-chip')) {
      el.classList.toggle('active', el === chip);
    }
    renderEventLog();
  });
  // Click an event entry to jump to its associated agent or region
  log.addEventListener('click', function (e) {
    const entry = e.target.closest('.event-entry');
    if (!entry) return;
    const agentId  = entry.dataset.agentId;
    const regionId = entry.dataset.regionId;
    if (agentId  && state.agents[agentId])    { selectAgent(agentId);   return; }
    if (regionId && state.regions[regionId])  { selectRegion(regionId); return; }
  });

  let _selectionClickLogged = false;
  if (!USE_CESIUM) canvas.addEventListener('click', function (e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = findNearestAgentAtPoint(mx, my);
    const chosenId = hit.agent ? hit.agent.id : null;
    if (!_selectionClickLogged) {
      console.debug('[selection-click]', {
        x: Number(mx.toFixed(1)),
        y: Number(my.toFixed(1)),
        selectedEntityId: chosenId,
      });
      _selectionClickLogged = true;
    }
    if (chosenId) {
      selectAgent(chosenId);
      return;
    }
    const regionHit = findRegionAtPoint(mx, my);
    if (regionHit) {
      selectRegion(regionHit.id);
      return;
    }
    selectAgent(null);
  });

  initCesium();

  // Merge API flights into every incoming snapshot so they survive WS refreshes
  function mergeApiFlightsIntoSnapshot(snapshot) {
    if (!snapshot || !snapshot.agents || Object.keys(apiFetchedFlights).length === 0) return;
    // Only inject entities the server snapshot doesn't already have fresher data for
    for (const [id, entity] of Object.entries(apiFetchedFlights)) {
      if (!snapshot.agents[id]) {
        snapshot.agents[id] = entity;
      }
    }
  }

  // ── WebSocket ──
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = function () {
      statusEl.textContent = 'connected';
      statusEl.className = '';
      wsRetryDelay = 1000;
      eventLog.push({ kind: 'system', msg: 'WebSocket connected', _tick: state.tick });
      if (eventLog.length > 120) eventLog.shift();
      pushEvent({ kind: 'system', msg: 'WebSocket connected', _tick: state.tick });
    };

    ws.onmessage = function (e) {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') {
        mergeApiFlightsIntoSnapshot(msg.data);
        if (paused) {
          pendingSnapshot = msg.data;
          return;
        }
        updateAgentTrails(state.agents, msg.data.agents);
        if (layerState.liveFlights) {
          updateFlightTracking(state.agents, msg.data.agents, Date.now());
        }
        previousAgentsById = state.agents || {};
        state = msg.data;
        latestRegionIntelligence = computeRegionIntelligence();
        let selectionChanged = false;
        if (selectedAgentId && !state.agents[selectedAgentId]) {
          selectAgent(null);
          selectionChanged = true;
        } else if (selectedRegionId && !state.regions[selectedRegionId]) {
          selectRegion(null);
          selectionChanged = true;
        }
        if (!selectionChanged) {
          renderSelectedPanel();
          updateStats();
          draw();
        }
        snapshotQueue.push(msg.data);
        processSnapshotQueue(true);
      } else if (msg.type === 'event') {
        if (!Number.isFinite(msg.data._tick)) msg.data._tick = state.tick;
        eventLog.push(msg.data);
        if (eventLog.length > 120) eventLog.shift();
        latestRegionIntelligence = computeRegionIntelligence();
        pushEvent(msg.data);
        if (paused) return;
        if (msg.data.patch) Object.assign(state, msg.data.patch);
        renderSelectedPanel();
        draw();
      }
    };

    ws.onclose = function () {
      statusEl.textContent = 'disconnected';
      statusEl.className = 'disconnected';
      eventLog.push({ kind: 'system', msg: 'WebSocket disconnected — retrying in ' + (wsRetryDelay/1000) + 's', _tick: state.tick });
      if (eventLog.length > 120) eventLog.shift();
      pushEvent({ kind: 'system', msg: 'WebSocket disconnected — retrying in ' + (wsRetryDelay/1000) + 's', _tick: state.tick });
      setTimeout(connect, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 16000);
    };

    ws.onerror = function () { ws.close(); };
  }

  connect();
})();
</script>
</body>
</html>`;

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

function errMsg(err) {
  return err && err.message ? err.message : String(err || 'unknown');
}

// Converts an OpenSky states array into a flights map using buildOpenSkyFlightEntity.
// sourceOverride, if set, stamps entity.source (e.g. 'file'); omit for live API default.
function normalizeStateBatch(states, previous, sourceOverride) {
  const flights = {};
  let count = 0;
  for (const row of states) {
    const icao24 = Array.isArray(row) ? String(row[0] || '').trim().toLowerCase() : '';
    const prev = icao24 ? previous['flight-' + icao24] : null;
    const entity = buildOpenSkyFlightEntity(row, prev);
    if (!entity) continue;
    if (sourceOverride) entity.source = sourceOverride;
    count++;
    flights[entity.id] = entity;
  }
  return { flights, count };
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const client of wsClients) {
    if (!client.destroyed && client.writable) {
      wsSend(client, msg);
    } else {
      wsClients.delete(client);
    }
  }
}

function emit(kind, msg, patch, entityType) {
  const ev = { kind, msg, ts: new Date().toISOString(), patch, entityType: entityType || null };
  eventLog.push(ev);
  if (eventLog.length > 100) eventLog.shift();
  broadcast('event', ev);
}

function snapshot() {
  const mergedAgents = {
    ...worldview.agents,
    ...openSkyFileState.flights,   // file-sourced flights (live API wins on icao collision)
    ...openSkyLiveState.flights,
  };

  // Annotate agents with current task status where a worker is assigned
  for (const worker of workerRuntime.values()) {
    if (worker.status === 'busy' && worker.currentTaskId) {
      const task = taskRegistry.get(worker.currentTaskId);
      if (task && task.targetEntityId && mergedAgents[task.targetEntityId]) {
        mergedAgents[task.targetEntityId] = {
          ...mergedAgents[task.targetEntityId],
          currentTaskId: task.id,
          currentTaskType: task.type,
          currentTaskStatus: task.status,
        };
      }
    }
  }

  // Recent tasks (last 30, newest first)
  const recentTasks = [...taskRegistry.values()]
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
    .slice(0, 30);

  // Recent evaluations (last 20)
  const recentEvals = [...evaluations.values()]
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
    .slice(0, 20);

  return {
    agents: mergedAgents,
    regions: worldview.regions,
    tick: worldview.tick,
    started: worldview.started,
    tasks: recentTasks,
    workers: [...workerRuntime.values()],
    evaluations: recentEvals,
    planner: {
      backlogCount: plannerState.backlogCount,
      activeTaskCount: plannerState.activeTaskIds.length,
      lastAssignments: plannerState.lastAssignments.slice(-5),
      stats: {
        ...plannerStats,
        queuedTasks: countBacklog(),
      },
    },
    opensky: {
      enabled: OPENSKY_ENABLED,
      authConfigured: openSkyLiveState.authConfigured,
      pollingRunning: openSkyLiveState.pollingRunning,
      fetched: openSkyLiveState.lastFetchedCount,
      normalized: openSkyLiveState.lastNormalizedCount,
      merged: Object.keys(openSkyLiveState.flights).length,
      modeUsed: openSkyLiveState.lastModeUsed,
      visible: openSkyLiveState.lastVisibleCount,
      drawn: openSkyLiveState.lastDrawnCount,
      lastRequestUrl: openSkyLiveState.lastRequestUrl,
      lastRequestStatus: openSkyLiveState.lastRequestStatus,
      lastPollAt: openSkyLiveState.lastPollAt,
      lastErrorAt: openSkyLiveState.lastErrorAt,
      // ── diagnostic fields ──────────────────────────────────────────────────
      authMode: OPENSKY_ENABLED ? (openSkyLiveState.lastAuthMode || 'public') : 'none',
      hasClientId: !!(fileCredentials.credentialType === 'client_credentials' && fileCredentials.username),
      hasClientSecret: !!(fileCredentials.credentialType === 'client_credentials' && fileCredentials.password),
      lastFetchStatus: openSkyLiveState.lastRequestStatus !== null ? openSkyLiveState.lastRequestStatus : 'none',
      lastFetchError: openSkyLiveState.lastErrorMessage || 'none',
    },
  };
}

function hasLatLng(entity) {
  return entity && Number.isFinite(entity.lat) && Number.isFinite(entity.lng);
}

function latLngToGrid(lat, lng) {
  return {
    x: ((Math.max(-180, Math.min(180, lng)) + 180) / 360) * 100,
    y: ((90 - Math.max(-90, Math.min(90, lat))) / 180) * 100,
  };
}

function normalizeEntityGridPosition(entity) {
  if (!entity) return;
  if (hasLatLng(entity)) {
    const mapped = latLngToGrid(entity.lat, entity.lng);
    entity.x = mapped.x;
    entity.y = mapped.y;
  }
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getGlobeUnitVectorFromLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latRad = Math.max(-90, Math.min(90, lat)) * (Math.PI / 180);
  const lngRad = Math.max(-180, Math.min(180, lng)) * (Math.PI / 180);
  const cosLat = Math.cos(latRad);
  const x = cosLat * Math.sin(lngRad);
  const y = Math.sin(latRad);
  const z = cosLat * Math.cos(lngRad);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function countVisibleOpenSkyFlights(flights, minZ) {
  let passProjection = 0;
  let passMinZ = 0;
  for (const flight of Object.values(flights || {})) {
    const vector = getGlobeUnitVectorFromLatLng(flight.lat, flight.lng);
    if (!vector) continue;
    passProjection++;
    if (!Number.isFinite(minZ) || vector.z >= minZ) passMinZ++;
  }
  return { passProjection, passMinZ };
}

function resolveClosestRegion(entity) {
  let closest = null;
  let bestDist = Infinity;
  for (const r of Object.values(worldview.regions)) {
    if (!hasLatLng(entity) || !hasLatLng(r)) continue;
    const d = Math.hypot(entity.lat - r.lat, entity.lng - r.lng);
    if (d < bestDist) {
      bestDist = d;
      closest = r;
    }
  }
  return closest ? closest.id : null;
}

function buildOpenSkyFlightEntity(row, previousEntity) {
  if (!Array.isArray(row)) return null;
  const icao24 = String(row[0] || '').trim().toLowerCase();
  const callsign = String(row[1] || '').trim();
  const lng = safeNumber(row[5]);
  const lat = safeNumber(row[6]);
  if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const altitude = safeNumber(row[7] !== null && row[7] !== undefined ? row[7] : row[13]);
  const velocity = safeNumber(row[9]);
  const heading = safeNumber(row[10]);
  const verticalRate = safeNumber(row[11]);
  const onGround = Boolean(row[8]);
  const entity = {
    id: 'flight-' + icao24,
    type: 'flight',
    label: callsign || icao24,
    name: callsign || icao24,
    icao24,
    lat,
    lng,
    altitude,
    heading,
    velocity,
    speed: velocity,
    verticalRate,
    onGround,
    source: 'opensky',
    region: null,
    active: true,
    state: onGround ? 'grounded' : 'airborne',
    memory: [],
    lastSeen: new Date().toISOString(),
    prevLat: previousEntity && Number.isFinite(previousEntity.lat) ? previousEntity.lat : null,
    prevLng: previousEntity && Number.isFinite(previousEntity.lng) ? previousEntity.lng : null,
    trail: Array.isArray(previousEntity && previousEntity.trail) ? previousEntity.trail.slice(-OPENSKY_TRAIL_MAX_POINTS) : [],
    lastUpdateMs: Date.now(),
  };
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const moved = !previousEntity
      || !Number.isFinite(previousEntity.lat)
      || !Number.isFinite(previousEntity.lng)
      || Math.abs(previousEntity.lat - lat) > 0.0001
      || Math.abs(previousEntity.lng - lng) > 0.0001;
    if (entity.trail.length === 0 || moved) {
      entity.trail.push({ lat, lng, ts: entity.lastUpdateMs });
    }
    entity.trail = entity.trail.slice(-OPENSKY_TRAIL_MAX_POINTS);
  }
  normalizeEntityGridPosition(entity);
  entity.region = resolveClosestRegion(entity);
  return entity;
}

async function pollOpenSkyFlights() {
  if (!OPENSKY_ENABLED) return;
  // Env vars take priority; fall back to credentials loaded from opensky.json.
  const effectiveUser = OPENSKY_USERNAME || fileCredentials.username;
  const effectivePass = OPENSKY_PASSWORD || fileCredentials.password;
  const authConfigured = !!(effectiveUser && effectivePass);
  const usingFileCreds = !OPENSKY_USERNAME && !!fileCredentials.username;
  openSkyLiveState.authConfigured = authConfigured;
  openSkyLiveState.lastAuthMode = !authConfigured
    ? 'public'
    : (usingFileCreds && fileCredentials.credentialType === 'client_credentials')
      ? 'client_credentials'
      : 'username_password';
  console.log('[RW Worldview] Polling OpenSky... running=' + openSkyLiveState.pollingRunning + ' authConfigured=' + authConfigured);
  try {
    const authHeader = authConfigured
      ? 'Basic ' + Buffer.from(effectiveUser + ':' + effectivePass).toString('base64')
      : null;

    let modeUsed = authConfigured ? 'auth' : 'public';
    let requestUrl = authConfigured ? OPENSKY_STATES_URL : OPENSKY_PUBLIC_STATES_URL;
    let useAuth = !!authConfigured;

    if (!authConfigured) {
      console.warn('[RW Worldview] Falling back to public OpenSky endpoint');
    }

    const runRequest = async (url, auth) => {
      console.log('[RW Worldview] OpenSky request lifecycle: url=' + url + ' auth=' + (auth ? 'basic' : 'none'));
      const response = await fetch(url, {
        method: 'GET',
        headers: auth && authHeader ? { Authorization: authHeader } : undefined,
      });
      openSkyLiveState.lastRequestUrl = url;
      openSkyLiveState.lastRequestStatus = response.status;
      const rawBody = await response.text();
      console.log('[RW Worldview] OpenSky response status=' + response.status + ' bodyLength=' + rawBody.length);
      return { response, rawBody };
    };

    let result = await runRequest(requestUrl, useAuth);

    if (!result.response.ok && useAuth) {
      console.warn('[RW Worldview] Falling back to public OpenSky endpoint');
      modeUsed = 'public';
      requestUrl = OPENSKY_PUBLIC_STATES_URL;
      useAuth = false;
      result = await runRequest(requestUrl, useAuth);
    }

    openSkyLiveState.lastModeUsed = modeUsed;

    if (!result.response.ok) {
      throw new Error('OpenSky live states request failed with HTTP ' + result.response.status);
    }

    let payload;
    try {
      payload = result.rawBody ? JSON.parse(result.rawBody) : null;
    } catch (parseErr) {
      console.warn('[RW Worldview] OpenSky returned empty or invalid response');
      throw new Error('OpenSky live states parse failed: ' + parseErr.message);
    }

    const hasStates = Array.isArray(payload && payload.states);
    const states = hasStates ? payload.states : [];
    console.log('[RW Worldview] OpenSky payload states exists=' + hasStates + ' count=' + states.length);
    if (!hasStates || states.length === 0) {
      console.warn('[RW Worldview] OpenSky returned empty or invalid response');
      return;
    }

    const previous = openSkyLiveState.flights;
    openSkyLiveState.rawStates = states;   // cache for /api/flights
    const { flights: nextFlights, count: normalizedCount } = normalizeStateBatch(states, previous, null);

    const visibilityStats = countVisibleOpenSkyFlights(nextFlights, OPENSKY_GLOBE_MIN_Z);
    const visibleCount = visibilityStats.passProjection;
    const drawnCount = visibilityStats.passMinZ;

    openSkyLiveState.lastFetchedCount = states.length;
    openSkyLiveState.lastNormalizedCount = normalizedCount;
    console.log(
      '[RW Worldview] OpenSky visibility: fetched=' + states.length
      + ' normalized=' + normalizedCount
      + ' projection=' + visibilityStats.passProjection
      + ' minZ=' + visibilityStats.passMinZ
      + ' (threshold=' + OPENSKY_GLOBE_MIN_Z + ')'
    );
    console.info('[RW Flights][poll]', {
      flightsFetched: states.length,
      flightsMerged: normalizedCount,
      flightsRendered: Object.keys(nextFlights).length,
    });
    openSkyLiveState.lastVisibleCount = visibleCount;
    openSkyLiveState.lastDrawnCount = drawnCount;

    console.log('OpenSky: fetched ' + states.length + ' flights, normalized ' + normalizedCount + ', visible ' + visibleCount + ', drawn ' + drawnCount);

    let updatedCount = 0;
    for (const flightId of Object.keys(nextFlights)) {
      if (!previous[flightId]) {
        emit('agent', '[flight] ' + flightId + ' appeared (OpenSky)', { id: flightId, source: 'opensky', event: 'appear' }, 'flight');
        const regionId = nextFlights[flightId] ? nextFlights[flightId].region : null;
        if (regionId) onFlightAppeared(flightId, regionId);
      } else {
        updatedCount++;
      }
    }
    for (const flightId of Object.keys(previous)) {
      if (!nextFlights[flightId]) {
        emit('agent', '[flight] ' + flightId + ' disappeared (OpenSky)', { id: flightId, source: 'opensky', event: 'disappear' }, 'flight');
      }
    }
    if (updatedCount > 0) {
      emit('agent', '[flight] ' + updatedCount + ' flights updated (OpenSky)', { source: 'opensky', event: 'update', count: updatedCount }, 'flight');
    }

    openSkyLiveState.flights = nextFlights;
    openSkyLiveState.lastPollAt = new Date().toISOString();
    openSkyLiveState.lastErrorAt = null;
    openSkyLiveState.lastErrorMessage = null;
    broadcast('snapshot', snapshot());
  } catch (err) {
    const msg = 'OpenSky poll warning: ' + errMsg(err);
    console.warn('[RW Worldview] ' + msg);
    openSkyLiveState.lastErrorAt = new Date().toISOString();
    openSkyLiveState.lastErrorMessage = errMsg(err);
    openSkyLiveState.lastFetchedCount = 0;
    openSkyLiveState.lastNormalizedCount = 0;
    openSkyLiveState.lastVisibleCount = 0;
    openSkyLiveState.lastDrawnCount = 0;
    emit('system', msg, { source: 'opensky' });
    throw err;
  }
}

function startOpenSkyPolling() {
  if (!OPENSKY_ENABLED) {
    console.log('[RW Worldview] OpenSky polling disabled (RW_OPENSKY_ENABLED != true)');
    return;
  }
  openSkyLiveState.pollingRunning = true;
  console.log('[RW Worldview] OpenSky polling enabled; success=20000ms error=30000ms');
  console.log('[RW Worldview] OpenSky polling URL=' + OPENSKY_STATES_URL + ' publicFallback=' + OPENSKY_PUBLIC_STATES_URL);
  console.log('RW_OPENSKY_ENABLED', process.env.RW_OPENSKY_ENABLED);

  async function schedulePoll() {
    try {
      await pollOpenSkyFlights();
      setTimeout(schedulePoll, 20000);
    } catch (err) {
      console.warn('[RW Worldview] OpenSky poll failed — retrying in 30s');
      setTimeout(schedulePoll, 30000);
    }
  }

  schedulePoll();
}

// ─── Aviationstack polling ─────────────────────────────────────────────────────

async function pollAviationstackFlights() {
  if (!AVIATIONSTACK_KEY) {
    console.warn('[RW Worldview] Aviationstack key not configured (AVIATIONSTACK_KEY)');
    return;
  }
  const url = 'https://api.aviationstack.com/v1/flights?access_key=' + AVIATIONSTACK_KEY;
  console.log('[RW Worldview] Polling Aviationstack...');
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Aviationstack request failed with HTTP ' + response.status);
    }
    const payload = await response.json();
    const data = Array.isArray(payload && payload.data) ? payload.data : [];
    const normalized = data
      .filter(f => f && f.live &&
        Number.isFinite(f.live.latitude) &&
        Number.isFinite(f.live.longitude) &&
        f.flight && (f.flight.iata || f.flight.icao))
      .map(f => ({
        id: 'flight-' + (f.flight.iata || f.flight.icao),
        lat: f.live.latitude,
        lon: f.live.longitude,
        altitude: f.live.altitude || 0,
        velocity: f.live.speed_horizontal || 0,
      }));
    aviationstackState.flights = normalized;
    aviationstackState.lastFetchedCount = normalized.length;
    aviationstackState.lastPollAt = new Date().toISOString();
    aviationstackState.lastErrorAt = null;
    aviationstackState.lastErrorMessage = null;
    console.log('[RW Worldview] Aviationstack: fetched ' + data.length + ' flights, ' + normalized.length + ' with live position');
  } catch (err) {
    console.warn('[RW Worldview] Aviationstack poll error: ' + err.message);
    aviationstackState.lastErrorAt = new Date().toISOString();
    aviationstackState.lastErrorMessage = err.message;
  }
}

function startAviationstackPolling() {
  if (!AVIATIONSTACK_KEY) {
    console.log('[RW Worldview] Aviationstack polling disabled (AVIATIONSTACK_KEY not set)');
    return;
  }
  aviationstackState.pollingRunning = true;
  console.log('[RW Worldview] Aviationstack polling enabled; interval=' + AVIATIONSTACK_POLL_INTERVAL_MS + 'ms');

  function schedulePoll() {
    pollAviationstackFlights()
      .then(() => setTimeout(schedulePoll, AVIATIONSTACK_POLL_INTERVAL_MS))
      .catch(() => setTimeout(schedulePoll, AVIATIONSTACK_POLL_INTERVAL_MS));
  }

  schedulePoll();
}

// ─── OpenSky file source ──────────────────────────────────────────────────────

function detectAnomalies(flights) {
  const anomalies = [];
  const seenIcao = {}; // icao24 → first entity id seen

  for (const entity of Object.values(flights)) {
    // Impossible speed
    if (Number.isFinite(entity.velocity) && entity.velocity > ANOMALY_MAX_SPEED_MS) {
      anomalies.push({
        type: 'impossible_speed',
        id: entity.id,
        icao24: entity.icao24,
        velocity: entity.velocity,
        msg: entity.id + ' impossible speed ' + entity.velocity.toFixed(1) + ' m/s',
      });
    }

    // Duplicate ICAO — same icao24 appearing more than once in the states array
    if (entity.icao24) {
      if (seenIcao[entity.icao24]) {
        anomalies.push({
          type: 'duplicate_icao',
          icao24: entity.icao24,
          ids: [seenIcao[entity.icao24], entity.id],
          msg: 'duplicate ICAO ' + entity.icao24 + ' (' + seenIcao[entity.icao24] + ' and ' + entity.id + ')',
        });
      } else {
        seenIcao[entity.icao24] = entity.id;
      }
    }
  }

  return anomalies;
}

function loadOpenSkyFile() {
  let raw;
  try {
    raw = fs.readFileSync(OPENSKY_FILE_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[RW File] Read error: ' + err.message);
      openSkyFileState.lastErrorAt = new Date().toISOString();
      emit('system', '[file] read error: ' + err.message, { source: 'file' });
    }
    return;
  }

  // Skip processing when the file content hasn't changed — avoids redundant
  // parsing, anomaly detection, and broadcast on every 5 s poll tick.
  const contentHash = crypto.createHash('md5').update(raw).digest('hex');
  if (contentHash === openSkyFileState.lastContentHash) return;
  openSkyFileState.lastContentHash = contentHash;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[RW File] Parse error in ' + OPENSKY_FILE_PATH + ': ' + err.message);
    openSkyFileState.lastErrorAt = new Date().toISOString();
    emit('system', '[file] parse error: ' + errMsg(err), { source: 'file' });
    return;
  }

  // Env vars OPENSKY_USERNAME / OPENSKY_PASSWORD always win; file fields are fallback.
  const fileUser = String(payload.username || payload.client_id || '').trim();
  const filePass = String(payload.password || payload.client_secret || '').trim();
  if (fileUser && filePass) {
    fileCredentials.username = fileUser;
    fileCredentials.password = filePass;
    fileCredentials.credentialType = payload.client_id ? 'client_credentials' : 'username_password';
    console.log('[RW File] Credentials loaded (' + fileCredentials.credentialType + ') for user: ' + fileUser);
  }

  const states = Array.isArray(payload && payload.states) ? payload.states : [];
  const previous = openSkyFileState.flights;
  const { flights: nextFlights, count: nextCount } = normalizeStateBatch(states, previous, 'file');

  // Emit events only for newly detected anomalies (suppress duplicates across reloads).
  const anomalies = detectAnomalies(nextFlights);
  const prevMsgs = new Set(openSkyFileState.anomalies.map(a => a.msg));
  for (const anomaly of anomalies) {
    if (!prevMsgs.has(anomaly.msg)) {
      console.warn('[RW File] Anomaly: ' + anomaly.msg);
      emit('system', '[file] anomaly: ' + anomaly.msg, { source: 'file', anomaly }, 'flight');
    }
  }
  openSkyFileState.anomalies = anomalies;

  for (const id of Object.keys(nextFlights)) {
    if (!previous[id]) {
      emit('agent', '[file] ' + id + ' appeared', { id, source: 'file', event: 'appear' }, 'flight');
      // create verify_event task for new flight entering a region
      const regionId = nextFlights[id] ? nextFlights[id].region : null;
      if (regionId) onFlightAppeared(id, regionId);
    }
  }
  for (const id of Object.keys(previous)) {
    if (!nextFlights[id]) {
      emit('agent', '[file] ' + id + ' disappeared', { id, source: 'file', event: 'disappear' }, 'flight');
    }
  }

  openSkyFileState.flights = nextFlights;
  openSkyFileState.lastLoadAt = new Date().toISOString();
  openSkyFileState.lastErrorAt = null;

  console.log('[RW File] Loaded ' + states.length + ' states → ' + nextCount + ' flights' +
    (anomalies.length ? ' (' + anomalies.length + ' anomalies)' : ''));

  broadcast('snapshot', snapshot());
}

let _fileWatchDebounce = null;

function startOpenSkyFileWatcher() {
  loadOpenSkyFile();

  // Real-time watch — debounced to handle editors that write twice in quick succession
  try {
    fs.watch(OPENSKY_FILE_PATH, { persistent: false }, () => {
      clearTimeout(_fileWatchDebounce);
      _fileWatchDebounce = setTimeout(loadOpenSkyFile, 150);
    });
    console.log('[RW File] Watching ' + OPENSKY_FILE_PATH);
  } catch (err) {
    // File may not exist yet; polling below will pick it up when it appears
    console.log('[RW File] Watch unavailable (' + err.message + '); using ' + OPENSKY_FILE_POLL_MS + 'ms polling');
  }

  // Polling fallback — also re-loads when file is replaced or watch was unavailable
  setInterval(loadOpenSkyFile, OPENSKY_FILE_POLL_MS);
}

// ─── Simulation / Agent loop ──────────────────────────────────────────────────
function initWorld() {
  // seed regions
  const regionDefs = [
    {
      id: 'north-america',
      name: 'North America',
      lat: 45,
      lng: -102,
      radiusDeg: 26,
    },
    {
      id: 'south-america',
      name: 'South America',
      lat: -16,
      lng: -60,
      radiusDeg: 22,
    },
    {
      id: 'europe',
      name: 'Europe',
      lat: 52,
      lng: 15,
      bounds: { north: 70, south: 35, west: -10, east: 40 },
    },
    {
      id: 'africa',
      name: 'Africa',
      lat: 4,
      lng: 20,
      bounds: { north: 36, south: -35, west: -18, east: 52 },
    },
    {
      id: 'asia',
      name: 'Asia',
      lat: 34,
      lng: 92,
      radiusDeg: 34,
    },
    {
      id: 'pacific',
      name: 'Pacific',
      lat: 2,
      lng: -160,
      radiusDeg: 38,
    },
  ];
  for (const r of regionDefs) {
    const mapped = latLngToGrid(r.lat, r.lng);
    worldview.regions[r.id] = {
      id: r.id,
      name: r.name || r.id,
      x: mapped.x,
      y: mapped.y,
      lat: r.lat,
      lng: r.lng,
      radiusDeg: Number.isFinite(r.radiusDeg) ? r.radiusDeg : undefined,
      bounds: r.bounds || undefined,
      agents: [],
    };
    normalizeEntityGridPosition(worldview.regions[r.id]);
    spatialIndex[r.id] = worldview.regions[r.id];
  }

  // seed agents (no mock flights — real flights come from OpenSky via /api/flights)
  for (let i = 0; i < 8; i++) {
    const id = uid('agent');
    const keys = Object.keys(worldview.regions);
    const region = keys[Math.floor(Math.random() * keys.length)];
    const entityType = i < 6 ? 'agent' : 'satellite';  // agents only + 2 satellites, no fake flights
    const lat = (Math.random() * 180) - 90;
    const lng = (Math.random() * 360) - 180;
    const gridPos = latLngToGrid(lat, lng);
    const agent = {
      id,
      type: entityType,
      x: gridPos.x,
      y: gridPos.y,
      lat,
      lng,
      region,
      active: true,
      state: 'idle',
      memory: [],
    };
    if (entityType === 'satellite') {
      agent.motion = {
        orbitAngle: Math.random() * Math.PI * 2,
        inclination: 8 + (Math.random() * 30),
        drift: 0.015 + (Math.random() * 0.02),
      };
    }
    worldview.agents[id] = agent;
    worldview.regions[region].agents.push(id);
  }
}

function tickAgent(agent) {
  // simple autonomous behaviour: random walk + state transitions
  const states = ['idle', 'exploring', 'reading', 'writing'];
  if (agent.type === 'flight' && hasLatLng(agent)) {
    const motion = agent.motion || { heading: 0, speed: 2, climb: 0 };
    motion.heading += ((Math.random() - 0.5) * 8);
    const headingRad = motion.heading * (Math.PI / 180);
    agent.lat = Math.max(-80, Math.min(80, agent.lat + (Math.sin(headingRad) * motion.speed * 0.2) + motion.climb));
    agent.lng += Math.cos(headingRad) * motion.speed;
    if (agent.lng > 180) agent.lng -= 360;
    if (agent.lng < -180) agent.lng += 360;
    agent.motion = motion;
    normalizeEntityGridPosition(agent);
  } else if (agent.type === 'satellite' && hasLatLng(agent)) {
    const motion = agent.motion || { orbitAngle: 0, inclination: 20, drift: 0.02 };
    motion.orbitAngle += motion.drift;
    agent.lat = Math.max(-85, Math.min(85, Math.sin(motion.orbitAngle) * motion.inclination));
    agent.lng += 0.9;
    if (agent.lng > 180) agent.lng -= 360;
    agent.motion = motion;
    normalizeEntityGridPosition(agent);
  } else {
    if (!hasLatLng(agent)) {
      const dx = (Math.random() - 0.5) * 4;
      const dy = (Math.random() - 0.5) * 4;
      agent.x = Math.max(0, Math.min(100, agent.x + dx));
      agent.y = Math.max(0, Math.min(100, agent.y + dy));
    } else {
      agent.lat = Math.max(-90, Math.min(90, agent.lat + ((Math.random() - 0.5) * 2.2)));
      agent.lng += (Math.random() - 0.5) * 3.6;
      if (agent.lng > 180) agent.lng -= 360;
      if (agent.lng < -180) agent.lng += 360;
      normalizeEntityGridPosition(agent);
    }
  }

  if (Math.random() < 0.08) {
    agent.state = states[Math.floor(Math.random() * states.length)];
    emit('agent', '[' + agent.type + '] ' + agent.id + ' → ' + agent.state, null, agent.type);
  }

  // re-assign region based on proximity
  let closest = null, bestDist = Infinity;
  for (const r of Object.values(worldview.regions)) {
    const d = hasLatLng(agent) && hasLatLng(r)
      ? Math.hypot(agent.lat - r.lat, agent.lng - r.lng)
      : Math.hypot(agent.x - r.x, agent.y - r.y);
    if (d < bestDist) { bestDist = d; closest = r; }
  }
  if (closest && closest.id !== agent.region) {
    const old = worldview.regions[agent.region];
    if (old) old.agents = old.agents.filter(a => a !== agent.id);
    agent.region = closest.id;
    closest.agents.push(agent.id);
    emit('region', '[' + agent.type + '] ' + agent.id + ' entered ' + closest.id, null, agent.type);
  }
}

function simulationLoop() {
  worldview.tick++;
  for (const agent of Object.values(worldview.agents)) {
    tickAgent(agent);
  }

  // broadcast full snapshot every 5 ticks, delta otherwise
  if (worldview.tick % 5 === 0) {
    broadcast('snapshot', snapshot());
  }

  if (worldview.tick % 20 === 0) {
    emit('system', 'tick ' + worldview.tick, { tick: worldview.tick });
  }
}

// ─── Task Planner / Worker / Evaluation System ───────────────────────────────

// Role → task type mapping
const ROLE_TASK_MAP = {
  region_scout:    ['monitor_region', 'summarize_region'],
  flight_scout:    ['track_entity', 'verify_event'],
  anomaly_verifier:['inspect_anomaly'],
  summary_worker:  ['summarize_region'],
};

// Task type → preferred worker role
const TASK_ROLE_MAP = {
  monitor_region:  'region_scout',
  track_entity:    'flight_scout',
  verify_event:    'flight_scout',
  summarize_region:'summary_worker',
  inspect_anomaly: 'anomaly_verifier',
};

function createWorker(role) {
  const id = uid('worker');
  const worker = {
    id,
    role,
    status: 'idle',       // idle | busy
    currentTaskId: null,
    currentRegionId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    metrics: { completed: 0, failed: 0, avgLatencyMs: 0, avgScore: 0 },
  };
  workerRuntime.set(id, worker);
  return worker;
}

function bootstrapWorkers() {
  createWorker('region_scout');
  createWorker('region_scout');
  createWorker('flight_scout');
  createWorker('flight_scout');
  createWorker('anomaly_verifier');
  createWorker('summary_worker');
  console.log('[RW Planner] Bootstrapped ' + workerRuntime.size + ' workers');
}

function createTask(type, regionId, opts) {
  opts = opts || {};
  const id = uid('task');
  const task = {
    id,
    type,
    status: 'queued',         // queued | running | completed | failed
    priority: opts.priority || 1,
    createdAt: new Date().toISOString(),
    assignedAt: null,
    completedAt: null,
    regionId: regionId || null,
    targetEntityId: opts.targetEntityId || null,
    sourceEventId: opts.sourceEventId || null,
    input: opts.input || {},
    assignedWorkerId: null,
    plannerId: 'planner-1',
    resultId: null,
    evaluationId: null,
    retryCount: opts.retryCount || 0,
  };
  taskRegistry.set(id, task);
  emit('system', '[planner] task created: ' + type + ' / ' + (regionId || 'global') + ' (' + id + ')', { taskId: id, type, regionId });
  return task;
}

function findIdleWorker(role) {
  for (const w of workerRuntime.values()) {
    if (w.role === role && w.status === 'idle') return w;
  }
  return null;
}

// Deterministic worker execution — uses current world state as context
function runWorkerTask(worker, task) {
  const allFlights = { ...openSkyFileState.flights, ...openSkyLiveState.flights };
  const region = worldview.regions[task.regionId] || null;
  const regionName = region ? region.name : (task.regionId || 'global');
  const flightsInRegion = Object.values(allFlights).filter(f => f.region === task.regionId);
  const anomalies = openSkyFileState.anomalies || [];

  let output = {};
  const startMs = Date.now();

  if (task.type === 'verify_event') {
    const target = allFlights[task.targetEntityId] || null;
    const hasAnomaly = target && anomalies.some(a => a.id === target.id || a.icao24 === target.icao24);
    const suspicious = target && Number.isFinite(target.velocity) && target.velocity > 400;
    output = {
      verdict: hasAnomaly ? 'anomalous' : (suspicious ? 'uncertain' : 'normal'),
      explanation: target
        ? 'Entity ' + (target.label || target.id) + ' at ' + regionName + '; speed=' + (target.velocity || '?') + ' m/s'
        : 'Target entity not found in current world state',
      confidence: target ? (hasAnomaly ? 0.9 : (suspicious ? 0.65 : 0.85)) : 0.3,
    };
  } else if (task.type === 'monitor_region') {
    output = {
      regionStatus: flightsInRegion.length > 0 ? 'active' : 'quiet',
      activeEntities: flightsInRegion.length,
      summary: regionName + ': ' + flightsInRegion.length + ' active entity/entities',
      confidence: 0.8,
    };
  } else if (task.type === 'inspect_anomaly') {
    const target = allFlights[task.targetEntityId] || null;
    const anomaly = anomalies.find(a => a.id === task.targetEntityId || a.icao24 === (target && target.icao24));
    output = {
      anomalyStatus: anomaly ? 'confirmed' : 'unresolved',
      severityGuess: anomaly && anomaly.type === 'impossible_speed' ? 'high' : 'medium',
      explanation: anomaly ? anomaly.msg : ('No active anomaly found for ' + (task.targetEntityId || 'unknown')),
      confidence: anomaly ? 0.88 : 0.4,
    };
  } else if (task.type === 'summarize_region') {
    const notes = plannerState.notesByRegion[task.regionId] || [];
    output = {
      regionId: task.regionId,
      regionName,
      flightCount: flightsInRegion.length,
      anomalyCount: anomalies.filter(a => {
        const f = allFlights[a.id];
        return f && f.region === task.regionId;
      }).length,
      notes: notes.slice(-5),
      summary: regionName + ' summary: ' + flightsInRegion.length + ' flights',
      confidence: 0.75,
    };
  } else if (task.type === 'track_entity') {
    const target = allFlights[task.targetEntityId] || null;
    output = {
      entityId: task.targetEntityId,
      found: !!target,
      position: target ? { lat: target.lat, lng: target.lng } : null,
      velocity: target ? target.velocity : null,
      regionId: target ? target.region : null,
      confidence: target ? 0.82 : 0.2,
    };
  }

  const latencyMs = Date.now() - startMs;
  const resultId = uid('result');
  const result = {
    id: resultId,
    taskId: task.id,
    workerId: worker.id,
    createdAt: new Date().toISOString(),
    output,
    summary: output.summary || output.explanation || output.verdict || 'done',
    confidence: output.confidence || 0.5,
    status: 'ready',
    latencyMs,
  };
  taskResults.set(resultId, result);
  return result;
}

function evaluateResult(task, result) {
  const evalId = uid('eval');
  const outputKeys = Object.keys(result.output || {});
  const completeness = Math.min(1, outputKeys.length / 4);
  const confidence = result.confidence || 0;
  const latencyMs = result.latencyMs || 0;
  const timeliness = latencyMs < 200 ? 1.0 : latencyMs < 1000 ? 0.8 : 0.5;
  const correctness = result.status === 'ready' ? 0.9 : 0.3;
  const policyFit = TASK_ROLE_MAP[task.type] ? 1.0 : 0.5;
  const usefulness = confidence > 0.7 ? 0.9 : confidence > 0.4 ? 0.7 : 0.4;

  const score = (correctness * 0.3) + (completeness * 0.2) + (timeliness * 0.15) + (policyFit * 0.15) + (usefulness * 0.2);

  let verdict;
  if (score > 0.75) verdict = 'accepted';
  else if (score > 0.5) verdict = 'retry';
  else verdict = 'escalate';

  const reasons = [];
  if (correctness < 0.8) reasons.push('result_not_ready');
  if (completeness < 0.5) reasons.push('output_incomplete');
  if (timeliness < 0.8) reasons.push('slow_response');
  if (usefulness < 0.7) reasons.push('low_confidence');
  if (reasons.length === 0) reasons.push('ok');

  const evaluation = {
    id: evalId,
    taskId: task.id,
    workerId: task.assignedWorkerId,
    resultId: result.id,
    createdAt: new Date().toISOString(),
    score: Math.round(score * 1000) / 1000,
    verdict,
    reasons,
    dimensions: {
      correctness: Math.round(correctness * 100) / 100,
      completeness: Math.round(completeness * 100) / 100,
      timeliness: Math.round(timeliness * 100) / 100,
      policyFit: Math.round(policyFit * 100) / 100,
      usefulness: Math.round(usefulness * 100) / 100,
    },
  };
  evaluations.set(evalId, evaluation);
  return evaluation;
}

function applyEvaluation(task, worker, evaluation) {
  const scoreStr = evaluation.score.toFixed(3);
  emit('system',
    '[eval] ' + evaluation.verdict + ' score=' + scoreStr + ' task=' + task.id,
    { taskId: task.id, verdict: evaluation.verdict, score: evaluation.score }
  );

  if (evaluation.verdict === 'accepted') {
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    plannerStats.completedTasks++;
    plannerStats.evalAccepted++;

    // update worker metrics
    worker.metrics.completed++;
    const n = worker.metrics.completed;
    worker.metrics.avgScore = ((worker.metrics.avgScore * (n - 1)) + evaluation.score) / n;
    const result = taskResults.get(task.resultId);
    if (result) {
      worker.metrics.avgLatencyMs = ((worker.metrics.avgLatencyMs * (n - 1)) + result.latencyMs) / n;
      // record region notes for monitor/summarize
      if (task.regionId && (task.type === 'monitor_region' || task.type === 'summarize_region') &&
          result.output && result.output.summary) {
        if (!plannerState.notesByRegion[task.regionId]) plannerState.notesByRegion[task.regionId] = [];
        plannerState.notesByRegion[task.regionId].push(result.output.summary);
        if (plannerState.notesByRegion[task.regionId].length > 10) {
          plannerState.notesByRegion[task.regionId].shift();
        }
      }
    }

  } else if (evaluation.verdict === 'retry') {
    plannerStats.evalRetry++;
    if (task.retryCount < 2) {
      task.status = 'queued';
      task.retryCount = (task.retryCount || 0) + 1;
      task.assignedWorkerId = null;
      task.assignedAt = null;
    } else {
      task.status = 'failed';
      task.completedAt = new Date().toISOString();
      plannerStats.failedTasks++;
      worker.metrics.failed++;
    }
  } else {
    // escalate
    plannerStats.evalEscalated++;
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    plannerStats.failedTasks++;
    worker.metrics.failed++;

    // create follow-up task
    if (task.type === 'verify_event' || task.type === 'track_entity') {
      createTask('inspect_anomaly', task.regionId, {
        targetEntityId: task.targetEntityId,
        sourceEventId: task.id,
        priority: 2,
      });
    } else if (task.type === 'monitor_region') {
      createTask('summarize_region', task.regionId, {
        sourceEventId: task.id,
        priority: 2,
      });
    }
  }

  // free worker
  worker.status = 'idle';
  worker.currentTaskId = null;
  worker.lastCompletedAt = new Date().toISOString();

  // update plannerState
  plannerState.activeTaskIds = plannerState.activeTaskIds.filter(id => id !== task.id);
  plannerState.backlogCount = countBacklog();
}

function countBacklog() {
  let n = 0;
  for (const t of taskRegistry.values()) {
    if (t.status === 'queued') n++;
  }
  return n;
}

// Guard: only one active monitor_region task per region at a time
function hasActiveMonitorForRegion(regionId) {
  for (const t of taskRegistry.values()) {
    if (t.type === 'monitor_region' && t.regionId === regionId &&
        (t.status === 'queued' || t.status === 'running')) {
      return true;
    }
  }
  return false;
}

// Guard: only one inspect_anomaly for a given entity at a time
function hasActiveInspectForEntity(entityId) {
  for (const t of taskRegistry.values()) {
    if (t.type === 'inspect_anomaly' && t.targetEntityId === entityId &&
        (t.status === 'queued' || t.status === 'running')) {
      return true;
    }
  }
  return false;
}

// Guard: only one verify_event per (entity, source event)
function hasActiveVerifyForEntity(entityId) {
  for (const t of taskRegistry.values()) {
    if (t.type === 'verify_event' && t.targetEntityId === entityId &&
        (t.status === 'queued' || t.status === 'running')) {
      return true;
    }
  }
  return false;
}

function createTasksFromWorldState() {
  const allFlights = { ...openSkyFileState.flights, ...openSkyLiveState.flights };

  // 1. verify_event when a flight is present in a region
  for (const flight of Object.values(allFlights)) {
    if (flight.region && !hasActiveVerifyForEntity(flight.id)) {
      createTask('verify_event', flight.region, {
        targetEntityId: flight.id,
        input: { flightId: flight.id, regionId: flight.region },
      });
    }
  }

  // 2. monitor_region for each active region if no monitor exists
  for (const regionId of Object.keys(worldview.regions)) {
    if (!hasActiveMonitorForRegion(regionId)) {
      createTask('monitor_region', regionId, {
        input: { regionId },
      });
    }
  }

  // 3. inspect_anomaly for known anomalies
  for (const anomaly of (openSkyFileState.anomalies || [])) {
    const entityId = anomaly.id || null;
    if (entityId && !hasActiveInspectForEntity(entityId)) {
      const flight = allFlights[entityId];
      createTask('inspect_anomaly', flight ? flight.region : null, {
        targetEntityId: entityId,
        input: { anomaly },
        priority: 3,
      });
    }
  }
}

// Called on flight appearance events — only create verify_event for newly seen flights
function onFlightAppeared(flightId, regionId) {
  if (!hasActiveVerifyForEntity(flightId)) {
    createTask('verify_event', regionId, {
      targetEntityId: flightId,
      input: { flightId, event: 'appear' },
    });
  }
}

let _plannerTaskSeedDone = false;

function plannerTick() {
  // Seed tasks once after world is initialized
  if (!_plannerTaskSeedDone && worldview.tick > 2) {
    _plannerTaskSeedDone = true;
    createTasksFromWorldState();
  }

  // Re-seed monitor_region for any region that currently has no queued/running monitor
  if (_plannerTaskSeedDone) {
    for (const regionId of Object.keys(worldview.regions)) {
      if (!hasActiveMonitorForRegion(regionId)) {
        createTask('monitor_region', regionId, { input: { regionId } });
      }
    }
  }

  // Assign queued tasks to idle workers
  for (const task of taskRegistry.values()) {
    if (task.status !== 'queued') continue;
    const role = TASK_ROLE_MAP[task.type];
    if (!role) continue;
    const worker = findIdleWorker(role);
    if (!worker) continue;

    // assign
    task.status = 'running';
    task.assignedAt = new Date().toISOString();
    task.assignedWorkerId = worker.id;
    worker.status = 'busy';
    worker.currentTaskId = task.id;
    worker.currentRegionId = task.regionId;
    worker.lastStartedAt = new Date().toISOString();
    plannerStats.runningTasks++;
    plannerState.activeTaskIds.push(task.id);
    plannerState.lastAssignments.push({ taskId: task.id, workerId: worker.id, ts: new Date().toISOString() });
    if (plannerState.lastAssignments.length > 20) plannerState.lastAssignments.shift();
    plannerStats.totalAssigned++;

    emit('system',
      '[planner] task assigned: ' + task.type + ' → ' + worker.id + ' (' + task.id + ')',
      { taskId: task.id, workerId: worker.id, type: task.type }
    );

    // run synchronously (deterministic, no I/O)
    const result = runWorkerTask(worker, task);
    task.resultId = result.id;

    emit('system',
      '[worker] task completed: ' + task.type + ' worker=' + worker.id,
      { taskId: task.id, workerId: worker.id, resultId: result.id }
    );

    // evaluate
    const evaluation = evaluateResult(task, result);
    task.evaluationId = evaluation.id;
    applyEvaluation(task, worker, evaluation);
  }

  plannerState.backlogCount = countBacklog();
}

// Keep task registry from growing unbounded — prune completed/failed tasks older than 5 minutes
function pruneOldTasks() {
  const cutoff = Date.now() - 5 * 60 * 1000;

  // Collect task ids being pruned so we can also clean linked results/evals
  const pruneTaskIds = new Set();
  for (const [id, task] of taskRegistry.entries()) {
    if ((task.status === 'completed' || task.status === 'failed') &&
        task.completedAt && new Date(task.completedAt).getTime() < cutoff) {
      pruneTaskIds.add(id);
      taskRegistry.delete(id);
    }
  }

  // Prune linked results and evaluations for deleted tasks, plus any orphans older than 10 min
  const evalCutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, ev] of evaluations.entries()) {
    if (pruneTaskIds.has(ev.taskId) || new Date(ev.createdAt).getTime() < evalCutoff) {
      evaluations.delete(id);
    }
  }
  for (const [id, res] of taskResults.entries()) {
    if (pruneTaskIds.has(res.taskId) || new Date(res.createdAt).getTime() < evalCutoff) {
      taskResults.delete(id);
    }
  }
}

// ─── WebSocket (manual RFC 6455) ──────────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
}

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function wsParse(socket, buf) {
  // minimal frame parser — handles single-frame, masked client messages
  if (buf.length < 2) return;
  const fin  = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (opcode === 0x8) {
    // close
    wsClients.delete(socket);
    socket.destroy();
    return;
  }
  if (opcode === 0x9) {
    // ping -> pong (must mirror ping payload per RFC 6455)
    const payloadStart = offset + (masked ? 4 : 0);
    const payloadEnd = payloadStart + payloadLen;
    let pingPayload = buf.slice(payloadStart, payloadEnd);
    if (masked) {
      const mask = buf.slice(offset, offset + 4);
      pingPayload = Buffer.from(pingPayload);
      for (let i = 0; i < pingPayload.length; i++) {
        pingPayload[i] ^= mask[i % 4];
      }
    }

    let pongHeader;
    if (pingPayload.length <= 125) {
      pongHeader = Buffer.alloc(2);
      pongHeader[0] = 0x8a;
      pongHeader[1] = pingPayload.length;
    } else if (pingPayload.length <= 65535) {
      pongHeader = Buffer.alloc(4);
      pongHeader[0] = 0x8a;
      pongHeader[1] = 126;
      pongHeader.writeUInt16BE(pingPayload.length, 2);
    } else {
      pongHeader = Buffer.alloc(10);
      pongHeader[0] = 0x8a;
      pongHeader[1] = 127;
      pongHeader.writeBigUInt64BE(BigInt(pingPayload.length), 2);
    }

    socket.write(Buffer.concat([pongHeader, pingPayload]));
    return;
  }
  if (opcode === 0x1 && masked) {
    const mask = buf.slice(offset, offset + 4);
    const data = buf.slice(offset + 4, offset + 4 + payloadLen);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    try {
      const msg = JSON.parse(data.toString('utf8'));
      handleClientMessage(socket, msg);
    } catch { /* ignore malformed */ }
  }
}

function handleClientMessage(socket, msg) {
  // clients can request a snapshot on demand
  if (msg && msg.type === 'get_snapshot') {
    wsSend(socket, JSON.stringify({ type: 'snapshot', data: snapshot() }));
  }
}

function wsUpgrade(req, socket) {
  const buf = { data: Buffer.alloc(0) };
  wsClients.add(socket);

  // send initial snapshot
  wsSend(socket, JSON.stringify({ type: 'snapshot', data: snapshot() }));
  // send last 20 events
  for (const ev of eventLog.slice(-20)) {
    wsSend(socket, JSON.stringify({ type: 'event', data: ev }));
  }

  socket.on('data', chunk => {
    buf.data = Buffer.concat([buf.data, chunk]);
    while (buf.data.length >= 2) {
      const payloadLen126 = buf.data[1] & 0x7f;
      let headerLen = 2 + (buf.data[1] & 0x80 ? 4 : 0);
      if (payloadLen126 === 126) headerLen += 2;
      else if (payloadLen126 === 127) headerLen += 8;
      const payloadLen = payloadLen126 === 126
        ? buf.data.readUInt16BE(2)
        : payloadLen126 === 127
          ? Number(buf.data.readBigUInt64BE(2))
          : payloadLen126;
      const frameLen = headerLen + payloadLen;
      if (buf.data.length < frameLen) break;
      wsParse(socket, buf.data.slice(0, frameLen));
      buf.data = buf.data.slice(frameLen);
    }
  });

  socket.on('close', () => { wsClients.delete(socket); });
  socket.on('error', () => { wsClients.delete(socket); socket.destroy(); });
}

// ─── HTTP Routes ──────────────────────────────────────────────────────────────
function router(req, res) {
  const url = req.url.split('?')[0];

  // CORS headers (permissive for Railway preview URLs)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET frontend routes
  if (req.method === 'GET' && (
    url === '/' ||
    url === '/worldview' ||
    url === '/app/worldview' ||
    url === '/admin/worldview'
  )) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const bootstrap = JSON.stringify({
      useCesium: RW_USE_CESIUM,
      defaultView: RW_DEFAULT_VIEW,
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
      cesiumAccessToken: CESIUM_ACCESS_TOKEN,
    }).replace(/</g, '\u003c');
    res.end(FRONTEND_HTML.replace('__RW_BOOTSTRAP__', bootstrap));
    return;
  }

  // ── GET /health
  if (req.method === 'GET' && url === '/health') {
    const mergedAgentCount = Object.keys(worldview.agents).length + Object.keys(openSkyLiveState.flights).length;
    const body = JSON.stringify({
      status: 'ok',
      tick: worldview.tick,
      agents: mergedAgentCount,
      regions: Object.keys(worldview.regions).length,
      uptime: process.uptime(),
      ts: new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  // ── GET /rw/spatial/health
  if (req.method === 'GET' && url === '/rw/spatial/health') {
    const mergedAgentCount = Object.keys(worldview.agents).length + Object.keys(openSkyLiveState.flights).length;
    const body = JSON.stringify({
      status: 'ok',
      tick: worldview.tick,
      agents: mergedAgentCount,
      regions: Object.keys(worldview.regions).length,
      websocketClients: wsClients.size,
      opensky: {
        enabled: OPENSKY_ENABLED,
        authConfigured: openSkyLiveState.authConfigured,
        pollingRunning: openSkyLiveState.pollingRunning,
        flights: Object.keys(openSkyLiveState.flights).length,
        fetched: openSkyLiveState.lastFetchedCount,
        normalized: openSkyLiveState.lastNormalizedCount,
        lastRequestUrl: openSkyLiveState.lastRequestUrl,
        lastRequestStatus: openSkyLiveState.lastRequestStatus,
        lastPollAt: openSkyLiveState.lastPollAt,
        lastErrorAt: openSkyLiveState.lastErrorAt,
      },
      uptime: process.uptime(),
      ts: new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  // ── GET /rw/spatial/:regionId
  if (req.method === 'GET' && url.startsWith('/rw/spatial/')) {
    const regionId = url.slice('/rw/spatial/'.length);
    const region = spatialIndex[regionId];
    if (!region) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'region not found', id: regionId }));
      return;
    }
    const agentDetails = region.agents.map(id => worldview.agents[id]).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ region, agents: agentDetails }));
    return;
  }

  // ── GET /rw/spatial  → all regions
  if (req.method === 'GET' && url === '/rw/spatial') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ regions: worldview.regions }));
    return;
  }

  // ── GET /api/flights  → Aviationstack normalized flights
  if (req.method === 'GET' && url === '/api/flights') {
    const flights = aviationstackState.flights;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ flights, count: flights.length, time: aviationstackState.lastPollAt || Date.now() }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url }));
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────
const server = http.createServer(router);

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws' &&
      req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    wsHandshake(req, socket);
    wsUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

initWorld();
bootstrapWorkers();

if (require.main === module) {
  setInterval(simulationLoop, 800);
  setInterval(plannerTick, 2000);
  setInterval(pruneOldTasks, 60000);
  startAviationstackPolling();
  startOpenSkyPolling();
  startOpenSkyFileWatcher();

  server.listen(PORT, '0.0.0.0', () => {
    console.log('[RW Worldview] listening on 0.0.0.0:' + PORT);
    console.log('[RW Worldview] renderer=' + (RW_USE_CESIUM ? 'cesium' : 'legacy-canvas') + ' defaultView=' + RW_DEFAULT_VIEW);
    console.log('[RW Worldview] googleTiles=' + (GOOGLE_MAPS_API_KEY ? 'configured' : 'missing GOOGLE_MAPS_API_KEY'));
  });
}

// ─── Exports (for testing) ────────────────────────────────────────────────────
module.exports = {
  uid,
  safeNumber,
  hasLatLng,
  latLngToGrid,
  normalizeEntityGridPosition,
  getGlobeUnitVectorFromLatLng,
  countVisibleOpenSkyFlights,
  resolveClosestRegion,
  buildOpenSkyFlightEntity,
  emit,
  wsSend,
  wsParse,
  router,
  snapshot,
  worldview,
  eventLog,
  openSkyLiveState,
  openSkyFileState,
  fileCredentials,
  detectAnomalies,
  loadOpenSkyFile,
  normalizeStateBatch,
  errMsg,
  // ── Planner / Worker / Task exports ────────────────────────────────────────
  taskRegistry,
  workerRuntime,
  taskResults,
  evaluations,
  plannerState,
  plannerStats,
  createTask,
  plannerTick,
  evaluateResult,
  applyEvaluation,
  runWorkerTask,
  createWorker,
  bootstrapWorkers,
  onFlightAppeared,
};

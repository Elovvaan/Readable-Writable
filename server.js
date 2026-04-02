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
  token: null,
  tokenExpiresAtMs: 0,
  lastPollAt: null,
  lastErrorAt: null,
  lastFetchedCount: 0,
  lastNormalizedCount: 0,
  authConfigured: true,
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
  lastCount: 0,
  anomalies: [],
};

// Credentials loaded from opensky.json — env vars always take priority.
const fileCredentials = {
  username: '',
  password: '',
};

// ─── Frontend HTML (inline) ───────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RW Worldview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; display: flex; flex-direction: column; height: 100vh; }
    header { background: #111; border-bottom: 1px solid #222; padding: 10px 18px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: .04em; color: #7cf; }
    #status { font-size: .75rem; padding: 3px 8px; border-radius: 999px; background: #1e3a1e; color: #5f5; border: 1px solid #3a6a3a; }
    #status.disconnected { background: #3a1e1e; color: #f55; border-color: #6a3a3a; }
    #controls { margin-left: auto; display: flex; align-items: center; gap: 10px; font-size: .68rem; color: #aaa; flex-wrap: wrap; justify-content: flex-end; }
    .ctrl-toggle { display: inline-flex; align-items: center; gap: 5px; user-select: none; white-space: nowrap; cursor: pointer; }
    .ctrl-toggle input { width: 13px; height: 13px; accent-color: #7cf; cursor: pointer; }
    .ctrl-inline { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .ctrl-compact { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: .62rem; color: #8ea4ba; }
    .ctrl-compact input[type=range] { width: 58px; accent-color: #7cf; transition: filter 220ms ease, transform 220ms ease; }
    .ctrl-compact input[type=range]:hover { filter: brightness(1.12); transform: translateY(-1px); }
    .ctrl-compact select { border: 1px solid #2e3a46; background: #151a22; color: #c8e5ff; border-radius: 4px; font-size: .64rem; padding: 2px 4px; }
    #style-indicator { border: 1px solid #324154; border-radius: 999px; font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; padding: 2px 8px; color: #9ec9f5; background: #101820; }
    #telemetry-bar { display: inline-flex; align-items: center; gap: 8px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: .62rem; color: #8fb6d8; border: 1px solid #283849; border-radius: 6px; padding: 3px 7px; background: #0f161fcc; }
    .telemetry-item { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
    .telemetry-label { color: #65839f; letter-spacing: .07em; }
    .telemetry-value { color: #b9ddff; }
    #telemetry-rec.live { color: #ff7878; text-shadow: 0 0 8px rgba(255,80,80,.4); animation: rec-pulse 1.4s ease-in-out infinite; }
    @keyframes rec-pulse { 0%, 100% { opacity: .62; } 50% { opacity: 1; } }
    .preset-row { display: inline-flex; align-items: center; gap: 5px; }
    .preset-btn { border: 1px solid #2b3c4d; background: #141c25; color: #9ec8e8; border-radius: 999px; font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; padding: 3px 7px; cursor: pointer; transition: background 180ms ease, border-color 180ms ease, color 180ms ease, transform 180ms ease; }
    .preset-btn:hover { background: #1a2938; border-color: #3f658a; color: #d8efff; transform: translateY(-1px); }
    .preset-btn.active { background: #213246; color: #d2e7ff; border-color: #4f80b0; }
    #speed-select { border: 1px solid #2e3a46; background: #151a22; color: #c8e5ff; border-radius: 4px; font-size: .68rem; padding: 3px 6px; }
    #pause-btn { border: 1px solid #2e3a46; background: #151a22; color: #a9d6ff; border-radius: 4px; font-size: .68rem; padding: 4px 8px; cursor: pointer; }
    #pause-btn.active { background: #2b1e1e; color: #ffc2c2; border-color: #5a3333; }
    main { display: grid; grid-template-columns: 1fr 320px; flex: 1; overflow: hidden; }
    #canvas-wrap { position: relative; overflow: hidden; background: #0a0a12; }
    #cesium-world, canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
    #cesium-world { z-index: 1; }
    canvas { z-index: 2; pointer-events: auto; }
    #fx-overlay { position: absolute; inset: 0; z-index: 3; pointer-events: none; mix-blend-mode: screen; opacity: .45; transition: opacity 320ms ease, background 320ms ease, filter 320ms ease; }
    #fx-overlay .scanlines, #fx-overlay .noise, #fx-overlay .vignette, #fx-overlay .pixel-grid { position: absolute; inset: 0; }
    #fx-overlay .scanlines { background: repeating-linear-gradient(to bottom, rgba(220,255,255,.07) 0, rgba(220,255,255,.07) 1px, transparent 1px, transparent 3px); opacity: .2; }
    #fx-overlay .noise { background-image: radial-gradient(rgba(255,255,255,.09) 0.45px, transparent 0.55px); background-size: 3px 3px; opacity: .12; }
    #fx-overlay .pixel-grid { background-image: linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px); background-size: 10px 10px; opacity: .06; }
    #fx-overlay .vignette { background: radial-gradient(circle at center, transparent 48%, rgba(0,0,0,.58) 100%); opacity: .55; }
    body[data-style-mode="crt"] { --style-accent: #8fd7ff; --style-shell: #90caf2; }
    body[data-style-mode="nvg"] { --style-accent: #9dff95; --style-shell: #a3ffae; }
    body[data-style-mode="flir"] { --style-accent: #ffd47f; --style-shell: #ffc983; }
    header h1, .event-entry.agent, .viewport-readout, #style-indicator { color: var(--style-accent, #7cf); border-color: color-mix(in srgb, var(--style-accent, #7cf) 30%, #2e3a46); }
    .panel-title, .selected-label, .stat-label { color: color-mix(in srgb, var(--style-shell, #9cb4cb) 48%, #3b4652); }
    aside { background: #111; border-left: 1px solid #222; display: flex; flex-direction: column; overflow: hidden; }
    .panel-title { font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #555; padding: 10px 14px 6px; border-bottom: 1px solid #1c1c1c; }
    #event-tools { padding: 8px 14px 6px; border-bottom: 1px solid #1a1a1a; display: grid; gap: 6px; }
    #event-search { width: 100%; border: 1px solid #2e3a46; background: #151a22; color: #d2e7ff; border-radius: 4px; font-size: .68rem; padding: 4px 6px; }
    #event-chip-row { display: flex; gap: 5px; flex-wrap: wrap; }
    .event-chip { border: 1px solid #2a2f3a; border-radius: 999px; background: #12151d; color: #9cb4cb; padding: 2px 8px; font-size: .64rem; cursor: pointer; }
    .event-chip.active { background: #213246; color: #d2e7ff; border-color: #3f658a; }
    #event-log { flex: 1; overflow-y: auto; padding: 8px 0; font-size: .72rem; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .event-entry { padding: 3px 14px; border-bottom: 1px solid #161616; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .event-entry .ts { color: #444; margin-right: 6px; }
    .event-entry.agent { color: #7cf; }
    .event-entry.region { color: #fc7; }
    .event-entry.system { color: #a7f; }
    .event-entry.related { background: #1a2330; box-shadow: inset 2px 0 0 #7cf; }
    .event-entry.dimmed { opacity: 0.42; }
    .event-empty { padding: 8px 14px; color: #666; font-style: italic; }
    #selected-panel { border-top: 1px solid #1c1c1c; padding: 10px 14px; font-size: .72rem; }
    #action-panel { border-top: 1px solid #1c1c1c; padding: 8px 14px 10px; font-size: .72rem; }
    .action-row { display: flex; gap: 6px; }
    .action-row.secondary { margin-top: 8px; }
    .action-btn { border: 1px solid #2e3a46; background: #151a22; color: #c8e5ff; border-radius: 4px; font-size: .68rem; padding: 4px 8px; cursor: pointer; }
    .action-btn:disabled { cursor: not-allowed; opacity: .45; }
    .selected-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .selected-label { color: #555; }
    .selected-value { color: #ccc; font-family: monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selected-empty { color: #666; font-style: italic; }
    #stats { padding: 10px 14px; font-size: .72rem; border-top: 1px solid #1c1c1c; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .stat-label { color: #555; }
    .stat-value { color: #ccc; font-family: monospace; text-align: right; }
    .pod-lab { border-top: 1px solid #1c1c1c; padding: 10px 14px 14px; display: grid; gap: 10px; background: #0f1118; }
    .pod-stepper { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .pod-step-chip { border: 1px solid #2e3a46; border-radius: 999px; font-size: .62rem; text-align: center; padding: 3px 0; color: #9ab5cf; background: #121926; }
    .pod-step-chip.active { border-color: #4f80b0; color: #d2e7ff; background: #1e2f45; }
    .pod-step-chip.done { border-color: #2d6f52; color: #b6ffd2; background: #183127; }
    .pod-lock { border: 1px dashed #52424a; border-radius: 6px; padding: 7px 8px; font-size: .68rem; color: #d8a9b8; background: #21151b; }
    .pod-lock.unlocked { border-style: solid; border-color: #2d6f52; color: #b8ffd6; background: #14261d; }
    .pod-lock.flash { animation: pod-unlock-flash 900ms ease; }
    @keyframes pod-unlock-flash { 0% { box-shadow: 0 0 0 0 rgba(120,255,180,.65); } 100% { box-shadow: 0 0 0 14px rgba(120,255,180,0); } }
    .pod-field { display: grid; gap: 4px; font-size: .66rem; color: #8ea4ba; }
    .pod-field textarea { width: 100%; min-height: 52px; border: 1px solid #2e3a46; background: #151a22; color: #d7ebff; border-radius: 4px; padding: 6px; font-size: .68rem; resize: vertical; }
    .pod-field textarea:disabled { opacity: .45; cursor: not-allowed; }
    .pod-live-score { display: grid; gap: 4px; border: 1px solid #2e3a46; background: #121926; border-radius: 6px; padding: 7px 8px; }
    .pod-live-score-row { display: flex; justify-content: space-between; font-size: .66rem; color: #a8c6e2; }
    .pod-live-score strong { color: #ddf0ff; }
    .pod-compare { border: 1px solid #3c4d63; border-radius: 6px; background: #131c28; padding: 7px 8px; font-size: .66rem; color: #b7d4ef; }
    .pod-actions { display: flex; gap: 6px; }
    .pod-actions button { border: 1px solid #2e3a46; background: #151a22; color: #c8e5ff; border-radius: 4px; font-size: .66rem; padding: 4px 8px; cursor: pointer; }
    .pod-actions button:disabled { opacity: .45; cursor: not-allowed; }
    .type-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #2a2f3a; border-radius: 999px; padding: 2px 7px; }
    .type-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    #viewport-controls { position: absolute; top: 10px; left: 10px; display: grid; gap: 6px; z-index: 2; }
    .viewport-row { display: flex; gap: 4px; }
    .viewport-btn { border: 1px solid #2e3a46; background: #151a22e0; color: #c8e5ff; border-radius: 4px; font-size: .66rem; padding: 4px 7px; cursor: pointer; transition: background 180ms ease, border-color 180ms ease, transform 180ms ease; }
    .viewport-btn:hover { background: #1b2633f0; border-color: #44627f; transform: translateY(-1px); }
    .viewport-readout { font-size: .62rem; color: #8ea4ba; background: #0d1219cc; border: 1px solid #253244; border-radius: 4px; padding: 2px 6px; width: fit-content; }
    #cesium-world, canvas, .action-btn, #pause-btn, #style-indicator, .event-chip { transition: filter 260ms ease, box-shadow 260ms ease, color 260ms ease, background 260ms ease, border-color 260ms ease; }
  </style>
</head>
<body>
<header>
  <h1>RW Worldview</h1>
  <span id="status" class="disconnected">disconnected</span>
  <div id="controls">
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-agents" checked>Show Agents</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-regions" checked>Show Regions</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-trails" checked>Show Trails</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-layer-flights" checked>Live Flights</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-layer-traffic" checked>Traffic</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-layer-satellites" checked>Satellites</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-layer-regions" checked>Regions Layer</label>
    <label class="ctrl-toggle"><input type="checkbox" id="toggle-layer-weather">Weather</label>
    <label class="ctrl-toggle type-chip"><span class="type-dot" style="background:#7cc4ff"></span><input type="checkbox" id="toggle-type-agent" checked>Agents</label>
    <label class="ctrl-toggle type-chip"><span class="type-dot" style="background:#ffb77d"></span><input type="checkbox" id="toggle-type-flight" checked>Flights</label>
    <label class="ctrl-toggle type-chip"><span class="type-dot" style="background:#d0a3ff"></span><input type="checkbox" id="toggle-type-satellite" checked>Satellites</label>
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
    <span id="style-indicator">mode: crt</span>
    <div id="telemetry-bar" aria-live="polite">
      <span class="telemetry-item"><span class="telemetry-label">MODE</span><span class="telemetry-value" id="telemetry-mode">CRT</span></span>
      <span class="telemetry-item"><span class="telemetry-label">REC</span><span class="telemetry-value" id="telemetry-rec">●</span></span>
      <span class="telemetry-item"><span class="telemetry-label">LAT/LNG</span><span class="telemetry-value" id="telemetry-coords">--.--, --.--</span></span>
      <span class="telemetry-item"><span class="telemetry-label">UTC</span><span class="telemetry-value" id="telemetry-utc">--:--:--</span></span>
    </div>
    <div class="preset-row">
      <button class="preset-btn active" type="button" data-style-preset="tactical">Tactical</button>
      <button class="preset-btn" type="button" data-style-preset="surveillance">Surveillance</button>
      <button class="preset-btn" type="button" data-style-preset="cinematic">Cinematic</button>
      <button class="preset-btn" type="button" data-style-preset="minimal">Minimal</button>
    </div>
    <label class="ctrl-compact" for="fx-bloom">Bloom<input id="fx-bloom" type="range" min="0" max="100" value="40"></label>
    <label class="ctrl-compact" for="fx-sharpen">Sharp<input id="fx-sharpen" type="range" min="0" max="100" value="35"></label>
    <label class="ctrl-compact" for="fx-noise">Noise<input id="fx-noise" type="range" min="0" max="100" value="28"></label>
    <label class="ctrl-compact" for="fx-vignette">Vignette<input id="fx-vignette" type="range" min="0" max="100" value="40"></label>
    <label class="ctrl-compact" for="fx-pixelation">Density<input id="fx-pixelation" type="range" min="0" max="100" value="22"></label>
    <label class="ctrl-compact" for="fx-glow">Glow<input id="fx-glow" type="range" min="0" max="100" value="45"></label>
    <button id="pause-btn" type="button" aria-pressed="false">Pause Simulation</button>
  </div>
</header>
<main>
  <div id="canvas-wrap">
    <div id="viewport-controls">
      <div class="viewport-row">
        <button id="zoom-out-btn" class="viewport-btn" type="button">−</button>
        <button id="zoom-in-btn" class="viewport-btn" type="button">+</button>
        <button id="reset-view-btn" class="viewport-btn" type="button">Reset View</button>
      </div>
      <div class="viewport-row">
        <button id="pan-left-btn" class="viewport-btn" type="button">←</button>
        <button id="pan-up-btn" class="viewport-btn" type="button">↑</button>
        <button id="pan-down-btn" class="viewport-btn" type="button">↓</button>
        <button id="pan-right-btn" class="viewport-btn" type="button">→</button>
      </div>
      <div id="viewport-readout" class="viewport-readout">zoom 1.00x</div>
    </div>
    <div id="cesium-world"></div>
    <canvas id="world"></canvas>
    <div id="fx-overlay" aria-hidden="true">
      <div class="scanlines"></div>
      <div class="noise"></div>
      <div class="pixel-grid"></div>
      <div class="vignette"></div>
    </div>
  </div>
  <aside>
    <div class="panel-title">Event Stream</div>
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
  </aside>
</main>
<link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Widgets/widgets.css" />
<script src="https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Cesium/Cesium.js"></script>
<script id="rw-bootstrap" type="application/json">__RW_BOOTSTRAP__</script>
<script>
(function () {
  'use strict';

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
  const toggleLayerFlightsEl = document.getElementById('toggle-layer-flights');
  const toggleLayerTrafficEl = document.getElementById('toggle-layer-traffic');
  const toggleLayerSatellitesEl = document.getElementById('toggle-layer-satellites');
  const toggleLayerRegionsEl = document.getElementById('toggle-layer-regions');
  const toggleLayerWeatherEl = document.getElementById('toggle-layer-weather');
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
  let latestSelectedEvent = null;
  let ws, wsRetryDelay = 1000;
  let showAgents = true;
  let showRegions = true;
  let showTrails = true;
  let visibleEntityTypes = { agent: true, flight: true, satellite: true, other: true };
  const layerState = { liveFlights: true, traffic: true, satellites: true, regions: true, weather: false };
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
    tactical: { bloom: 48, sharpen: 44, noise: 32, vignette: 50, pixelation: 28, glow: 54 },
    surveillance: { bloom: 30, sharpen: 64, noise: 24, vignette: 62, pixelation: 34, glow: 36 },
    cinematic: { bloom: 72, sharpen: 28, noise: 40, vignette: 70, pixelation: 18, glow: 66 },
    minimal: { bloom: 18, sharpen: 40, noise: 8, vignette: 26, pixelation: 8, glow: 20 },
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
  let openskyStatus = { enabled: false, authConfigured: false, fetched: 0, normalized: 0, merged: 0, lastPollAt: null, lastErrorAt: null, pollingRunning: false, lastRequestUrl: null, lastRequestStatus: null };
  let lastFlightDebugCounts = { merged: 0, visible: 0, drawn: 0, errors: 0 };
  let lastLayerDiagnostics = {};

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
    cesiumViewer = new Cesium.Viewer('cesium-world', {
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
      navigationHelpButton: false, sceneModePicker: false, infoBox: false, selectionIndicator: false,
      shouldAnimate: true,
    });
    cesiumViewer.scene.skyBox.show = false;
    cesiumViewer.scene.backgroundColor = Cesium.Color.BLACK;
    cesiumViewer.scene.globe.show = true;
    cesiumViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1220');
    cesiumViewer.scene.globe.depthTestAgainstTerrain = true;
    cesiumViewer.scene.skyAtmosphere.show = true;
    cesiumViewer.scene.sun.show = false;
    cesiumViewer.scene.moon.show = false;
    cesiumViewer.scene.requestRenderMode = false;
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
        cesiumViewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(-95, 40, 20000000),
        });
      } else {
        console.error('Missing GOOGLE_MAPS_API_KEY');
        console.warn('[RW Cesium] GOOGLE_MAPS_API_KEY missing; using OpenStreetMap fallback imagery');
        lastCesiumRenderCounts.tilesLoaded = false;
        lastCesiumRenderCounts.tilesState = 'missing-key';
        lastCesiumRenderCounts.tilesError = 'Missing GOOGLE_MAPS_API_KEY';
        cesiumViewer.imageryLayers.removeAll();
        cesiumViewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({
          url: 'https://tile.openstreetmap.org/',
        }));
      }
      lastCesiumRenderCounts.earthInitialized = true;
      lastCesiumRenderCounts.tilesLoaded = !!cesiumGoogleTileset;
      console.info('[RW Cesium] initialized');
    } catch (err) {
      console.error('[RW Cesium] init failed', err);
      lastCesiumRenderCounts.tilesLoaded = false;
      lastCesiumRenderCounts.tilesState = 'failed';
      lastCesiumRenderCounts.tilesError = (err && err.message) ? err.message : String(err || 'unknown');
    }
    bindCesiumSelection();
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
        flightsFetched: Number.isFinite(Number(openskyStatus.fetched)) ? Number(openskyStatus.fetched) : 0,
        flightsMerged,
        flightsVisible: flightsVisibleAfterFilters,
        flightsRendered: flightsDrawn,
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
      destination: Cesium.Cartesian3.fromDegrees(-100, 40, 20000000)
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
    const visibleAgents = agents.filter(a => isEntityTypeVisible(getEntityType(a)));
    const flightsMerged = agents.filter(a => getEntityType(a) === 'flight').length;
    const flightsVisibleAfterFilters = showAgents
      ? visibleAgents.filter(a => getEntityType(a) === 'flight').length
      : 0;
    const drawCounts = { flightsDrawn: 0 };
    latestRegionIntelligence = computeRegionIntelligence();

    globeRegionOverlaySuppressed = false;
    renderRegionOverlays(regions, width, height, now, globeDebug, deferredLabelDraws);
    renderTrailsAndArcs(visibleAgents, width, height, globeDebug);
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

  function renderEntityMarkers(visibleAgents, width, height, now, globeDebug, deferredLabelDraws, deferredSelectionDraws, drawCounts) {
    if (!showAgents) return;
    visibleAgents.forEach(function (a) {
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
      liveFlights: layerState.liveFlights
        ? (flightsInState > 0 ? 'active' : 'no data')
        : 'off',
      traffic: layerState.traffic
        ? 'unavailable in current renderer mode'
        : 'off',
      satellites: layerState.satellites
        ? (satellitesInState > 0 ? 'active' : 'no data')
        : 'off',
      regions: layerState.regions
        ? (regionsInState > 0 ? 'active' : 'no data')
        : 'off',
      weather: layerState.weather
        ? 'not configured'
        : 'off',
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
    cameraLerpTarget = focusPoint;
    if (USE_CESIUM && cesiumViewer) {
      const ll = toLatLngWithFallback(focusPoint);
      if (ll) {
        cesiumCameraLerpState = {
          lng: ll.lng,
          lat: ll.lat,
          height: 1800000,
        };
      }
    }
    focusTargetKey = targetKey;
    focusEffectUntil = Date.now() + 2200;
    const targetId = selectedAgentId || selectedRegionId;
    const label = selectedAgentId ? targetId : ('region ' + targetId);
    lastOperatorActionByTarget[targetKey] = 'focus';
    pushOperatorEvent('operator focused ' + label);
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
    draw();
  }

  function selectRegion(regionId) {
    selectedRegionId = regionId || null;
    selectedAgentId = null;
    updateLatestSelectedEventFromLog();
    refreshRelatedEventHighlight();
    renderSelectedPanel();
    syncFollowTargetState();
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

  function updateCameraMotion(width, height) {
    if (followTargetEnabled) {
      const selectedFocusPoint = getSelectedFocusPoint();
      if (!selectedFocusPoint) {
        followTargetEnabled = false;
        cameraLerpTarget = null;
        followTargetToggleEl.checked = false;
      } else {
        cameraLerpTarget = selectedFocusPoint;
      }
    }
    if (!cameraLerpTarget) return false;
    if (USE_CESIUM && cesiumViewer) {
      const ll = toLatLngWithFallback(cameraLerpTarget);
      if (!ll) return false;
      const currentCarto = Cesium.Cartographic.fromCartesian(cesiumViewer.camera.position);
      const currentLng = Cesium.Math.toDegrees(currentCarto.longitude);
      const currentLat = Cesium.Math.toDegrees(currentCarto.latitude);
      const desiredHeight = followTargetEnabled ? 1400000 : 1800000;
      if (!cesiumCameraLerpState) {
        cesiumCameraLerpState = { lng: currentLng, lat: currentLat, height: currentCarto.height };
      }
      const lerp = followTargetEnabled ? CESIUM_FOLLOW_LERP : CESIUM_FOCUS_LERP;
      cesiumCameraLerpState.lng = Cesium.Math.lerp(cesiumCameraLerpState.lng, ll.lng, lerp);
      cesiumCameraLerpState.lat = Cesium.Math.lerp(cesiumCameraLerpState.lat, ll.lat, lerp);
      cesiumCameraLerpState.height = Cesium.Math.lerp(cesiumCameraLerpState.height, desiredHeight, lerp);
      cesiumCameraMoveInternal = true;
      cesiumFollowDisengageMutedUntil = Date.now() + 120;
      cesiumViewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          cesiumCameraLerpState.lng,
          cesiumCameraLerpState.lat,
          cesiumCameraLerpState.height
        ),
      });
      cesiumCameraMoveInternal = false;
      const closeEnough = Math.abs(cesiumCameraLerpState.lng - ll.lng) < 0.012
        && Math.abs(cesiumCameraLerpState.lat - ll.lat) < 0.012
        && Math.abs(cesiumCameraLerpState.height - desiredHeight) < 1500;
      if (closeEnough && !followTargetEnabled) {
        cameraLerpTarget = null;
        cesiumCameraLerpState = null;
        return false;
      }
      return true;
    }
    const targetOffset = getViewportOffsetToCenterWorld(
      cameraLerpTarget.x,
      cameraLerpTarget.y,
      width,
      height,
      cameraLerpTarget.lat,
      cameraLerpTarget.lng
    );
    const nextOffsetX = viewport.offsetX + ((targetOffset.x - viewport.offsetX) * CAMERA_LERP_FACTOR);
    const nextOffsetY = viewport.offsetY + ((targetOffset.y - viewport.offsetY) * CAMERA_LERP_FACTOR);
    const deltaX = Math.abs(nextOffsetX - viewport.offsetX);
    const deltaY = Math.abs(nextOffsetY - viewport.offsetY);
    viewport.offsetX = nextOffsetX;
    viewport.offsetY = nextOffsetY;
    updateViewportReadout();

    const closeEnough = Math.abs(targetOffset.x - viewport.offsetX) <= CAMERA_EPSILON_PX
      && Math.abs(targetOffset.y - viewport.offsetY) <= CAMERA_EPSILON_PX;
    if (closeEnough && !followTargetEnabled) {
      viewport.offsetX = targetOffset.x;
      viewport.offsetY = targetOffset.y;
      cameraLerpTarget = null;
      updateViewportReadout();
      return false;
    }
    return deltaX > 0.01 || deltaY > 0.01 || followTargetEnabled;
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
    let text = 'zoom ' + viewport.zoom.toFixed(2) + 'x · pan ' + Math.round(viewport.offsetX) + ', ' + Math.round(viewport.offsetY);
    if (USE_CESIUM) {
      text += ' · cesium e:' + lastCesiumRenderCounts.entities + ' r:' + lastCesiumRenderCounts.regions + ' s:' + lastCesiumRenderCounts.satellites;
      text += ' · google tiles:' + (lastCesiumRenderCounts.tilesState || (lastCesiumRenderCounts.tilesLoaded ? 'on' : 'off'));
      if (layerState.traffic) text += ' · traffic:unavailable';
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

  function setViewportZoom(nextZoom) {
    const previousZoom = viewport.zoom;
    viewport.zoom = Math.max(VIEWPORT_ZOOM_MIN, Math.min(VIEWPORT_ZOOM_MAX, nextZoom));
    if (USE_CESIUM && cesiumViewer) {
      const ratio = viewport.zoom >= previousZoom ? 0.8 : 1.2;
      cesiumViewer.camera.zoomBy(cesiumViewer.camera.positionCartographic.height * (ratio - 1));
    }
    syncFollowTargetState();
    updateViewportReadout();
    draw();
  }

  function panViewport(dx, dy) {
    if (USE_CESIUM && cesiumViewer) {
      cesiumViewer.camera.moveRight(dx * 2000);
      cesiumViewer.camera.moveUp(dy * -2000);
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
    followTargetEnabled = false;
    followTargetToggleEl.checked = false;
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
    const fetched = Number.isFinite(Number(openskyStatus.fetched)) ? Number(openskyStatus.fetched) : 0;
    const merged = Number.isFinite(Number(lastFlightDebugCounts.merged))
      ? Number(lastFlightDebugCounts.merged)
      : (Number.isFinite(Number(openskyStatus.merged)) ? Number(openskyStatus.merged) : 0);
    const visibleFlights = Number.isFinite(Number(lastFlightDebugCounts.visible)) ? Number(lastFlightDebugCounts.visible) : 0;
    const drawnFlights = Number.isFinite(Number(lastFlightDebugCounts.drawn)) ? Number(lastFlightDebugCounts.drawn) : 0;
    const erroredFlights = Number.isFinite(Number(lastFlightDebugCounts.errors)) ? Number(lastFlightDebugCounts.errors) : 0;
    const openskyError = openskyStatus && openskyStatus.lastErrorAt ? ' ERR' : '';
    const flightDebugText = 'fetched:' + fetched + ' merged:' + merged + ' visible:' + visibleFlights + ' drawn:' + drawnFlights + ' errors:' + erroredFlights + openskyError;
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
  toggleLayerFlightsEl.addEventListener('change', function () {
    layerState.liveFlights = !!toggleLayerFlightsEl.checked;
    clearSelectionIfHidden();
    refreshEventVisibilityStyling();
    updateStats();
    draw();
  });
  toggleLayerTrafficEl.addEventListener('change', function () {
    layerState.traffic = !!toggleLayerTrafficEl.checked;
    updateStats();
    draw();
  });
  toggleLayerSatellitesEl.addEventListener('change', function () {
    layerState.satellites = !!toggleLayerSatellitesEl.checked;
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
  toggleLayerWeatherEl.addEventListener('change', function () {
    layerState.weather = !!toggleLayerWeatherEl.checked;
    updateStats();
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
    setViewportZoom(viewport.zoom + VIEWPORT_ZOOM_STEP);
  });
  zoomOutBtnEl.addEventListener('click', function () {
    setViewportZoom(viewport.zoom - VIEWPORT_ZOOM_STEP);
  });
  resetViewBtnEl.addEventListener('click', resetViewport);
  panLeftBtnEl.addEventListener('click', function () { panViewport(-VIEWPORT_PAN_STEP, 0); });
  panRightBtnEl.addEventListener('click', function () { panViewport(VIEWPORT_PAN_STEP, 0); });
  panUpBtnEl.addEventListener('click', function () { panViewport(0, -VIEWPORT_PAN_STEP); });
  panDownBtnEl.addEventListener('click', function () { panViewport(0, VIEWPORT_PAN_STEP); });
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

  if (USE_CESIUM) {
    toggleLayerTrafficEl.title = 'Traffic layer unavailable in current renderer mode (Cesium + Google 3D Tiles)';
  }
  toggleLayerWeatherEl.title = 'Weather layer is present as a stub and currently not configured';

  function applySnapshot(nextSnapshot) {
    const snapshotTsMs = Date.now();
    updateAgentTrails(state.agents, nextSnapshot.agents);
    updateFlightTracking(state.agents, nextSnapshot.agents, snapshotTsMs);
    const receivedFlightCount = Object.values(nextSnapshot && nextSnapshot.agents ? nextSnapshot.agents : {}).filter(function (a) {
      return a && a.type === 'flight';
    }).length;
    console.log('Flights received:', receivedFlightCount);
    previousAgentsById = state.agents || {};
    state = nextSnapshot;
    openskyStatus = nextSnapshot && nextSnapshot.opensky
      ? nextSnapshot.opensky
      : { enabled: false, authConfigured: false, fetched: 0, normalized: 0, merged: 0, lastPollAt: null, lastErrorAt: null, pollingRunning: false, lastRequestUrl: null, lastRequestStatus: null };
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
        if (paused) {
          pendingSnapshot = msg.data;
          return;
        }
        updateAgentTrails(state.agents, msg.data.agents);
        updateFlightTracking(state.agents, msg.data.agents, Date.now());
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
  return {
    agents: mergedAgents,
    regions: worldview.regions,
    tick: worldview.tick,
    started: worldview.started,
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
  openSkyLiveState.authConfigured = authConfigured;
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
    }

    const nextFlights = {};
    const previous = openSkyLiveState.flights;
    let normalizedCount = 0;
    for (const row of states) {
      const icao24 = Array.isArray(row) ? String(row[0] || '').trim().toLowerCase() : '';
      const previousFlight = icao24 ? previous['flight-' + icao24] : null;
      const normalized = buildOpenSkyFlightEntity(row, previousFlight);
      if (!normalized) continue;
      normalizedCount++;
      nextFlights[normalized.id] = normalized;
    }

    const visibilityStats = countVisibleOpenSkyFlights(nextFlights, OPENSKY_GLOBE_MIN_Z);
    const visibleCount = visibilityStats.passProjection;
    const drawnCount = visibilityStats.passMinZ;

    openSkyLiveState.lastFetchedCount = states.length;
    openSkyLiveState.lastNormalizedCount = normalizedCount;
    openSkyLiveState.lastVisibleCount = visibleCount;
    openSkyLiveState.lastDrawnCount = drawnCount;

    console.log('OpenSky: fetched ' + states.length + ' flights, normalized ' + normalizedCount + ', visible ' + visibleCount + ', drawn ' + drawnCount);

    let updatedCount = 0;
    for (const flightId of Object.keys(nextFlights)) {
      if (!previous[flightId]) {
        emit('agent', '[flight] ' + flightId + ' appeared (OpenSky)', { id: flightId, source: 'opensky', event: 'appear' }, 'flight');
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
    broadcast('snapshot', snapshot());
  } catch (err) {
    const msg = 'OpenSky poll warning: ' + (err && err.message ? err.message : String(err));
    console.warn('[RW Worldview] ' + msg);
    openSkyLiveState.lastErrorAt = new Date().toISOString();
    openSkyLiveState.lastFetchedCount = 0;
    openSkyLiveState.lastNormalizedCount = 0;
    openSkyLiveState.lastVisibleCount = 0;
    openSkyLiveState.lastDrawnCount = 0;
    emit('system', msg, { source: 'opensky' });
  }
}

function startOpenSkyPolling() {
  if (!OPENSKY_ENABLED) {
    console.log('[RW Worldview] OpenSky polling disabled (RW_OPENSKY_ENABLED != true)');
    return;
  }
  openSkyLiveState.pollingRunning = true;
  console.log('[RW Worldview] OpenSky polling enabled; interval=' + OPENSKY_POLL_INTERVAL_MS + 'ms');
  console.log('[RW Worldview] OpenSky polling URL=' + OPENSKY_STATES_URL + ' publicFallback=' + OPENSKY_PUBLIC_STATES_URL);
  console.log('RW_OPENSKY_ENABLED', process.env.RW_OPENSKY_ENABLED);
  pollOpenSkyFlights().catch(() => {});
  setInterval(() => {
    pollOpenSkyFlights().catch(() => {});
  }, OPENSKY_POLL_INTERVAL_MS);
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
      // File exists but couldn't be read — log and mark error
      console.warn('[RW File] Read error: ' + err.message);
      openSkyFileState.lastErrorAt = new Date().toISOString();
      emit('system', '[file] read error: ' + err.message, { source: 'file' });
    }
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.warn('[RW File] Parse error in ' + OPENSKY_FILE_PATH + ': ' + err.message);
    openSkyFileState.lastErrorAt = new Date().toISOString();
    emit('system', '[file] parse error: ' + err.message, { source: 'file' });
    return;
  }

  // ── Credentials (optional) ──────────────────────────────────────────────────
  // Supports username/password (OpenSky basic auth) or client_id/client_secret
  // as field aliases.  Env vars OPENSKY_USERNAME / OPENSKY_PASSWORD always win.
  const fileUser = String(payload.username || payload.client_id || '').trim();
  const filePass = String(payload.password || payload.client_secret || '').trim();
  if (fileUser && filePass) {
    fileCredentials.username = fileUser;
    fileCredentials.password = filePass;
    console.log('[RW File] Credentials loaded for user: ' + fileUser);
  }

  const states = Array.isArray(payload && payload.states) ? payload.states : [];
  const previous = openSkyFileState.flights;
  const nextFlights = {};

  for (const row of states) {
    const icao24 = Array.isArray(row) ? String(row[0] || '').trim().toLowerCase() : '';
    const prevFlight = icao24 ? previous['flight-' + icao24] : null;
    const entity = buildOpenSkyFlightEntity(row, prevFlight);
    if (!entity) continue;
    entity.source = 'file'; // distinguish from live-API flights
    nextFlights[entity.id] = entity;
  }

  // Anomaly detection — emit events only for newly detected anomalies
  const anomalies = detectAnomalies(nextFlights);
  const prevMsgs = new Set(openSkyFileState.anomalies.map(a => a.msg));
  for (const anomaly of anomalies) {
    if (!prevMsgs.has(anomaly.msg)) {
      console.warn('[RW File] Anomaly: ' + anomaly.msg);
      emit('system', '[file] anomaly: ' + anomaly.msg, { source: 'file', anomaly }, 'flight');
    }
  }
  openSkyFileState.anomalies = anomalies;

  // Emit appear / disappear events
  for (const id of Object.keys(nextFlights)) {
    if (!previous[id]) {
      emit('agent', '[file] ' + id + ' appeared', { id, source: 'file', event: 'appear' }, 'flight');
    }
  }
  for (const id of Object.keys(previous)) {
    if (!nextFlights[id]) {
      emit('agent', '[file] ' + id + ' disappeared', { id, source: 'file', event: 'disappear' }, 'flight');
    }
  }

  openSkyFileState.flights = nextFlights;
  openSkyFileState.lastCount = Object.keys(nextFlights).length;
  openSkyFileState.lastLoadAt = new Date().toISOString();
  openSkyFileState.lastErrorAt = null;

  console.log('[RW File] Loaded ' + states.length + ' states → ' + openSkyFileState.lastCount + ' flights' +
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

  // seed agents
  for (let i = 0; i < 8; i++) {
    const id = uid('agent');
    const keys = Object.keys(worldview.regions);
    const region = keys[Math.floor(Math.random() * keys.length)];
    const entityType = i < 4 ? 'agent' : (i < 6 ? 'flight' : 'satellite');
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
    if (entityType === 'flight') {
      agent.motion = {
        heading: (Math.random() * 360) - 180,
        speed: 1.8 + (Math.random() * 1.2),
        climb: (Math.random() * 0.5) - 0.25,
      };
    } else if (entityType === 'satellite') {
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

if (require.main === module) {
  setInterval(simulationLoop, 800);
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
};

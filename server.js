'use strict';

const http = require('http');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4001;

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

// ─── Frontend HTML (inline) ───────────────────────────────────────────────────
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RW Worldview</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    /* WORLDVIEW RENDERER - globe-primary, no board, no grid, no x/y */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #03070f;
      font-family: Consolas, "Courier New", monospace;
      color: #c8dde8;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(90, 175, 220, 0.02) 0,
        rgba(90, 175, 220, 0.02) 1px,
        transparent 1px,
        transparent 3px
      );
      mix-blend-mode: screen;
      opacity: 0.32;
      z-index: 8;
    }
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(circle at center, rgba(0, 0, 0, 0) 58%, rgba(0, 0, 0, 0.46) 100%);
      z-index: 9;
    }
    #map-view {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 3;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 220ms ease;
    }
    #globe {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      z-index: 4;
      transition: opacity 220ms ease;
    }
    body.local-mode #map-view {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    body.local-mode #globe {
      opacity: 0.24;
    }
    .leaflet-container {
      background: #0b1a2b;
      font: 12px/1.5 Consolas, "Courier New", monospace;
    }
    #hud-bar {
      position: fixed; top: 0; left: 0; right: 0; height: 46px;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 18px;
      background: linear-gradient(180deg, rgba(4, 12, 22, 0.88), rgba(3, 7, 15, 0.70));
      border-bottom: 1px solid rgba(44, 130, 188, 0.30);
      box-shadow: 0 6px 24px rgba(4, 28, 54, 0.28);
      z-index: 20; pointer-events: none;
    }
    #hud-title {
      font-size: 14px; letter-spacing: 4px; font-weight: 700;
      color: #66d9ff; text-shadow: 0 0 12px rgba(102,217,255,0.55);
    }
    #hud-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: 10px;
      margin-right: auto;
      padding-left: 14px;
      min-width: 0;
    }
    #hud-meta .hchip {
      font-size: 9px;
      letter-spacing: 1.4px;
      color: #89bfd8;
      border: 1px solid rgba(54, 124, 160, 0.32);
      background: rgba(7, 17, 28, 0.66);
      padding: 2px 7px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    #hud-meta .hchip.target {
      color: #d9effa;
      border-color: rgba(128, 202, 234, 0.38);
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #hud-status {
      font-size: 10px;
      letter-spacing: 2px;
      color: #5cf2b6;
      border: 1px solid rgba(92, 242, 182, 0.35);
      padding: 2px 7px;
      background: rgba(92, 242, 182, 0.08);
      box-shadow: 0 0 10px rgba(92, 242, 182, 0.18) inset;
    }
    #hud-status.live { animation: livePulse 2.1s ease-in-out infinite; }
    #hud-status.offline { color: #ff7d6e; animation: none; }
    @keyframes livePulse {
      0% { opacity: 0.92; box-shadow: 0 0 8px rgba(92, 242, 182, 0.10) inset, 0 0 3px rgba(92, 242, 182, 0.18); }
      50% { opacity: 1; box-shadow: 0 0 12px rgba(92, 242, 182, 0.22) inset, 0 0 10px rgba(92, 242, 182, 0.26); }
      100% { opacity: 0.92; box-shadow: 0 0 8px rgba(92, 242, 182, 0.10) inset, 0 0 3px rgba(92, 242, 182, 0.18); }
    }
    .side-panel {
      position: fixed; top: 62px; width: 172px;
      background: linear-gradient(180deg, rgba(5, 14, 24, 0.76), rgba(3, 8, 15, 0.68));
      border: 1px solid rgba(44, 130, 188, 0.28);
      padding: 11px 12px;
      box-shadow: 0 0 22px rgba(12, 56, 94, 0.24);
      z-index: 15; pointer-events: none;
    }
    #panel-left  { left: 14px; }
    #panel-right { right: 14px; }
    .pnl-head {
      font-size: 9px; letter-spacing: 3px; color: #56afd8;
      margin-bottom: 9px;
      border-bottom: 1px solid rgba(44,130,188,0.28);
      padding-bottom: 5px;
      text-shadow: 0 0 8px rgba(78, 178, 224, 0.35);
    }
    .pnl-row {
      font-size: 10px; color: #7aaabb; margin: 6px 0;
      display: flex; justify-content: space-between;
    }
    .pnl-row .lbl { color: #4d7789; }
    .pnl-row .val {
      color: #b3e6fb;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 0 7px rgba(140, 225, 255, 0.24);
      font-weight: 700;
      text-align: right;
    }
    #selected-detail {
      margin-top: 9px; padding-top: 8px;
      border-top: 1px solid rgba(44,130,188,0.22);
      font-size: 10px;
      color: #5d8799;
      line-height: 1.75;
      min-height: 50px;
    }
    #selected-detail.locked {
      color: #7fd3ff;
      text-shadow: 0 0 10px rgba(96, 193, 246, 0.26);
      background: rgba(8, 22, 34, 0.38);
      border: 1px solid rgba(82, 170, 215, 0.26);
      padding: 7px;
    }
    #selected-detail .sel-id { color: #c7eeff; font-weight: 700; }
    #hud-foot {
      position: fixed; bottom: 0; left: 0; right: 0; height: 28px;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(180deg, rgba(3, 7, 15, 0.56), rgba(3, 7, 15, 0.78));
      border-top: 1px solid rgba(44,130,188,0.22);
      font-size: 9px; letter-spacing: 3px; color: #3d6e86;
      z-index: 20; pointer-events: none;
    }
    #spatial-controls {
      position: fixed;
      right: 14px;
      bottom: 38px;
      z-index: 21;
      display: grid;
      grid-template-columns: repeat(2, minmax(64px, auto));
      gap: 6px;
      pointer-events: auto;
    }
    .ctl {
      border: 1px solid rgba(92, 167, 216, 0.45);
      background: rgba(6, 16, 28, 0.84);
      color: #8fd7ff;
      font-size: 10px;
      letter-spacing: 1px;
      padding: 6px 8px;
      min-width: 70px;
      cursor: pointer;
      box-shadow: 0 0 10px rgba(41, 134, 194, 0.18);
    }
    .ctl:hover { background: rgba(10, 28, 45, 0.9); }
    .ctl:active { transform: translateY(1px); }
    .ctl.active {
      color: #aef8d7;
      border-color: rgba(92, 242, 182, 0.52);
      box-shadow: 0 0 12px rgba(92, 242, 182, 0.24);
    }
    body.admin .side-panel { width: 186px; padding: 9px 11px; }
    body.admin .pnl-row { margin: 4px 0; font-size: 9.5px; }
    body.admin #hud-bar { height: 42px; }
    body.admin #hud-foot { height: 24px; font-size: 8.5px; }

    #local-context {
      position: fixed;
      left: 50%;
      bottom: 36px;
      transform: translateX(-50%);
      z-index: 23;
      border: 1px solid rgba(78, 164, 214, 0.34);
      background: rgba(6, 16, 28, 0.82);
      color: #92cce2;
      font-size: 9px;
      letter-spacing: 1.4px;
      padding: 5px 9px;
      text-transform: uppercase;
      pointer-events: none;
      opacity: 0;
      transition: opacity 180ms ease;
      max-width: 62vw;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    body.local-mode #local-context { opacity: 1; }

    #event-feed {
      position: fixed;
      left: 14px;
      bottom: 38px;
      width: 320px;
      max-height: 190px;
      z-index: 21;
      border: 1px solid rgba(47, 125, 170, 0.3);
      background: linear-gradient(180deg, rgba(5, 14, 24, 0.76), rgba(3, 8, 15, 0.68));
      box-shadow: 0 0 20px rgba(14, 58, 96, 0.22);
      padding: 8px;
      pointer-events: auto;
    }
    #event-feed .feed-head {
      font-size: 9px;
      letter-spacing: 2px;
      color: #5fb3db;
      margin-bottom: 6px;
      border-bottom: 1px solid rgba(44,130,188,0.24);
      padding-bottom: 4px;
    }
    #feed-list {
      max-height: 162px;
      overflow: auto;
      padding-right: 2px;
    }
    .feed-item {
      width: 100%;
      border: 1px solid rgba(51, 118, 152, 0.26);
      background: rgba(7, 16, 27, 0.52);
      color: #8ebcd1;
      font-size: 9px;
      line-height: 1.4;
      text-align: left;
      padding: 5px 6px;
      margin-bottom: 5px;
      cursor: pointer;
    }
    .feed-item strong {
      color: #b9e7f8;
      font-size: 9px;
      letter-spacing: 0.8px;
    }
    .feed-item[data-pri="3"] { border-color: rgba(255, 192, 96, 0.46); }
    .feed-item[data-pri="4"] {
      border-color: rgba(255, 125, 110, 0.52);
      color: #ffd1cb;
    }
    .feed-item:hover { background: rgba(13, 29, 44, 0.75); }
    .feed-time { color: #57839a; margin-left: 8px; }

    .state-active { color: #7ce1b8 !important; }
    .state-stale { color: #ffd79b !important; }
    .state-lost { color: #ff9a8f !important; }
    .state-alert { color: #ffcf91 !important; }

    .admin-only { display: none; }
    body.admin .admin-only { display: flex; }
    body.admin #event-feed {
      width: 350px;
      max-height: 215px;
    }

    #map-controls {
      position: fixed;
      right: 14px;
      bottom: 130px;
      z-index: 24;
      display: none;
      gap: 6px;
      pointer-events: auto;
      flex-direction: column;
    }
    body.local-mode #map-controls {
      display: flex;
    }
    #map-controls .ctl {
      min-width: 118px;
    }

    #transition-overlay {
      position: fixed;
      inset: 0;
      z-index: 26;
      pointer-events: none;
      opacity: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 220ms ease;
      background: radial-gradient(circle at center, rgba(4, 12, 22, 0.06), rgba(2, 7, 12, 0.72));
    }
    #transition-overlay .msg {
      font-size: 14px;
      letter-spacing: 5px;
      color: #d8f3ff;
      border: 1px solid rgba(117, 201, 242, 0.4);
      background: rgba(7, 16, 27, 0.82);
      padding: 10px 15px;
      text-transform: uppercase;
      box-shadow: 0 0 18px rgba(112, 196, 236, 0.2);
    }
    body.signal-track #transition-overlay,
    body.signal-globe #transition-overlay {
      opacity: 1;
    }
    body.signal-live #hud-bar {
      box-shadow: 0 6px 24px rgba(4, 28, 54, 0.28), 0 0 14px rgba(92, 242, 182, 0.2) inset;
    }

    @media (max-width: 900px) {
      .side-panel {
        width: 148px;
        top: 58px;
        padding: 8px 9px;
      }
      .pnl-row { margin: 4px 0; font-size: 9px; }
      #hud-title { font-size: 12px; letter-spacing: 3px; }
      #hud-meta { gap: 5px; padding-left: 8px; }
      #hud-meta .hchip { font-size: 8px; }
      #hud-meta .hchip.target { max-width: 120px; }
      #map-controls { right: 8px; bottom: 120px; }
      #event-feed {
        left: 8px;
        right: 8px;
        width: auto;
        max-height: 150px;
      }
      #local-context { max-width: 86vw; bottom: 30px; }
    }
  </style>
</head>
<body>
  <div id="map-view"></div>
  <canvas id="globe"></canvas>
  <div id="transition-overlay"><div class="msg" id="transition-msg">TRACKING TARGET</div></div>
  <div id="hud-bar">
    <div id="hud-title">RW WORLDVIEW</div>
    <div id="hud-meta">
      <span id="hud-mode" class="hchip">GLOBAL</span>
      <span id="hud-conn" class="hchip">CONNECTING</span>
      <span id="hud-target" class="hchip target">TARGET —</span>
    </div>
    <div id="hud-status">CONNECTING</div>
  </div>
  <div id="panel-left" class="side-panel">
    <div class="pnl-head">ENTITIES</div>
    <div class="pnl-row"><span class="lbl">AGENTS</span><span class="val" id="cnt-agents">0</span></div>
    <div class="pnl-row"><span class="lbl">REGIONS</span><span class="val" id="cnt-regions">0</span></div>
    <div class="pnl-row"><span class="lbl">FLIGHTS</span><span class="val" id="cnt-flights">0</span></div>
    <div class="pnl-row"><span class="lbl">SATELLITES</span><span class="val" id="cnt-sats">0</span></div>
  </div>
  <div id="panel-right" class="side-panel">
    <div class="pnl-head">TACTICAL</div>
    <div class="pnl-row"><span class="lbl">MODE</span><span class="val" id="info-mode">GLOBAL</span></div>
    <div class="pnl-row"><span class="lbl">TARGET ID</span><span class="val" id="info-target-id">—</span></div>
    <div class="pnl-row"><span class="lbl">TARGET TYPE</span><span class="val" id="info-target-type">—</span></div>
    <div class="pnl-row"><span class="lbl">LAT</span><span class="val" id="info-lat">—</span></div>
    <div class="pnl-row"><span class="lbl">LNG</span><span class="val" id="info-lng">—</span></div>
    <div class="pnl-row"><span class="lbl">STATUS</span><span class="val" id="info-status">IDLE</span></div>
    <div class="pnl-row"><span class="lbl">LAST UPDATE</span><span class="val" id="info-last">—</span></div>
    <div class="pnl-row"><span class="lbl">LAST SEEN</span><span class="val" id="info-last-seen">—</span></div>
    <div class="pnl-row"><span class="lbl">MISSIONS</span><span class="val" id="info-missions">0</span></div>
    <div class="pnl-row"><span class="lbl">ACTIONS</span><span class="val" id="info-actions">0</span></div>
    <div class="pnl-row"><span class="lbl">APPROVALS</span><span class="val" id="info-approvals">0</span></div>
    <div class="pnl-row"><span class="lbl">TICK</span><span class="val" id="info-tick">0</span></div>
    <div class="pnl-row"><span class="lbl">UPTIME</span><span class="val" id="info-uptime">—</span></div>
    <div class="pnl-row"><span class="lbl">TOTAL</span><span class="val" id="info-total">0</span></div>
    <div id="selected-detail">—</div>
    <div id="admin-ops" class="admin-only" style="margin-top:8px; gap:6px; pointer-events:auto;">
      <button id="ctl-admin-cycle" class="ctl" style="min-width:82px;">CYCLE</button>
      <button id="ctl-admin-auto" class="ctl active" style="min-width:82px;">AUTO ON</button>
    </div>
  </div>
  <div id="hud-foot">GLOBE OPERATIONAL SURFACE</div>
  <div id="local-context">AREA: — • TARGET: —</div>
  <div id="map-controls">
    <button id="ctl-local-focus" class="ctl">FOCUS SELECTED</button>
    <button id="ctl-local-recenter" class="ctl">RECENTER</button>
    <button id="ctl-local-back" class="ctl">BACK TO GLOBE</button>
  </div>
  <div id="spatial-controls">
    <button id="ctl-zoom-in" class="ctl">ZOOM +</button>
    <button id="ctl-zoom-out" class="ctl">ZOOM -</button>
    <button id="ctl-home" class="ctl">GLOBAL</button>
    <button id="ctl-focus" class="ctl">FOCUS</button>
    <button id="ctl-track" class="ctl">TRACK</button>
    <button id="ctl-mode" class="ctl">AREA</button>
  </div>
  <div id="event-feed">
    <div class="feed-head">EVENT TIMELINE</div>
    <div id="feed-list"></div>
  </div>
<script
  src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
  crossorigin=""
></script>
<script>
(function () {
  'use strict';

  console.log("NEW WORLDVIEW RENDERER ACTIVE");

  var IS_ADMIN = location.pathname.indexOf('/admin/') === 0;
  if (IS_ADMIN) document.body.classList.add('admin');

  var canvas    = document.getElementById('globe');
  var ctx       = canvas.getContext('2d');
  var statusEl  = document.getElementById('hud-status');
  var selDetail = document.getElementById('selected-detail');
  var modeBtn   = document.getElementById('ctl-mode');
  var hudModeEl = document.getElementById('hud-mode');
  var hudConnEl = document.getElementById('hud-conn');
  var hudTargetEl = document.getElementById('hud-target');
  var transitionMsg = document.getElementById('transition-msg');
  var localContextEl = document.getElementById('local-context');
  var feedListEl = document.getElementById('feed-list');

  var state    = { entities: [], tick: 0, started: null };
  var rot      = 0;
  var selected = null;
  var selectedMeta = null;
  var selectedAreaName = null;
  var selectedPulse = 0;
  var hits     = [];
  var liveFlicker = 0;
  var trailMap = Object.create(null);
  var linkBursts = [];
  var frameCount = 0;
  var viewMode = 'global';
  var map;
  var mapReady = false;
  var mapLayerStreet;
  var mapLayerImagery;
  var mapMarkers;
  var mapTrailLayer;
  var mapLinkLayer;
  var mapTargetLayer;
  var mapTargetPulse;
  var mapFocusCircle;
  var geocodeCache = Object.create(null);
  var lastUpdateIso = null;
  var targetStatus = 'IDLE';
  var lastSignalTs = 0;
  var autoTrack = true;
  var entityRuntime = Object.create(null);
  var eventFeed = [];
  var STATE_STALE_MS = 9000;
  var STATE_LOST_MS = 22000;
  var ws, wsDelay = 1000;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function project(lat, lng, cx, cy, r) {
    var la = lat  * Math.PI / 180;
    var lo = (lng - rot) * Math.PI / 180;
    var x3 = Math.cos(la) * Math.sin(lo);
    var y3 = Math.sin(la);
    var z3 = Math.cos(la) * Math.cos(lo);
    return { x: cx + r * x3, y: cy - r * y3, z: z3 };
  }

  function stableHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function colorForKind(kind) {
    if (kind === 'agent') return { fill: 'rgba(100, 218, 255, 0.96)', halo: 'rgba(100, 218, 255, 0.19)' };
    if (kind === 'satellite') return { fill: 'rgba(255, 228, 112, 0.95)', halo: 'rgba(255, 228, 112, 0.20)' };
    if (kind === 'flight') return { fill: 'rgba(255, 164, 86, 0.94)', halo: 'rgba(255, 164, 86, 0.18)' };
    if (kind === 'region') return { fill: 'rgba(120, 210, 255, 0.35)', halo: 'rgba(120, 210, 255, 0.16)' };
    return { fill: 'rgba(100, 218, 255, 0.90)', halo: 'rgba(100, 218, 255, 0.16)' };
  }

  function setModeLabel() {
    if (modeBtn) {
      modeBtn.textContent = viewMode === 'global' ? 'AREA' : 'WORLD';
      modeBtn.className = viewMode === 'local' ? 'ctl active' : 'ctl';
    }
    if (hudModeEl) {
      hudModeEl.textContent = viewMode === 'local' ? 'LOCAL TRACK' : 'GLOBAL';
    }
  }

  function signalEvent(kind) {
    var cls = kind === 'track' ? 'signal-track' : kind === 'globe' ? 'signal-globe' : 'signal-live';
    if (kind === 'live') {
      var now = Date.now();
      if (now - lastSignalTs < 850) return;
      lastSignalTs = now;
    }
    document.body.classList.add(cls);
    setTimeout(function () {
      document.body.classList.remove(cls);
    }, kind === 'live' ? 180 : 300);
  }

  function showTransition(msg) {
    if (!transitionMsg) return;
    transitionMsg.textContent = msg;
  }

  function ageLabel(ms) {
    if (ms < 1500) return 'NOW';
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 'S AGO';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'M AGO';
    return Math.floor(min / 60) + 'H AGO';
  }

  function entityIdFromMessage(msg) {
    if (!msg) return null;
    var m = String(msg).match(/(agent-[a-f0-9]+|flight-agent-[a-f0-9]+|sat-agent-[a-f0-9]+|alpha|beta|gamma|delta|center)/i);
    return m ? m[1] : null;
  }

  function addEventItem(kind, msg, entityId) {
    var pri = 1;
    var text = String(msg || 'event');
    var upper = text.toUpperCase();
    if (kind === 'track' || kind === 'state') pri = 2;
    if (upper.indexOf('ALERT') >= 0 || upper.indexOf('STALE') >= 0) pri = 3;
    if (upper.indexOf('LOST') >= 0 || kind === 'lost') pri = 4;
    eventFeed.unshift({
      ts: Date.now(),
      kind: kind || 'system',
      msg: text,
      pri: pri,
      entityId: entityId || null
    });
    if (eventFeed.length > 40) eventFeed.length = 40;
    renderEventFeed();
  }

  function renderEventFeed() {
    if (!feedListEl) return;
    var sorted = eventFeed.slice(0, 12).sort(function (a, b) {
      if (b.pri !== a.pri) return b.pri - a.pri;
      return b.ts - a.ts;
    });
    var html = '';
    for (var i = 0; i < sorted.length; i++) {
      var ev = sorted[i];
      var t = new Date(ev.ts);
      var stamp = t.toLocaleTimeString([], { hour12: false });
      var cap = ev.kind.toUpperCase();
      var idAttr = ev.entityId ? ' data-entity="' + ev.entityId + '"' : '';
      html += '<button class="feed-item" data-pri="' + ev.pri + '"' + idAttr + '>'
        + '<strong>' + cap + '</strong><span class="feed-time">' + stamp + '</span><br/>'
        + ev.msg + '</button>';
    }
    feedListEl.innerHTML = html || '<div class="feed-item" data-pri="1">NO EVENTS</div>';
  }

  function opCounts(ent) {
    if (!ent) return { missions: 0, actions: 0, approvals: 0 };
    var missionCount = Array.isArray(ent.missions) ? ent.missions.length : (Number(ent.missionCount) || Number(ent.missions) || 0);
    var actionCount = Array.isArray(ent.actions) ? ent.actions.length : (Number(ent.actionCount) || Number(ent.actions) || 0);
    var approvalCount = Array.isArray(ent.approvals) ? ent.approvals.length : (Number(ent.approvalCount) || Number(ent.approvals) || 0);
    return { missions: missionCount, actions: actionCount, approvals: approvalCount };
  }

  function runtimeState(id) {
    var rec = entityRuntime[id];
    if (!rec) return 'lost';
    var age = Date.now() - (rec.lastSeenAt || 0);
    if (age >= STATE_LOST_MS) return 'lost';
    if (age >= STATE_STALE_MS) return 'stale';
    if (rec.alert) return 'alert';
    return 'active';
  }

  function syncRuntime(entities) {
    var now = Date.now();
    var seen = Object.create(null);
    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      seen[ent.id] = true;
      var rec = entityRuntime[ent.id] || { lastSeenAt: 0, lastLat: null, lastLng: null, status: 'active', alert: false };
      var moved = 0;
      if (typeof rec.lastLat === 'number' && typeof rec.lastLng === 'number') {
        moved = Math.hypot(ent.lat - rec.lastLat, ent.lng - rec.lastLng);
      }
      rec.alert = moved > 2.6;
      rec.lastSeenAt = now;
      rec.lastLat = ent.lat;
      rec.lastLng = ent.lng;
      entityRuntime[ent.id] = rec;
    }
    var keys = Object.keys(entityRuntime);
    for (var k = 0; k < keys.length; k++) {
      var id = keys[k];
      if (seen[id]) continue;
      entityRuntime[id].alert = false;
    }

    if (selected && entityRuntime[selected]) {
      var recSel = entityRuntime[selected];
      var nextState = runtimeState(selected);
      if (recSel.lastEventState !== nextState) {
        recSel.lastEventState = nextState;
        if (nextState === 'stale') addEventItem('state', 'Target stale: ' + selected, selected);
        if (nextState === 'lost') addEventItem('lost', 'Target lost: ' + selected, selected);
        if (nextState === 'alert') addEventItem('state', 'Target alert movement: ' + selected, selected);
      }
    }
  }

  function setViewMode(mode) {
    var nextMode = mode === 'local' ? 'local' : 'global';
    if (viewMode !== nextMode && mapReady) clearRenderedMapArtifacts();
    viewMode = nextMode;
    if (viewMode === 'local') document.body.classList.add('local-mode');
    else document.body.classList.remove('local-mode');
    if (mapReady && viewMode === 'local') {
      setTimeout(function () { map.invalidateSize(); }, 30);
    }
    setModeLabel();
    var foot = document.getElementById('hud-foot');
    if (foot) {
      foot.textContent = viewMode === 'local'
        ? 'LOCAL AREA TRACKING • TICK ' + String(state.tick || 0)
        : 'GLOBE OPERATIONAL SURFACE • TICK ' + String(state.tick || 0);
    }
    var modeInfo = document.getElementById('info-mode');
    if (modeInfo) modeInfo.textContent = viewMode === 'local' ? 'LOCAL TRACK' : 'GLOBAL';
  }

  function areaLabelFromReverseData(data) {
    if (!data || !data.address) return null;
    var a = data.address;
    return a.city || a.town || a.village || a.county || a.state || a.country || null;
  }

  async function resolveAreaName(lat, lng) {
    var key = lat.toFixed(2) + ',' + lng.toFixed(2);
    if (geocodeCache[key]) return geocodeCache[key];
    try {
      var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng) + '&zoom=8';
      var res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return null;
      var data = await res.json();
      var label = areaLabelFromReverseData(data);
      geocodeCache[key] = label || null;
      return geocodeCache[key];
    } catch (_) {
      return null;
    }
  }

  function initMap() {
    if (mapReady || typeof L === 'undefined') return;
    map = L.map('map-view', {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: true,
      preferCanvas: true
    }).setView([18, 0], 2);

    mapLayerStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true
    }).addTo(map);

    mapLayerImagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      crossOrigin: true
    });

    mapMarkers = L.layerGroup().addTo(map);
    mapTrailLayer = L.layerGroup().addTo(map);
    mapLinkLayer = L.layerGroup().addTo(map);
    mapTargetLayer = L.layerGroup().addTo(map);
    mapTargetPulse = L.circle([0, 0], {
      radius: 0,
      color: '#ffe078',
      weight: 1.1,
      opacity: 0,
      fillColor: '#ffe078',
      fillOpacity: 0
    }).addTo(map);
    mapFocusCircle = L.circle([0, 0], {
      radius: 0,
      color: '#ffe078',
      weight: 1.3,
      opacity: 0.84,
      fillOpacity: 0.06
    }).addTo(map);

    mapReady = true;
  }

  function mapColor(kind) {
    if (kind === 'agent') return '#64daff';
    if (kind === 'satellite') return '#ffe470';
    if (kind === 'flight') return '#ffa456';
    if (kind === 'region') return '#9edcff';
    return '#64daff';
  }

  function updateMapEntities() {
    if (!mapReady) return;
    clearRenderedMapArtifacts();
    var entities = state.entities || [];
    if (mapTargetPulse) {
      mapTargetPulse.setStyle({ opacity: 0, fillOpacity: 0 });
      mapTargetPulse.setRadius(0);
    }
    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      if (typeof ent.lat !== 'number' || typeof ent.lng !== 'number') continue;
      var c = mapColor(ent.kind);
      var marker;
      if (ent.kind === 'region') {
        marker = L.circle([ent.lat, ent.lng], {
          radius: 45000,
          color: c,
          weight: 1.3,
          fillOpacity: 0,
          opacity: 0.7
        });
      } else {
        var isSel = selected === ent.id;
        var st = runtimeState(ent.id);
        var stale = st === 'stale';
        var lost = st === 'lost';
        var alert = st === 'alert';
        var markerColor = lost ? '#ff8c81' : alert ? '#ffd08f' : c;
        marker = L.circleMarker([ent.lat, ent.lng], {
          radius: isSel ? 7.5 : ent.kind === 'satellite' ? 5 : ent.kind === 'flight' ? 4.5 : 4,
          color: markerColor,
          weight: isSel ? 1.9 : 1.2,
          fillColor: markerColor,
          fillOpacity: lost ? 0.35 : isSel ? 0.95 : stale ? 0.6 : 0.78,
          opacity: isSel ? 1 : stale ? 0.66 : 0.9
        });
      }
      marker.on('click', (function (meta) {
        return function () {
          lockTarget(meta);
        };
      })(ent));
      marker.addTo(mapMarkers);

      var history = trailMap[ent.id];
      if (history && history.length > 1 && mapTrailLayer) {
        var latLngs = [];
        var lim = Math.min(history.length, 12);
        for (var h = history.length - lim; h < history.length; h++) {
          var m = history[h].meta;
          if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number') continue;
          latLngs.push([m.lat, m.lng]);
        }
        if (latLngs.length > 1) {
          var emph = selected === ent.id;
          var st2 = runtimeState(ent.id);
          var trOpacity = st2 === 'lost' ? 0.12 : emph ? 0.78 : st2 === 'stale' ? 0.17 : 0.24;
          L.polyline(latLngs, {
            color: ent.kind === 'flight' ? '#ffbe80' : '#7ccfff',
            opacity: trOpacity,
            weight: emph ? 2.6 : 1.1,
            lineCap: 'round',
            dashArray: ent.kind === 'flight' && !emph ? '4 4' : null
          }).addTo(mapTrailLayer);
        }
      }

      if (selected === ent.id && mapTargetPulse) {
        mapTargetPulse.setLatLng([ent.lat, ent.lng]);
        mapTargetPulse.setRadius(24000 + Math.sin(selectedPulse) * 6500);
        mapTargetPulse.setStyle({ opacity: 0.82, fillOpacity: 0.06 });
      }
    }
  }

  function safeClearLayerGroup(group) {
    if (!group) return;
    if (typeof group.clearLayers === 'function') {
      group.clearLayers();
      return;
    }
    if (typeof group.eachLayer === 'function' && typeof group.removeLayer === 'function') {
      var toRemove = [];
      group.eachLayer(function (layer) { toRemove.push(layer); });
      for (var i = 0; i < toRemove.length; i++) group.removeLayer(toRemove[i]);
    }
  }

  function clearRenderedMapArtifacts() {
    safeClearLayerGroup(mapMarkers);
    safeClearLayerGroup(mapTrailLayer);
    safeClearLayerGroup(mapLinkLayer);
    safeClearLayerGroup(mapTargetLayer);
  }

  function focusSelectedEntity(forceLocal) {
    if (!selectedMeta || typeof selectedMeta.lat !== 'number' || typeof selectedMeta.lng !== 'number') return;
    if (!mapReady) initMap();
    if (!mapReady) return;
    if (forceLocal) setViewMode('local');
    mapLayerStreet.addTo(map);
    if (mapLayerImagery && map.hasLayer(mapLayerImagery)) map.removeLayer(mapLayerImagery);
    map.flyTo([selectedMeta.lat, selectedMeta.lng], Math.max(7, map.getZoom()), { duration: 0.8 });
    mapFocusCircle.setLatLng([selectedMeta.lat, selectedMeta.lng]);
    mapFocusCircle.setRadius(selectedMeta.kind === 'region' ? 100000 : 30000);
    resolveAreaName(selectedMeta.lat, selectedMeta.lng).then(function (label) {
      selectedAreaName = label;
      updatePanels();
    });
  }

  function jumpTrackedArea() {
    if (!selectedMeta) return;
    focusSelectedEntity(true);
  }

  function alphaVariant(rgba, a) {
    return rgba.replace(/0\.\d+\)$/, a.toFixed(2) + ')');
  }

  function motionLatLng(ent, tSec) {
    var id = ent.id || '';
    var seed = stableHash(id);
    var phase = (seed % 628) / 100;
    var speed = 0.14 + ((seed >>> 8) % 100) / 1000;
    var lat = ent.lat;
    var lng = ent.lng;

    if (ent.kind === 'satellite') {
      lat += Math.sin(tSec * (speed * 1.9) + phase) * 2.2;
      lng += tSec * (speed * 28) + Math.cos(tSec * (speed * 0.8) + phase) * 0.7;
    } else if (ent.kind === 'flight') {
      lat += Math.sin(tSec * (speed * 0.9) + phase) * 0.6;
      lng += tSec * (speed * 14) + ((seed % 2) ? 1 : -1) * 0.45;
    } else if (ent.kind === 'agent') {
      lat += Math.sin(tSec * (speed * 0.65) + phase) * 0.45;
      lng += Math.cos(tSec * (speed * 0.60) + phase) * 0.55;
    } else if (ent.kind === 'region') {
      lat += Math.sin(tSec * 0.22 + phase) * 0.08;
      lng += Math.cos(tSec * 0.2 + phase) * 0.08;
    }

    if (lng > 180) lng -= 360;
    if (lng < -180) lng += 360;
    lat = Math.max(-84, Math.min(84, lat));
    return { lat: lat, lng: lng };
  }

  function pushTrail(id, x, y, kind) {
    if (!trailMap[id]) trailMap[id] = [];
    var trail = trailMap[id];
    var ent = state.entities.find(function (e) { return e.id === id; });
    trail.push({ x: x, y: y, life: 1, kind: kind, meta: ent ? { lat: ent.lat, lng: ent.lng } : null });
    if (trail.length > 18) trail.shift();
  }

  function drawTrails() {
    var ids = Object.keys(trailMap);
    for (var i = 0; i < ids.length; i++) {
      var pts = trailMap[ids[i]];
      if (!pts || pts.length < 2) continue;
      for (var j = 1; j < pts.length; j++) {
        var p0 = pts[j - 1];
        var p1 = pts[j];
        var c = colorForKind(p1.kind);
        var selectedTrail = ids[i] === selected;
        var st = runtimeState(ids[i]);
        var base = st === 'lost' ? 0.10 : st === 'stale' ? 0.15 : 0.2;
        var a = Math.min(p0.life, p1.life) * (selectedTrail ? 0.58 : base);
        ctx.strokeStyle = alphaVariant(c.halo, a);
        ctx.lineWidth = selectedTrail ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      for (var k = 0; k < pts.length; k++) pts[k].life *= 0.94;
      while (pts.length && pts[0].life < 0.06) pts.shift();
    }
  }

  function spawnLinkBurst(projected) {
    if (!projected.length || frameCount % 40 !== 0) return;
    var agents = projected.filter(function (p) { return p.kind === 'agent'; });
    var regions = projected.filter(function (p) { return p.kind === 'region'; });
    var flights = projected.filter(function (p) { return p.kind === 'flight'; });
    if (agents.length && regions.length) {
      var a = agents[Math.floor(Math.random() * agents.length)];
      var r = regions[Math.floor(Math.random() * regions.length)];
      linkBursts.push({ a: a, b: r, life: 1, color: 'rgba(100, 218, 255, 0.32)' });
    }
    if (flights.length && agents.length && Math.random() < 0.55) {
      var f = flights[Math.floor(Math.random() * flights.length)];
      var ag = agents[Math.floor(Math.random() * agents.length)];
      linkBursts.push({ a: f, b: ag, life: 0.82, color: 'rgba(255, 164, 86, 0.28)' });
    }
  }

  function drawLinkBursts() {
    for (var i = linkBursts.length - 1; i >= 0; i--) {
      var l = linkBursts[i];
      var alpha = Math.max(0, l.life);
      if (alpha <= 0.03) {
        linkBursts.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = alphaVariant(l.color, alpha);
      ctx.lineWidth = 0.9;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      l.life *= 0.93;
    }
  }

  function drawFrame() {
    var W = canvas.width, H = canvas.height;
    var cx = W * 0.5, cy = H * 0.5;
    var r = Math.min(W, H) * 0.40;

    ctx.fillStyle = '#03070f';
    ctx.fillRect(0, 0, W, H);

    var halo = ctx.createRadialGradient(cx, cy, r*0.88, cx, cy, r*1.36);
    halo.addColorStop(0, 'rgba(30,100,190,0.16)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(cx, cy, r*1.30, 0, Math.PI*2);
    ctx.fillStyle = halo; ctx.fill();

    var grd = ctx.createRadialGradient(cx-r*0.28, cy-r*0.28, r*0.04, cx, cy, r);
    grd.addColorStop(0,    'rgba(112,200,255,0.92)');
    grd.addColorStop(0.25, 'rgba(30,95,165,0.90)');
    grd.addColorStop(0.70, 'rgba(10,40,80,0.93)');
    grd.addColorStop(1,    'rgba(4,14,32,0.97)');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = grd; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(100,210,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r + 2.6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120, 224, 255, 0.18)';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    var night = ctx.createRadialGradient(cx + r * 0.46, cy + r * 0.18, r * 0.14, cx, cy, r * 1.08);
    night.addColorStop(0, 'rgba(0,0,0,0.02)');
    night.addColorStop(1, 'rgba(0,0,0,0.48)');
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = night;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    var sheenY = cy + Math.sin(rot * Math.PI / 180) * r * 0.48;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = 'rgba(130, 218, 255, 0.13)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(cx, sheenY, r * 0.88, r * 0.24, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    var pars = [-60, -30, 0, 30, 60];
    for (var pi = 0; pi < pars.length; pi++) {
      var latP = pars[pi]; ctx.beginPath(); var pmv = false;
      for (var lo2 = -180; lo2 <= 180; lo2 += 3) {
        var pp = project(latP, lo2, cx, cy, r);
        if (pp.z > 0) { if (!pmv) { ctx.moveTo(pp.x,pp.y); pmv=true; } else ctx.lineTo(pp.x,pp.y); }
        else { pmv = false; }
      }
      ctx.strokeStyle = latP===0 ? 'rgba(100,195,255,0.26)' : 'rgba(55,130,195,0.13)';
      ctx.lineWidth = 0.6; ctx.stroke();
    }

    for (var lm = -150; lm <= 180; lm += 30) {
      ctx.beginPath(); var mmv = false;
      for (var la2 = -88; la2 <= 88; la2 += 3) {
        var mp = project(la2, lm, cx, cy, r);
        if (mp.z > 0) { if (!mmv) { ctx.moveTo(mp.x,mp.y); mmv=true; } else ctx.lineTo(mp.x,mp.y); }
        else { mmv = false; }
      }
      ctx.strokeStyle = 'rgba(55,130,195,0.11)'; ctx.lineWidth = 0.6; ctx.stroke();
    }

    var entities = state.entities || [];
    var projected = [];
    hits = [];
    var tSec = Date.now() * 0.001;

    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      if (typeof ent.lat !== 'number' || typeof ent.lng !== 'number') continue;
      var moved = motionLatLng(ent, tSec);
      var ep = project(moved.lat, moved.lng, cx, cy, r);
      if (ep.z <= 0.04) continue;
      projected.push({ id: ent.id, kind: ent.kind || 'agent', x: ep.x, y: ep.y, z: ep.z, meta: ent });
      pushTrail(ent.id, ep.x, ep.y, ent.kind || 'agent');
    }

    drawTrails();
    spawnLinkBurst(projected);
    drawLinkBursts();

    for (var j = 0; j < projected.length; j++) {
      var p = projected[j];
      var ent2 = p.meta;
      var dotR = 2.2 + p.z * 2.8;
      var tone = colorForKind(ent2.kind || 'agent');
      var pulseK = 0.82 + 0.18 * Math.sin(selectedPulse + j * 0.57);
      var entState = runtimeState(ent2.id);
      var isAlert = entState === 'alert';
      var isStale = entState === 'stale';
      var isLost = entState === 'lost';

      if (ent2.kind === 'region') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR + 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120, 210, 255, 0.42)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR + 2.6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120, 210, 255, 0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR + 3.4 * pulseK, 0, Math.PI*2);
        ctx.fillStyle = tone.halo;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR * pulseK, 0, Math.PI*2);
        ctx.fillStyle = isLost ? 'rgba(255, 130, 112, 0.62)' : isStale ? 'rgba(255, 201, 133, 0.72)' : tone.fill;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.1, dotR * 0.44), 0, Math.PI*2);
        ctx.fillStyle = 'rgba(245, 252, 255, 0.92)';
        ctx.fill();
      }

      if (ent2.kind === 'satellite') {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, dotR + 6.5, dotR + 2.6, selectedPulse * 0.2, 0, Math.PI * 2);
        ctx.strokeStyle = isLost ? 'rgba(255,140,120,0.20)' : 'rgba(255,228,112,0.34)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }

      if (ent2.kind === 'flight') {
        var flTrail = trailMap[ent2.id];
        if (flTrail && flTrail.length > 1) {
          var p0 = flTrail[flTrail.length - 2];
          var p1 = flTrail[flTrail.length - 1];
          var vx = p1.x - p0.x;
          var vy = p1.y - p0.y;
          var mag = Math.hypot(vx, vy);
          if (mag > 0.4) {
            vx /= mag;
            vy /= mag;
            var len = selected === ent2.id ? 16 : 11;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + vx * len, p.y + vy * len);
            ctx.strokeStyle = selected === ent2.id ? 'rgba(255, 205, 140, 0.92)' : 'rgba(255, 174, 112, 0.62)';
            ctx.lineWidth = selected === ent2.id ? 1.4 : 0.9;
            ctx.stroke();
          }
        }
      }

      if (selected === ent2.id) {
        var pulse = 8.8 + Math.sin(selectedPulse) * 3.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, dotR + pulse, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,214,118,0.95)'; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, dotR + pulse + 4.3, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,214,118,0.44)'; ctx.lineWidth = 1.1; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, dotR + pulse + 7.8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,214,118,0.25)'; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x + dotR + 2, p.y);
        ctx.lineTo(p.x + dotR + 11, p.y);
        ctx.moveTo(p.x - dotR - 2, p.y);
        ctx.lineTo(p.x - dotR - 11, p.y);
        ctx.moveTo(p.x, p.y + dotR + 2);
        ctx.lineTo(p.x, p.y + dotR + 11);
        ctx.moveTo(p.x, p.y - dotR - 2);
        ctx.lineTo(p.x, p.y - dotR - 11);
        ctx.strokeStyle = 'rgba(255, 220, 120, 0.62)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }

      if (isAlert && selected !== ent2.id) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR + 5 + Math.sin(selectedPulse + j) * 1.6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 173, 98, 0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      hits.push({ id: ent2.id, x: p.x, y: p.y, meta: ent2 });
    }
  }

  function updatePanels() {
    var entities = state.entities || [];
    var counts = { agent:0, region:0, flight:0, satellite:0 };
    for (var i = 0; i < entities.length; i++) {
      var k = entities[i].kind; if (counts[k] !== undefined) counts[k]++;
    }
    document.getElementById('cnt-agents').textContent  = counts.agent;
    document.getElementById('cnt-regions').textContent = counts.region;
    document.getElementById('cnt-flights').textContent = counts.flight;
    document.getElementById('cnt-sats').textContent    = counts.satellite;
    document.getElementById('info-tick').textContent   = state.tick || 0;
    document.getElementById('info-total').textContent  = entities.length;
    var infoLast = document.getElementById('info-last');
    if (infoLast) infoLast.textContent = lastUpdateIso ? new Date(lastUpdateIso).toLocaleTimeString() : '—';
    if (hudConnEl) hudConnEl.textContent = statusEl.textContent || 'CONNECTING';
    if (state.started) {
      var sec = Math.floor((Date.now() - new Date(state.started)) / 1000);
      var hh = Math.floor(sec/3600), mm = Math.floor((sec%3600)/60), ss = sec%60;
      document.getElementById('info-uptime').textContent =
        (hh?hh+'h ':'')+(mm?mm+'m ':'')+ ss+'s';
    }
    if (selected) {
      var ent = entities.find(function(e) { return e.id === selected; });
      if (ent) {
        selectedMeta = ent;
        targetStatus = runtimeState(ent.id).toUpperCase();
        if (targetStatus === 'ACTIVE') targetStatus = viewMode === 'local' ? 'TRACKED' : 'LOCKED';
        var infoId = document.getElementById('info-target-id');
        var infoType = document.getElementById('info-target-type');
        var infoLat = document.getElementById('info-lat');
        var infoLng = document.getElementById('info-lng');
        var infoStat = document.getElementById('info-status');
        var infoSeen = document.getElementById('info-last-seen');
        var infoMissions = document.getElementById('info-missions');
        var infoActions = document.getElementById('info-actions');
        var infoApprovals = document.getElementById('info-approvals');
        var rc = entityRuntime[ent.id];
        var countsOp = opCounts(ent);
        if (infoId) infoId.textContent = ent.id;
        if (infoType) infoType.textContent = String(ent.kind || 'unknown').toUpperCase();
        if (infoLat) infoLat.textContent = ent.lat.toFixed(3);
        if (infoLng) infoLng.textContent = ent.lng.toFixed(3);
        if (infoStat) infoStat.textContent = targetStatus;
        if (infoSeen) infoSeen.textContent = rc ? ageLabel(Date.now() - rc.lastSeenAt) : '—';
        if (infoMissions) infoMissions.textContent = String(countsOp.missions);
        if (infoActions) infoActions.textContent = String(countsOp.actions);
        if (infoApprovals) infoApprovals.textContent = String(countsOp.approvals);
        if (infoStat) {
          infoStat.classList.remove('state-active', 'state-stale', 'state-lost', 'state-alert');
          infoStat.classList.add('state-' + runtimeState(ent.id));
        }
        if (hudTargetEl) hudTargetEl.textContent = 'TARGET ' + ent.id;
        if (localContextEl) {
          localContextEl.textContent = 'AREA: ' + (selectedAreaName || 'RESOLVING') + ' • TARGET: ' + ent.id + ' • ' + targetStatus;
        }
        selDetail.className = 'locked';
        selDetail.innerHTML = '<span class="sel-id">'+ent.id+'</span><br/>'
          +'LOCKED: '+ent.kind.toUpperCase()+'<br/>'
          +ent.lat.toFixed(2)+'°'+', '+ent.lng.toFixed(2)+'°'
          +(selectedAreaName ? '<br/>AREA: '+selectedAreaName.toUpperCase() : '')
          +'<br/>STATUS: '+targetStatus
          +'<br/>LAST SEEN: '+(rc ? ageLabel(Date.now() - rc.lastSeenAt) : '—')
          +'<br/>OPS: M'+countsOp.missions+' A'+countsOp.actions+' P'+countsOp.approvals;
      } else {
        selDetail.className = '';
        var rec = entityRuntime[selected];
        if (rec && typeof rec.lastLat === 'number' && typeof rec.lastLng === 'number') {
          targetStatus = runtimeState(selected).toUpperCase();
          if (targetStatus !== 'LOST') targetStatus = 'STALE';
          selDetail.innerHTML = '<span class="sel-id">'+selected+'</span><br/>LAST KNOWN<br/>'
            +rec.lastLat.toFixed(2)+'°'+', '+rec.lastLng.toFixed(2)+'°<br/>'
            +'STATUS: '+targetStatus+'<br/>LAST SEEN: '+ageLabel(Date.now() - rec.lastSeenAt);
          selectedMeta = { id: selected, lat: rec.lastLat, lng: rec.lastLng, kind: 'agent' };
          if (localContextEl) localContextEl.textContent = 'AREA: ' + (selectedAreaName || 'UNKNOWN') + ' • TARGET: ' + selected + ' • ' + targetStatus;
        } else {
          selDetail.textContent = '—';
          selected = null;
          selectedMeta = null;
          targetStatus = 'IDLE';
        }
      }
    } else {
      selDetail.className = '';
      selDetail.textContent = '—';
      selectedMeta = null;
      targetStatus = 'IDLE';
      var idleId = document.getElementById('info-target-id');
      var idleType = document.getElementById('info-target-type');
      var idleLat = document.getElementById('info-lat');
      var idleLng = document.getElementById('info-lng');
      var idleStat = document.getElementById('info-status');
      var idleSeen = document.getElementById('info-last-seen');
      var idleMissions = document.getElementById('info-missions');
      var idleActions = document.getElementById('info-actions');
      var idleApprovals = document.getElementById('info-approvals');
      if (idleId) idleId.textContent = '—';
      if (idleType) idleType.textContent = '—';
      if (idleLat) idleLat.textContent = '—';
      if (idleLng) idleLng.textContent = '—';
      if (idleStat) idleStat.textContent = 'IDLE';
      if (idleSeen) idleSeen.textContent = '—';
      if (idleMissions) idleMissions.textContent = '0';
      if (idleActions) idleActions.textContent = '0';
      if (idleApprovals) idleApprovals.textContent = '0';
      if (idleStat) idleStat.classList.remove('state-active', 'state-stale', 'state-lost', 'state-alert');
      if (hudTargetEl) hudTargetEl.textContent = 'TARGET —';
      if (localContextEl) localContextEl.textContent = 'AREA: — • TARGET: —';
    }
  }

  function lockTarget(meta) {
    if (!meta) return;
    if (mapReady) clearRenderedMapArtifacts();
    selected = meta.id;
    selectedMeta = meta;
    selectedAreaName = null;
    targetStatus = 'ACQUIRING';
    showTransition('TRACKING TARGET');
    signalEvent('track');
    addEventItem('track', 'Tracking target ' + meta.id, meta.id);
    if (entityRuntime[meta.id]) entityRuntime[meta.id].lastEventState = runtimeState(meta.id);
    updatePanels();
    setTimeout(function () {
      setViewMode('local');
      focusSelectedEntity(true);
      targetStatus = 'TRACKED';
      updatePanels();
    }, 160);
  }

  function backToGlobe() {
    if (mapReady) clearRenderedMapArtifacts();
    targetStatus = selected ? 'LOCKED' : 'IDLE';
    showTransition('RETURNING TO GLOBE');
    signalEvent('globe');
    addEventItem('system', 'Returned to global overview', selected);
    setTimeout(function () {
      setViewMode('global');
      if (mapReady) map.flyTo([18, 0], 2, { duration: 0.65 });
      updatePanels();
    }, 120);
  }

  canvas.addEventListener('click', function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var best = null, bestD = 12;
    for (var i = 0; i < hits.length; i++) {
      var dx = hits[i].x - mx, dy = hits[i].y - my;
      var d = Math.sqrt(dx*dx + dy*dy);
      if (d < bestD) { best = hits[i]; bestD = d; }
    }
    selected = best ? best.id : null;
    selectedMeta = best ? best.meta : null;
    selectedAreaName = null;
    if (selectedMeta) {
      lockTarget(selectedMeta);
    }
    updatePanels();
  });

  function animTick() {
    rot = (rot + 0.055) % 360;
    selectedPulse += 0.12;
    liveFlicker += 0.11;
    frameCount++;
    if (!statusEl.classList.contains('offline')) {
      statusEl.classList.add('live');
      if ((frameCount % 90) < 3) {
        statusEl.style.opacity = String(0.8 + Math.random() * 0.2);
      } else {
        statusEl.style.opacity = String(0.92 + Math.sin(liveFlicker) * 0.08);
      }
      var foot = document.getElementById('hud-foot');
      if (foot) {
        foot.textContent = viewMode === 'local'
          ? 'LOCAL AREA TRACKING • TICK ' + String(state.tick || 0)
          : 'GLOBE OPERATIONAL SURFACE • TICK ' + String(state.tick || 0);
      }
    }
    drawFrame();
    if ((frameCount % 8) === 0) updatePanels();
    requestAnimationFrame(animTick);
  }

  async function fetchWorldview() {
    try {
      var res = await fetch('/rw/worldview/world', { cache: 'no-store' });
      if (!res.ok) return;
      var data = await res.json();
      state = {
        entities: Array.isArray(data.entities) ? data.entities : [],
        tick:     data.tick || 0,
        started:  data.started || state.started
      };
      lastUpdateIso = data.ts || new Date().toISOString();
      syncRuntime(state.entities);
      signalEvent('live');
      updateMapEntities();
      updatePanels();
    } catch (_) {}
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = function() {
      statusEl.textContent='LIVE';
      statusEl.className='live';
      if (hudConnEl) hudConnEl.textContent = 'LIVE';
      wsDelay=1000;
    };
    ws.onmessage = function(e) {
      try {
        var m = JSON.parse(e.data);
        if (!m || !m.type) return;
        if (m.type === 'event' && m.data) {
          addEventItem(m.data.kind || 'system', m.data.msg || 'event', entityIdFromMessage(m.data.msg));
        }
        fetchWorldview();
      } catch(_){}
    };
    ws.onclose = function() {
      statusEl.textContent='OFFLINE';
      statusEl.className='offline';
      if (hudConnEl) hudConnEl.textContent = 'OFFLINE';
      setTimeout(connect, wsDelay); wsDelay=Math.min(wsDelay*2,16000);
    };
    ws.onerror = function() { ws.close(); };
  }

  function initWorldview() {
    console.log("NEW WORLDVIEW RENDERER ACTIVE");
    initMap();
    setViewMode('global');

    var zoomInBtn = document.getElementById('ctl-zoom-in');
    var zoomOutBtn = document.getElementById('ctl-zoom-out');
    var homeBtn = document.getElementById('ctl-home');
    var focusBtn = document.getElementById('ctl-focus');
    var trackBtn = document.getElementById('ctl-track');
    var modeToggleBtn = document.getElementById('ctl-mode');
    var localFocusBtn = document.getElementById('ctl-local-focus');
    var localRecenterBtn = document.getElementById('ctl-local-recenter');
    var localBackBtn = document.getElementById('ctl-local-back');
    var adminCycleBtn = document.getElementById('ctl-admin-cycle');
    var adminAutoBtn = document.getElementById('ctl-admin-auto');

    if (zoomInBtn) zoomInBtn.onclick = function () { if (mapReady) map.zoomIn(); };
    if (zoomOutBtn) zoomOutBtn.onclick = function () { if (mapReady) map.zoomOut(); };
    if (homeBtn) homeBtn.onclick = function () { setViewMode('global'); if (mapReady) map.flyTo([18, 0], 2, { duration: 0.8 }); };
    if (focusBtn) focusBtn.onclick = function () { focusSelectedEntity(true); };
    if (trackBtn) trackBtn.onclick = function () {
      autoTrack = !autoTrack;
      trackBtn.className = autoTrack ? 'ctl active' : 'ctl';
      trackBtn.textContent = autoTrack ? 'TRACK ON' : 'TRACK OFF';
      if (autoTrack) jumpTrackedArea();
      addEventItem('system', autoTrack ? 'Auto tracking enabled' : 'Auto tracking paused', selected);
    };
    if (modeToggleBtn) modeToggleBtn.onclick = function () {
      if (viewMode === 'global') {
        setViewMode('local');
        if (selectedMeta) focusSelectedEntity(false);
        else if (mapReady) map.flyTo([18, 0], 3, { duration: 0.7 });
      } else {
        backToGlobe();
      }
    };
    if (localFocusBtn) localFocusBtn.onclick = function () { focusSelectedEntity(false); };
    if (localRecenterBtn) localRecenterBtn.onclick = function () {
      if (selectedMeta) {
        map.flyTo([selectedMeta.lat, selectedMeta.lng], Math.max(7, map.getZoom()), { duration: 0.55 });
      }
    };
    if (localBackBtn) localBackBtn.onclick = function () { backToGlobe(); };
    if (adminCycleBtn) adminCycleBtn.onclick = function () {
      fetchWorldview();
      addEventItem('system', 'Admin forced cycle', selected);
    };
    if (adminAutoBtn) adminAutoBtn.onclick = function () {
      autoTrack = !autoTrack;
      adminAutoBtn.textContent = autoTrack ? 'AUTO ON' : 'AUTO OFF';
      adminAutoBtn.className = autoTrack ? 'ctl active' : 'ctl';
      addEventItem('system', autoTrack ? 'Admin set automation ON' : 'Admin set automation OFF', selected);
    };

    if (feedListEl) {
      feedListEl.onclick = function (ev) {
        var t = ev.target;
        while (t && t !== feedListEl && !t.getAttribute('data-entity')) t = t.parentElement;
        if (!t || t === feedListEl) return;
        var id = t.getAttribute('data-entity');
        if (!id) return;
        var ent = (state.entities || []).find(function (x) { return x.id === id; });
        if (ent) lockTarget(ent);
      };
    }

    addEventItem('system', 'Worldview operational surface online', null);
    renderEventFeed();

    fetchWorldview();
    setInterval(fetchWorldview, 3000);
    connect();
    requestAnimationFrame(animTick);
  }

  window.onload = initWorldview;

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

function emit(kind, msg, patch) {
  const ev = { kind, msg, ts: new Date().toISOString(), patch };
  eventLog.push(ev);
  if (eventLog.length > 100) eventLog.shift();
  broadcast('event', ev);
}

function snapshot() {
  return {
    agents: worldview.agents,
    regions: worldview.regions,
    tick: worldview.tick,
    started: worldview.started,
  };
}

function stableSeedFromId(id) {
  let s = 2166136261;
  for (let i = 0; i < id.length; i++) {
    s ^= id.charCodeAt(i);
    s = Math.imul(s, 16777619);
  }
  return s >>> 0;
}

function worldviewEntityFromId(id, kind, tick) {
  const seed = stableSeedFromId(id);
  const latPhase = ((seed % 360) + tick * 1.3) * Math.PI / 180;
  const lngBase = (seed * 7 + tick * 2) % 360;
  return {
    id,
    kind,
    lat: Math.sin(latPhase) * (kind === 'satellite' ? 72 : 58),
    lng: lngBase > 180 ? lngBase - 360 : lngBase
  };
}

// ─── Simulation / Agent loop ──────────────────────────────────────────────────
function initWorld() {
  // seed regions
  const regionDefs = [
    { id: 'alpha',  x: 25, y: 25 },
    { id: 'beta',   x: 75, y: 25 },
    { id: 'gamma',  x: 25, y: 75 },
    { id: 'delta',  x: 75, y: 75 },
    { id: 'center', x: 50, y: 50 },
  ];
  for (const r of regionDefs) {
    worldview.regions[r.id] = { id: r.id, x: r.x, y: r.y, agents: [] };
    spatialIndex[r.id] = worldview.regions[r.id];
  }

  // seed agents
  for (let i = 0; i < 8; i++) {
    const id = uid('agent');
    const keys = Object.keys(worldview.regions);
    const region = keys[Math.floor(Math.random() * keys.length)];
    const agent = {
      id,
      x: Math.random() * 100,
      y: Math.random() * 100,
      region,
      active: true,
      state: 'idle',
      memory: [],
    };
    worldview.agents[id] = agent;
    worldview.regions[region].agents.push(id);
  }
}

function tickAgent(agent) {
  // simple autonomous behaviour: random walk + state transitions
  const states = ['idle', 'exploring', 'reading', 'writing'];
  const dx = (Math.random() - 0.5) * 4;
  const dy = (Math.random() - 0.5) * 4;
  agent.x = Math.max(0, Math.min(100, agent.x + dx));
  agent.y = Math.max(0, Math.min(100, agent.y + dy));

  if (Math.random() < 0.08) {
    agent.state = states[Math.floor(Math.random() * states.length)];
    emit('agent', agent.id + ' → ' + agent.state, null);
  }

  // re-assign region based on proximity
  let closest = null, bestDist = Infinity;
  for (const r of Object.values(worldview.regions)) {
    const d = Math.hypot(agent.x - r.x, agent.y - r.y);
    if (d < bestDist) { bestDist = d; closest = r; }
  }
  if (closest && closest.id !== agent.region) {
    const old = worldview.regions[agent.region];
    if (old) old.agents = old.agents.filter(a => a !== agent.id);
    agent.region = closest.id;
    closest.agents.push(agent.id);
    emit('region', agent.id + ' entered ' + closest.id, null);
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
    res.end(FRONTEND_HTML);
    return;
  }

  // ── GET /health
  if (req.method === 'GET' && url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      tick: worldview.tick,
      agents: Object.keys(worldview.agents).length,
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
    const body = JSON.stringify({
      status: 'ok',
      tick: worldview.tick,
      agents: Object.keys(worldview.agents).length,
      regions: Object.keys(worldview.regions).length,
      websocketClients: wsClients.size,
      uptime: process.uptime(),
      ts: new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  // ── GET /rw/worldview/world
  if (req.method === 'GET' && url === '/rw/worldview/world') {
    const agents = Object.keys(worldview.agents);
    const regions = Object.keys(worldview.regions);
    const entities = [];

    for (let i = 0; i < agents.length; i++) {
      entities.push(worldviewEntityFromId(agents[i], 'agent', worldview.tick + i));
      if (i % 2 === 0) {
        entities.push(worldviewEntityFromId('flight-' + agents[i], 'flight', worldview.tick + i * 2));
      }
      if (i % 3 === 0) {
        entities.push(worldviewEntityFromId('sat-' + agents[i], 'satellite', worldview.tick + i * 3));
      }
    }

    for (let j = 0; j < regions.length; j++) {
      entities.push(worldviewEntityFromId(regions[j], 'region', worldview.tick + j));
    }

    if (entities.length === 0) {
      entities.push({ id: 'earth-core', kind: 'region', lat: 0, lng: 0 });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tick: worldview.tick,
      started: worldview.started,
      entities,
      ts: new Date().toISOString()
    }));
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
setInterval(simulationLoop, 800);

server.listen(PORT, '0.0.0.0', () => {
  console.log('[RW Worldview] listening on 0.0.0.0:' + PORT);
});

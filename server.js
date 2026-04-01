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
    #speed-select { border: 1px solid #2e3a46; background: #151a22; color: #c8e5ff; border-radius: 4px; font-size: .68rem; padding: 3px 6px; }
    #pause-btn { border: 1px solid #2e3a46; background: #151a22; color: #a9d6ff; border-radius: 4px; font-size: .68rem; padding: 4px 8px; cursor: pointer; }
    #pause-btn.active { background: #2b1e1e; color: #ffc2c2; border-color: #5a3333; }
    main { display: grid; grid-template-columns: 1fr 320px; flex: 1; overflow: hidden; }
    #canvas-wrap { position: relative; overflow: hidden; background: #0a0a12; }
    canvas { display: block; width: 100%; height: 100%; }
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
    .type-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #2a2f3a; border-radius: 999px; padding: 2px 7px; }
    .type-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    #viewport-controls { position: absolute; top: 10px; left: 10px; display: grid; gap: 6px; z-index: 2; }
    .viewport-row { display: flex; gap: 4px; }
    .viewport-btn { border: 1px solid #2e3a46; background: #151a22e0; color: #c8e5ff; border-radius: 4px; font-size: .66rem; padding: 4px 7px; cursor: pointer; }
    .viewport-readout { font-size: .62rem; color: #8ea4ba; background: #0d1219cc; border: 1px solid #253244; border-radius: 4px; padding: 2px 6px; width: fit-content; }
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
    <button id="pause-btn" type="button" aria-pressed="false">Pause Simulation</button>
    <label class="ctrl-inline" for="render-mode-select">View
      <select id="render-mode-select" aria-label="Rendering mode">
        <option value="grid" selected>Grid</option>
        <option value="globe">Globe (experimental)</option>
      </select>
    </label>
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
    <canvas id="world"></canvas>
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
      <span class="stat-label">Speed</span><span class="stat-value" id="s-speed">1x</span>
      <span class="stat-label">Uptime</span><span class="stat-value" id="s-uptime">—</span>
    </div>
  </aside>
</main>
<script>
(function () {
  'use strict';

  const canvas  = document.getElementById('world');
  const ctx     = canvas.getContext('2d');
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
  const renderModeSelectEl = document.getElementById('render-mode-select');
  const AGENT_RENDER_RADIUS = 5;
  const AGENT_HIT_RADIUS = 11;
  const TRAIL_MAX_POINTS = 10;
  const SNAPSHOT_BASE_INTERVAL_MS = 4000;
  const VIEWPORT_ZOOM_MIN = 0.5;
  const VIEWPORT_ZOOM_MAX = 3;
  const VIEWPORT_ZOOM_STEP = 0.2;
  const VIEWPORT_PAN_STEP = 36;
  const CAMERA_LERP_FACTOR = 0.18;
  const CAMERA_EPSILON_PX = 0.6;
  let state = { agents: {}, regions: {}, tick: 0, started: null };
  let eventLog = [];
  let agentTrails = {};
  let selectedAgentId = null;
  let selectedRegionId = null;
  let latestSelectedEvent = null;
  let ws, wsRetryDelay = 1000;
  let showAgents = true;
  let showRegions = true;
  let showTrails = true;
  let visibleEntityTypes = { agent: true, flight: true, satellite: true, other: true };
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
  let viewport = { zoom: 1, offsetX: 0, offsetY: 0 };
  let renderMode = 'grid';
  let followTargetEnabled = false;
  let cameraLerpTarget = null;

  const TYPE_STYLE = {
    agent: { fill: '#7cc4ff', stroke: '#abd8ff', trail: '#7cc4ff55', trailSelected: '#bfe4ffcc' },
    flight: { fill: '#ffb77d', stroke: '#ffd2ad', trail: '#ffb77d55', trailSelected: '#ffe0c4cc' },
    satellite: { fill: '#d0a3ff', stroke: '#e2c7ff', trail: '#d0a3ff55', trailSelected: '#ecdfffcc' },
    other: { fill: '#8ea0b4', stroke: '#bac7d6', trail: '#8ea0b455', trailSelected: '#d6deebcc' },
  };

  // ── Canvas resize ──
  function resize() {
    const wrap = canvas.parentElement;
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Draw ──
  function draw() {
    const W = canvas.width, H = canvas.height;
    const cameraUpdated = updateCameraMotion(W, H);
    ctx.clearRect(0, 0, W, H);
    const now = Date.now();

    const regions = Object.values(state.regions);
    const agents  = Object.values(state.agents);
    const visibleAgents = agents.filter(a => isEntityTypeVisible(getEntityType(a)));

    if (renderMode === 'grid') {
      // grid
      ctx.strokeStyle = '#151520';
      ctx.lineWidth = 1;
      const step = 48;
      for (let x = 0; x <= W; x += step) {
        const sx = applyViewportX(x, W);
        if (sx < -1 || sx > W + 1) continue;
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      }
      for (let y = 0; y <= H; y += step) {
        const sy = applyViewportY(y, H);
        if (sy < -1 || sy > H + 1) continue;
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
      }
    } else {
      drawGlobeBase(W, H);
    }

    const regionOccupancy = getRegionOccupancy();

    // regions
    if (showRegions) regions.forEach(r => {
      const regionPoint = getEntityWorldPoint(r);
      const regionPos = worldToCanvas(regionPoint.x, regionPoint.y, W, H, regionPoint.lat, regionPoint.lng);
      if (!regionPos) return;
      const rx = regionPos.x, ry = regionPos.y;
      const occupancy = regionOccupancy[r.id] || 0;
      const status = regionStatusFromOccupancy(occupancy);
      const isSelected = selectedRegionId === r.id;
      const regionKey = getCurrentTargetKey('region', r.id);
      const isFlagged = !!flaggedTargets[regionKey];
      const isFocused = focusTargetKey === regionKey && now < focusEffectUntil;
      const regionSize = 60 * viewport.zoom;
      ctx.save();
      const rectX = rx - (regionSize / 2);
      const rectY = ry - (regionSize / 2);
      const rectSize = regionSize;
      if (isSelected) {
        ctx.fillStyle = '#8ec5ff22';
        ctx.fillRect(rectX, rectY, rectSize, rectSize);
      }
      ctx.strokeStyle =
        status === 'HOT' ? '#ff8e8ecc' :
        status === 'ACTIVE' ? '#fccb88cc' :
        '#a8b0cc88';
      ctx.lineWidth = isSelected ? 2.25 : 1.5;
      if (isFlagged) {
        ctx.shadowBlur = 6;
        ctx.shadowColor = '#ffd37a';
      }
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(rectX, rectY, rectSize, rectSize);
      ctx.setLineDash([]);
      if (isFocused) {
        ctx.strokeStyle = '#9cf';
        ctx.lineWidth = 3;
        ctx.strokeRect(rectX - 3, rectY - 3, rectSize + 6, rectSize + 6);
      }
      ctx.fillStyle = '#fc7';
      ctx.font = Math.max(8, 10 * viewport.zoom).toFixed(1) + 'px monospace';
      ctx.fillText(r.id, rx - (28 * viewport.zoom), ry - (33 * viewport.zoom));
      ctx.fillStyle = '#bfc7d2';
      ctx.font = Math.max(9, 11 * viewport.zoom).toFixed(1) + 'px monospace';
      ctx.fillText(String(occupancy), rx - (3 * viewport.zoom), ry + (4 * viewport.zoom));
      ctx.restore();
    });

    // trails
    if (showTrails) visibleAgents.forEach(a => {
      const trail = agentTrails[a.id];
      if (!trail || trail.length < 2) return;
      const isSelected = selectedAgentId === a.id;
      const typeStyle = getEntityTypeStyle(a);
      ctx.save();
      ctx.beginPath();
      const first = worldToCanvas(trail[0].x, trail[0].y, W, H, trail[0].lat, trail[0].lng);
      if (!first) {
        ctx.restore();
        return;
      }
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < trail.length; i++) {
        const pt = worldToCanvas(trail[i].x, trail[i].y, W, H, trail[i].lat, trail[i].lng);
        if (!pt) continue;
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = isSelected ? typeStyle.trailSelected : typeStyle.trail;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
      ctx.restore();
    });

    // agents
    if (showAgents) visibleAgents.forEach(a => {
      const agentPoint = getEntityWorldPoint(a);
      const agentPos = worldToCanvas(agentPoint.x, agentPoint.y, W, H, agentPoint.lat, agentPoint.lng);
      if (!agentPos) return;
      const ax = agentPos.x;
      const ay = agentPos.y;
      const isSelected = selectedAgentId === a.id;
      const agentKey = getCurrentTargetKey('agent', a.id);
      const isFlagged = !!flaggedTargets[agentKey];
      const isFocused = focusTargetKey === agentKey && now < focusEffectUntil;
      const typeStyle = getEntityTypeStyle(a);
      ctx.save();
      if (isSelected) {
        const pulse = 1 + ((Math.sin(now / 220) + 1) * (isFocused ? 0.3 : 0.18));
        ctx.shadowBlur = 12;
        ctx.shadowColor = isFocused ? '#cfeaff' : '#9cf';
        ctx.beginPath();
        ctx.arc(ax, ay, ((isFocused ? 11 : 8) * viewport.zoom) * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = isFocused ? '#d7edff' : '#9cf8';
        ctx.lineWidth = isFocused ? 2.2 : 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ax, ay, AGENT_RENDER_RADIUS * viewport.zoom, 0, Math.PI * 2);
      ctx.fillStyle = a.active ? typeStyle.fill : '#2b3544';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#e8f7ff' : (a.active ? typeStyle.stroke : '#223041');
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
      if (isFlagged) {
        ctx.beginPath();
        ctx.arc(ax, ay, (AGENT_RENDER_RADIUS + 3.5) * viewport.zoom, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd37a88';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.fillStyle = '#ccc';
      ctx.font = Math.max(7, 9 * viewport.zoom).toFixed(1) + 'px monospace';
      ctx.fillText(a.id, ax + (7 * viewport.zoom), ay + (4 * viewport.zoom));
      ctx.restore();
    });

    // tick label
    ctx.fillStyle = '#222';
    ctx.font = '11px monospace';
    ctx.fillText('tick ' + state.tick, 8, H - 8);

    if (cameraUpdated && (followTargetEnabled || cameraLerpTarget)) {
      requestAnimationFrame(draw);
    }
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

  function eventMatchesSelected(ev) {
    if (!ev || typeof ev.msg !== 'string') return false;
    if (selectedAgentId && ev.msg.includes(selectedAgentId)) return true;
    if (selectedRegionId && ev.msg.includes(selectedRegionId)) return true;
    return false;
  }

  function eventMatchesFilters(ev) {
    const msg = String((ev && ev.msg) || '');
    const filter = activeEventFilter;
    if (filter === 'tick' && !msg.startsWith('tick ')) return false;
    if (filter === 'movement' && ev.kind !== 'agent') return false;
    if (filter === 'region' && ev.kind !== 'region') return false;
    if (filter === 'operator' && !msg.startsWith('operator ')) return false;
    if (!eventSearchQuery) return true;
    const haystack = [msg, ev.kind || '', ev.entityType || ''].join(' ').toLowerCase();
    return haystack.includes(eventSearchQuery);
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
    return !!visibleEntityTypes[type];
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
      const occupancy = getRegionOccupancy()[selectedRegion.id] || 0;
      const status = regionStatusFromOccupancy(occupancy);
      const insideIds = Object.values(state.agents)
        .filter(a => isEntityTypeVisible(getEntityType(a)))
        .filter(a => a.region === selectedRegion.id)
        .map(a => a.id);
      const insideSummary = insideIds.length > 8 ? (insideIds.length + ' agents') : insideIds.join(', ');
      selectedPanel.innerHTML =
        '<div class="selected-grid">' +
        '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selectedRegion.id) + '</span>' +
        '<span class="selected-label">TYPE</span><span class="selected-value">region</span>' +
        '<span class="selected-label">OCCUPANCY</span><span class="selected-value">' + occupancy + '</span>' +
        '<span class="selected-label">STATUS</span><span class="selected-value">' + status + '</span>' +
        '<span class="selected-label">FLAGGED</span><span class="selected-value">' + (isFlagged ? 'yes' : 'no') + '</span>' +
        '<span class="selected-label">LAST ACTION</span><span class="selected-value">' + escHtml(lastAction) + '</span>' +
        '<span class="selected-label">INSIDE</span><span class="selected-value">' + escHtml(insideSummary || '—') + '</span>' +
        '<span class="selected-label">LAST EVENT</span><span class="selected-value">' + escHtml(lastEvent) + '</span>' +
        '</div>';
      syncActionButtons();
      return;
    }

    const selected = selectedAgent;
    const agentKey = getCurrentTargetKey('agent', selected.id);
    const isFlagged = !!flaggedTargets[agentKey];
    const lastAction = lastOperatorActionByTarget[agentKey] || '—';
    selectedPanel.innerHTML =
      '<div class="selected-grid">' +
      '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selected.id) + '</span>' +
      '<span class="selected-label">TYPE</span><span class="selected-value">' + escHtml(getEntityType(selected)) + '</span>' +
      '<span class="selected-label">X</span><span class="selected-value">' + selected.x.toFixed(2) + '</span>' +
      '<span class="selected-label">Y</span><span class="selected-value">' + selected.y.toFixed(2) + '</span>' +
      '<span class="selected-label">LAT</span><span class="selected-value">' + (Number.isFinite(selected.lat) ? selected.lat.toFixed(2) : '—') + '</span>' +
      '<span class="selected-label">LNG</span><span class="selected-value">' + (Number.isFinite(selected.lng) ? selected.lng.toFixed(2) : '—') + '</span>' +
      '<span class="selected-label">STATUS</span><span class="selected-value">' + escHtml(selected.state || (selected.active ? 'active' : 'inactive')) + '</span>' +
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
      followTargetEnabled = false;
      cameraLerpTarget = null;
      followTargetToggleEl.checked = false;
      pushOperatorEvent('operator follow disabled (no selection)');
    }
  }

  function pushOperatorEvent(msg) {
    const ev = { kind: 'system', msg: msg, ts: new Date().toISOString(), entityType: null };
    eventLog.push(ev);
    if (eventLog.length > 120) eventLog.shift();
    pushEvent(ev);
  }

  function runFocusAction() {
    const targetKey = getCurrentTargetKey();
    if (!targetKey) return;
    const focusPoint = getSelectedFocusPoint();
    if (!focusPoint) return;
    cameraLerpTarget = focusPoint;
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
    if (renderMode === 'globe') {
      const globePoint = projectGlobePosition(worldX, worldY, width, height, lat, lng);
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

  function worldToCanvas(x, y, width, height, lat, lng) {
    if (renderMode === 'globe') {
      const globePoint = projectGlobePosition(x, y, width, height, lat, lng);
      if (!globePoint) return null;
      return {
        x: applyViewportX(globePoint.baseX, width),
        y: applyViewportY(globePoint.baseY, height),
      };
    }
    const baseX = (x / 100) * width;
    const baseY = (y / 100) * height;
    return {
      x: applyViewportX(baseX, width),
      y: applyViewportY(baseY, height),
    };
  }

  function getEntityWorldPoint(entity) {
    if (!entity) return { x: 0, y: 0, lat: null, lng: null };
    const hasLatLng = Number.isFinite(entity.lat) && Number.isFinite(entity.lng);
    return {
      x: Number.isFinite(entity.x) ? entity.x : 50,
      y: Number.isFinite(entity.y) ? entity.y : 50,
      lat: hasLatLng ? entity.lat : null,
      lng: hasLatLng ? entity.lng : null,
    };
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
    viewportReadoutEl.textContent =
      'zoom ' + viewport.zoom.toFixed(2) + 'x · pan ' + Math.round(viewport.offsetX) + ', ' + Math.round(viewport.offsetY);
  }

  function setViewportZoom(nextZoom) {
    viewport.zoom = Math.max(VIEWPORT_ZOOM_MIN, Math.min(VIEWPORT_ZOOM_MAX, nextZoom));
    syncFollowTargetState();
    updateViewportReadout();
    draw();
  }

  function panViewport(dx, dy) {
    if (renderMode === 'globe') return;
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
    if (!showRegions) return null;
    for (const r of Object.values(state.regions)) {
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

  function projectGlobePosition(worldX, worldY, width, height, lat, lng) {
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
    const baseX = cx + (radius * cosLat * Math.sin(lon));
    const baseY = cy - (radius * Math.sin(latRad));
    return { baseX, baseY };
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

  function regionStatusFromOccupancy(occupancy) {
    if (occupancy <= 0) return 'IDLE';
    if (occupancy <= 2) return 'ACTIVE';
    return 'HOT';
  }

  // ── Stats ──
  function updateStats() {
    const allAgents = Object.values(state.agents || {});
    const visibleAgents = allAgents.filter(a => isEntityTypeVisible(getEntityType(a)));
    document.getElementById('s-tick').textContent    = state.tick;
    document.getElementById('s-agents').textContent  = visibleAgents.length + '/' + allAgents.length;
    document.getElementById('s-regions').textContent = Object.keys(state.regions).length;
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
      followTargetEnabled = false;
      cameraLerpTarget = null;
      return;
    }
    const selectedFocusPoint = getSelectedFocusPoint();
    if (!selectedFocusPoint) {
      followTargetEnabled = false;
      cameraLerpTarget = null;
      followTargetToggleEl.checked = false;
      return;
    }
    followTargetEnabled = true;
    cameraLerpTarget = selectedFocusPoint;
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
    if (!showRegions && selectedRegionId) {
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
  renderModeSelectEl.addEventListener('change', function () {
    renderMode = renderModeSelectEl.value === 'globe' ? 'globe' : 'grid';
    draw();
  });

  speedSelectEl.addEventListener('change', function () {
    const nextSpeed = Number(speedSelectEl.value);
    simulationSpeed = Number.isFinite(nextSpeed) && nextSpeed > 0 ? nextSpeed : 1;
    updateStats();
  });

  function applySnapshot(nextSnapshot) {
    updateAgentTrails(state.agents, nextSnapshot.agents);
    state = nextSnapshot;
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
  canvas.addEventListener('click', function (e) {
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

  // ── WebSocket ──
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = function () {
      statusEl.textContent = 'connected';
      statusEl.className = '';
      wsRetryDelay = 1000;
      eventLog.push({ kind: 'system', msg: 'WebSocket connected' });
      if (eventLog.length > 120) eventLog.shift();
      pushEvent({ kind: 'system', msg: 'WebSocket connected' });
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
        state = msg.data;
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
        eventLog.push(msg.data);
        if (eventLog.length > 120) eventLog.shift();
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
      eventLog.push({ kind: 'system', msg: 'WebSocket disconnected — retrying in ' + (wsRetryDelay/1000) + 's' });
      if (eventLog.length > 120) eventLog.shift();
      pushEvent({ kind: 'system', msg: 'WebSocket disconnected — retrying in ' + (wsRetryDelay/1000) + 's' });
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
  return {
    agents: worldview.agents,
    regions: worldview.regions,
    tick: worldview.tick,
    started: worldview.started,
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

// ─── Simulation / Agent loop ──────────────────────────────────────────────────
function initWorld() {
  // seed regions
  const regionDefs = [
    { id: 'alpha',  x: 25, y: 25, lat: 42, lng: -120 },
    { id: 'beta',   x: 75, y: 25, lat: 40, lng: 75 },
    { id: 'gamma',  x: 25, y: 75, lat: -24, lng: -75 },
    { id: 'delta',  x: 75, y: 75, lat: -22, lng: 110 },
    { id: 'center', x: 50, y: 50, lat: 0, lng: 0 },
  ];
  for (const r of regionDefs) {
    worldview.regions[r.id] = { id: r.id, x: r.x, y: r.y, agents: [] };
    worldview.regions[r.id].lat = r.lat;
    worldview.regions[r.id].lng = r.lng;
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

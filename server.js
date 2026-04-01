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
    header { background: #111; border-bottom: 1px solid #222; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: .04em; color: #7cf; }
    #status { font-size: .75rem; padding: 3px 8px; border-radius: 999px; background: #1e3a1e; color: #5f5; border: 1px solid #3a6a3a; }
    #status.disconnected { background: #3a1e1e; color: #f55; border-color: #6a3a3a; }
    main { display: grid; grid-template-columns: 1fr 320px; flex: 1; overflow: hidden; }
    #canvas-wrap { position: relative; overflow: hidden; background: #0a0a12; }
    canvas { display: block; width: 100%; height: 100%; }
    aside { background: #111; border-left: 1px solid #222; display: flex; flex-direction: column; overflow: hidden; }
    .panel-title { font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #555; padding: 10px 14px 6px; border-bottom: 1px solid #1c1c1c; }
    #event-log { flex: 1; overflow-y: auto; padding: 8px 0; font-size: .72rem; font-family: 'Cascadia Code', 'Fira Code', monospace; }
    .event-entry { padding: 3px 14px; border-bottom: 1px solid #161616; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .event-entry .ts { color: #444; margin-right: 6px; }
    .event-entry.agent { color: #7cf; }
    .event-entry.region { color: #fc7; }
    .event-entry.system { color: #a7f; }
    .event-entry.related { background: #1a2330; box-shadow: inset 2px 0 0 #7cf; }
    #selected-panel { border-top: 1px solid #1c1c1c; padding: 10px 14px; font-size: .72rem; }
    .selected-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .selected-label { color: #555; }
    .selected-value { color: #ccc; font-family: monospace; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .selected-empty { color: #666; font-style: italic; }
    #stats { padding: 10px 14px; font-size: .72rem; border-top: 1px solid #1c1c1c; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; }
    .stat-label { color: #555; }
    .stat-value { color: #ccc; font-family: monospace; text-align: right; }
  </style>
</head>
<body>
<header>
  <h1>RW Worldview</h1>
  <span id="status" class="disconnected">disconnected</span>
</header>
<main>
  <div id="canvas-wrap"><canvas id="world"></canvas></div>
  <aside>
    <div class="panel-title">Event Stream</div>
    <div id="event-log"></div>
    <div class="panel-title">Selected Target</div>
    <div id="selected-panel"></div>
    <div class="panel-title">Stats</div>
    <div id="stats">
      <span class="stat-label">Tick</span><span class="stat-value" id="s-tick">—</span>
      <span class="stat-label">Agents</span><span class="stat-value" id="s-agents">—</span>
      <span class="stat-label">Regions</span><span class="stat-value" id="s-regions">—</span>
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
  const selectedPanel = document.getElementById('selected-panel');
  const statusEl = document.getElementById('status');
  const AGENT_RENDER_RADIUS = 5;
  const AGENT_HIT_RADIUS = 11;
  const TRAIL_MAX_POINTS = 10;
  let state = { agents: {}, regions: {}, tick: 0, started: null };
  let eventLog = [];
  let agentTrails = {};
  let selectedAgentId = null;
  let selectedRegionId = null;
  let latestSelectedEvent = null;
  let ws, wsRetryDelay = 1000;

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
    ctx.clearRect(0, 0, W, H);
    const now = Date.now();

    const regions = Object.values(state.regions);
    const agents  = Object.values(state.agents);

    // grid
    ctx.strokeStyle = '#151520';
    ctx.lineWidth = 1;
    const step = 48;
    for (let x = 0; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    const regionOccupancy = getRegionOccupancy();

    // regions
    regions.forEach(r => {
      const rx = (r.x / 100) * W, ry = (r.y / 100) * H;
      const occupancy = regionOccupancy[r.id] || 0;
      const status = regionStatusFromOccupancy(occupancy);
      const isSelected = selectedRegionId === r.id;
      ctx.save();
      ctx.strokeStyle =
        status === 'HOT' ? '#ff8e8ecc' :
        status === 'ACTIVE' ? '#fccb88cc' :
        '#a8b0cc88';
      ctx.lineWidth = isSelected ? 2.25 : 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(rx - 30, ry - 30, 60, 60);
      ctx.setLineDash([]);
      if (isSelected) {
        ctx.fillStyle = '#8ec5ff22';
        ctx.fillRect(rx - 30, ry - 30, 60, 60);
      }
      ctx.fillStyle = '#fc7';
      ctx.font = '10px monospace';
      ctx.fillText(r.id, rx - 28, ry - 33);
      ctx.fillStyle = '#bfc7d2';
      ctx.font = '11px monospace';
      ctx.fillText(String(occupancy), rx - 3, ry + 4);
      ctx.restore();
    });

    // trails
    agents.forEach(a => {
      const trail = agentTrails[a.id];
      if (!trail || trail.length < 2) return;
      const isSelected = selectedAgentId === a.id;
      ctx.save();
      ctx.beginPath();
      const first = worldToCanvas(trail[0].x, trail[0].y, W, H);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < trail.length; i++) {
        const pt = worldToCanvas(trail[i].x, trail[i].y, W, H);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = isSelected ? '#aee9' : '#7cf3';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
      ctx.restore();
    });

    // agents
    agents.forEach(a => {
      const { x: ax, y: ay } = worldToCanvas(a.x, a.y, W, H);
      const isSelected = selectedAgentId === a.id;
      ctx.save();
      if (isSelected) {
        const pulse = 1 + ((Math.sin(now / 220) + 1) * 0.18);
        ctx.shadowBlur = 12;
        ctx.shadowColor = '#9cf';
        ctx.beginPath();
        ctx.arc(ax, ay, 8 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = '#9cf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ax, ay, AGENT_RENDER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = a.active ? '#7cf' : '#335';
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#cff' : (a.active ? '#aef' : '#224');
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ccc';
      ctx.font = '9px monospace';
      ctx.fillText(a.id, ax + 7, ay + 4);
      ctx.restore();
    });

    // tick label
    ctx.fillStyle = '#222';
    ctx.font = '11px monospace';
    ctx.fillText('tick ' + state.tick, 8, H - 8);
  }

  // ── Event log ──
  function pushEvent(ev) {
    const div = document.createElement('div');
    div.className = 'event-entry ' + (ev.kind || 'system');
    if ((selectedAgentId || selectedRegionId) && eventMatchesSelected(ev)) div.classList.add('related');
    const ts = new Date(ev.ts || Date.now()).toISOString().substr(11, 8);
    div.innerHTML = '<span class="ts">' + ts + '</span>' + escHtml(ev.msg || JSON.stringify(ev));
    log.prepend(div);
    while (log.children.length > 120) log.removeChild(log.lastChild);
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

  function refreshRelatedEventHighlight() {
    for (const child of log.children) child.classList.remove('related');
    if (!selectedAgentId && !selectedRegionId) return;
    for (const child of log.children) {
      if ((selectedAgentId && child.textContent.includes(selectedAgentId)) ||
          (selectedRegionId && child.textContent.includes(selectedRegionId))) {
        child.classList.add('related');
      }
    }
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

  function renderSelectedPanel() {
    const selectedAgent = selectedAgentId ? state.agents[selectedAgentId] : null;
    const selectedRegion = selectedRegionId ? state.regions[selectedRegionId] : null;
    if (!selectedAgent && !selectedRegion) {
      selectedPanel.innerHTML = '<div class="selected-empty">No target selected</div>';
      return;
    }
    const lastEvent = latestSelectedEvent ? (latestSelectedEvent.msg || '—') : '—';
    if (selectedRegion) {
      const occupancy = getRegionOccupancy()[selectedRegion.id] || 0;
      const status = regionStatusFromOccupancy(occupancy);
      const insideIds = Object.values(state.agents)
        .filter(a => a.region === selectedRegion.id)
        .map(a => a.id);
      const insideSummary = insideIds.length > 8 ? (insideIds.length + ' agents') : insideIds.join(', ');
      selectedPanel.innerHTML =
        '<div class="selected-grid">' +
        '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selectedRegion.id) + '</span>' +
        '<span class="selected-label">TYPE</span><span class="selected-value">region</span>' +
        '<span class="selected-label">OCCUPANCY</span><span class="selected-value">' + occupancy + '</span>' +
        '<span class="selected-label">STATUS</span><span class="selected-value">' + status + '</span>' +
        '<span class="selected-label">INSIDE</span><span class="selected-value">' + escHtml(insideSummary || '—') + '</span>' +
        '<span class="selected-label">LAST EVENT</span><span class="selected-value">' + escHtml(lastEvent) + '</span>' +
        '</div>';
      return;
    }

    const selected = selectedAgent;
    selectedPanel.innerHTML =
      '<div class="selected-grid">' +
      '<span class="selected-label">ID</span><span class="selected-value">' + escHtml(selected.id) + '</span>' +
      '<span class="selected-label">TYPE</span><span class="selected-value">agent</span>' +
      '<span class="selected-label">X</span><span class="selected-value">' + selected.x.toFixed(2) + '</span>' +
      '<span class="selected-label">Y</span><span class="selected-value">' + selected.y.toFixed(2) + '</span>' +
      '<span class="selected-label">STATUS</span><span class="selected-value">' + escHtml(selected.state || (selected.active ? 'active' : 'inactive')) + '</span>' +
      '<span class="selected-label">LAST EVENT</span><span class="selected-value">' + escHtml(lastEvent) + '</span>' +
      '</div>';
  }

  function selectAgent(agentId) {
    selectedAgentId = agentId || null;
    selectedRegionId = null;
    updateLatestSelectedEventFromLog();
    refreshRelatedEventHighlight();
    renderSelectedPanel();
    draw();
  }

  function selectRegion(regionId) {
    selectedRegionId = regionId || null;
    selectedAgentId = null;
    updateLatestSelectedEventFromLog();
    refreshRelatedEventHighlight();
    renderSelectedPanel();
    draw();
  }

  function worldToCanvas(x, y, width, height) {
    return { x: (x / 100) * width, y: (y / 100) * height };
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
        trail.push({ x: nextAgent.x, y: nextAgent.y });
      } else if (prevAgent.x !== nextAgent.x || prevAgent.y !== nextAgent.y) {
        trail.push({ x: nextAgent.x, y: nextAgent.y });
      }

      nextTrails[id] = trail.slice(-TRAIL_MAX_POINTS);
    }

    agentTrails = nextTrails;
  }

  function findNearestAgentAtPoint(mx, my) {
    let nearest = null;
    let nearestDistSq = Infinity;
    for (const a of Object.values(state.agents)) {
      const pt = worldToCanvas(a.x, a.y, canvas.width, canvas.height);
      const dx = mx - pt.x;
      const dy = my - pt.y;
      const distSq = (dx * dx) + (dy * dy);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = a;
      }
    }
    const hitRadiusSq = AGENT_HIT_RADIUS * AGENT_HIT_RADIUS;
    return (nearest && nearestDistSq <= hitRadiusSq)
      ? { agent: nearest, distance: Math.sqrt(nearestDistSq) }
      : { agent: null, distance: null };
  }

  function findRegionAtPoint(mx, my) {
    for (const r of Object.values(state.regions)) {
      const pt = worldToCanvas(r.x, r.y, canvas.width, canvas.height);
      if (mx >= pt.x - 30 && mx <= pt.x + 30 && my >= pt.y - 30 && my <= pt.y + 30) {
        return r;
      }
    }
    return null;
  }

  function getRegionOccupancy() {
    const occupancy = {};
    for (const id of Object.keys(state.regions || {})) occupancy[id] = 0;
    for (const a of Object.values(state.agents || {})) {
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
    document.getElementById('s-tick').textContent    = state.tick;
    document.getElementById('s-agents').textContent  = Object.keys(state.agents).length;
    document.getElementById('s-regions').textContent = Object.keys(state.regions).length;
    if (state.started) {
      const sec = Math.floor((Date.now() - new Date(state.started)) / 1000);
      const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
      document.getElementById('s-uptime').textContent =
        (h ? h+'h ' : '') + (m ? m+'m ' : '') + s+'s';
    }
  }
  setInterval(updateStats, 1000);
  renderSelectedPanel();

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
      pushEvent({ kind: 'system', msg: 'WebSocket connected' });
    };

    ws.onmessage = function (e) {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') {
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
          draw();
        }
      } else if (msg.type === 'event') {
        eventLog.push(msg.data);
        if (eventLog.length > 120) eventLog.shift();
        pushEvent(msg.data);
        if (msg.data.patch) Object.assign(state, msg.data.patch);
        renderSelectedPanel();
        draw();
      }
    };

    ws.onclose = function () {
      statusEl.textContent = 'disconnected';
      statusEl.className = 'disconnected';
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

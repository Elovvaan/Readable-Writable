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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #040913;
      --panel: rgba(6, 16, 28, 0.72);
      --panel-border: rgba(68, 162, 214, 0.33);
      --cyan: #66d9ff;
      --cyan-2: #1fb7ff;
      --orange: #ff9d4d;
      --text: #d8edf8;
      --muted: #6d8fa6;
      --ok: #5cf2b6;
      --warn: #ffb66e;
    }
    body {
      font-family: Consolas, Menlo, Monaco, 'Courier New', monospace;
      color: var(--text);
      height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(1200px 700px at 50% 45%, #07172b 0%, #050b16 55%, #03070f 100%);
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(112, 202, 255, 0.03) 0,
        rgba(112, 202, 255, 0.03) 1px,
        transparent 1px,
        transparent 4px
      );
      mix-blend-mode: screen;
      opacity: 0.32;
    }
    #shell {
      position: relative;
      width: 100%;
      height: 100%;
    }
    #topbar {
      position: absolute;
      top: 12px;
      left: 18px;
      right: 18px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      border: 1px solid var(--panel-border);
      background: rgba(4, 14, 24, 0.64);
      backdrop-filter: blur(6px);
      z-index: 30;
      box-shadow: 0 0 28px rgba(14, 132, 203, 0.18);
    }
    #brand {
      font-size: 16px;
      letter-spacing: 2px;
      color: var(--cyan);
      text-shadow: 0 0 10px rgba(102, 217, 255, 0.55);
      font-weight: 700;
    }
    #status-chip {
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid rgba(92, 242, 182, 0.5);
      color: var(--ok);
      background: rgba(92, 242, 182, 0.08);
      letter-spacing: 1px;
    }
    #status-chip.offline {
      border-color: rgba(255, 125, 110, 0.45);
      color: #ff7d6e;
      background: rgba(255, 125, 110, 0.12);
    }
    #main {
      position: absolute;
      inset: 0;
      padding-top: 70px;
    }
    #globe-stage {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    #globe-wrap {
      width: min(72vw, 980px);
      height: min(72vh, 760px);
      min-width: 420px;
      min-height: 420px;
      position: relative;
      pointer-events: auto;
    }
    #world {
      width: 100%;
      height: 100%;
      display: block;
    }
    .hud-panel {
      position: absolute;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      backdrop-filter: blur(6px);
      box-shadow: 0 0 24px rgba(32, 149, 207, 0.18);
      z-index: 25;
    }
    #layers {
      top: 86px;
      left: 18px;
      width: 250px;
      padding: 10px;
    }
    #layers h3, #tactical h3 {
      font-size: 11px;
      letter-spacing: 2px;
      margin-bottom: 8px;
      color: var(--cyan);
    }
    .layer-row {
      display: grid;
      grid-template-columns: 16px 1fr auto;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      margin: 4px 0;
      color: #b9d4e4;
    }
    .led {
      width: 10px;
      height: 10px;
      border: 1px solid var(--cyan-2);
      background: rgba(31, 183, 255, 0.15);
      box-shadow: 0 0 8px rgba(31, 183, 255, 0.4);
    }
    .count {
      color: var(--orange);
      font-size: 10px;
    }
    #tactical {
      top: 86px;
      right: 18px;
      width: 290px;
      padding: 10px;
    }
    .kv {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin: 4px 0;
      color: #bdd8ea;
    }
    .kv span:first-child { color: var(--muted); }
    #event-strip {
      margin-top: 10px;
      max-height: 190px;
      overflow: auto;
      border-top: 1px solid rgba(110, 172, 210, 0.25);
      padding-top: 8px;
    }
    .ev {
      font-size: 10px;
      color: #b2cde0;
      margin: 3px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ev .t { color: var(--muted); margin-right: 6px; }
    #entity-box {
      margin-top: 8px;
      border-top: 1px solid rgba(110, 172, 210, 0.25);
      padding-top: 8px;
      min-height: 56px;
      font-size: 11px;
    }
    #scope {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      font-size: 10px;
      color: #6fa0bd;
      letter-spacing: 2px;
      z-index: 26;
    }
    body.admin #tactical { width: 340px; }
    body.admin #admin-extra { display: block; }
    #admin-extra {
      display: none;
      border-top: 1px solid rgba(110, 172, 210, 0.25);
      margin-top: 8px;
      padding-top: 8px;
      font-size: 10px;
      color: #9eb9cb;
      line-height: 1.6;
    }
    @media (max-width: 980px) {
      #layers { width: 210px; }
      #tactical { width: 240px; }
      #globe-wrap { width: 92vw; height: 62vh; min-width: 0; min-height: 360px; }
    }
  </style>
</head>
<body>
<div id="shell">
  <div id="topbar">
    <div id="brand">RW WORLDVIEW</div>
    <div id="status-chip">LIVE</div>
  </div>

  <div id="main">
    <div id="globe-stage">
      <div id="globe-wrap"><canvas id="world"></canvas></div>
    </div>

    <div id="layers" class="hud-panel">
      <h3>DATA LAYERS</h3>
      <div id="layer-list"></div>
    </div>

    <div id="tactical" class="hud-panel">
      <h3>TACTICAL</h3>
      <div class="kv"><span>Mode</span><span id="mode-label">APP</span></div>
      <div class="kv"><span>Tick</span><span id="tick">0</span></div>
      <div class="kv"><span>Agents</span><span id="agent-count">0</span></div>
      <div class="kv"><span>Regions</span><span id="region-count">0</span></div>
      <div class="kv"><span>Uptime</span><span id="uptime">0s</span></div>
      <div id="entity-box">No entity selected</div>
      <div id="event-strip"></div>
      <div id="admin-extra">
        Admin overlays enabled<br />
        Control density: elevated<br />
        Tactical diagnostics: active
      </div>
    </div>

    <div id="scope">GLOBE OPERATIONAL SURFACE</div>
  </div>
</div>
<script>
(function () {
  'use strict';

  const IS_ADMIN = location.pathname.indexOf('/admin/') === 0;
  if (IS_ADMIN) document.body.classList.add('admin');

  const canvas  = document.getElementById('world');
  const ctx     = canvas.getContext('2d');
  const statusEl = document.getElementById('status-chip');
  const eventStrip = document.getElementById('event-strip');
  const entityBox = document.getElementById('entity-box');
  const layerList = document.getElementById('layer-list');
  document.getElementById('mode-label').textContent = IS_ADMIN ? 'ADMIN' : 'APP';

  let state = { entities: [], tick: 0, started: null };
  let events = [];
  let selected = null;
  let ws, wsRetryDelay = 1000;
  let rot = 0;

  const layerDefs = [
    { id: 'live', name: 'Live Flights' },
    { id: 'mil', name: 'Military Flights' },
    { id: 'eq', name: 'Earthquakes' },
    { id: 'sat', name: 'Satellites' },
    { id: 'traffic', name: 'Street Traffic' },
    { id: 'weather', name: 'Weather Radar' },
    { id: 'cctv', name: 'CCTV Mesh' },
    { id: 'bike', name: 'Bikeshare' }
  ];

  function resize() {
    const wrap = document.getElementById('globe-wrap');
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
  }
  window.addEventListener('resize', resize);
  resize();

  function project(lat, lng, cx, cy, r, rotDeg) {
    const lr = lat * Math.PI / 180;
    const gr = (lng - rotDeg) * Math.PI / 180;
    const x3 = Math.cos(lr) * Math.sin(gr);
    const y3 = Math.sin(lr);
    const z3 = Math.cos(lr) * Math.cos(gr);
    return { x: cx + r * x3, y: cy - r * y3, z: z3 };
  }

  function drawGraticule(cx, cy, r) {
    ctx.strokeStyle = 'rgba(97, 182, 230, 0.2)';
    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath();
      let started = false;
      for (let lng = -180; lng <= 180; lng += 4) {
        const p = project(lat, lng, cx, cy, r, rot);
        if (p.z > 0) {
          if (!started) { ctx.moveTo(p.x, p.y); started = true; }
          else { ctx.lineTo(p.x, p.y); }
        }
      }
      ctx.stroke();
    }
    for (let lng2 = -150; lng2 <= 180; lng2 += 30) {
      ctx.beginPath();
      let started2 = false;
      for (let lat2 = -85; lat2 <= 85; lat2 += 3) {
        const p2 = project(lat2, lng2, cx, cy, r, rot);
        if (p2.z > 0) {
          if (!started2) { ctx.moveTo(p2.x, p2.y); started2 = true; }
          else { ctx.lineTo(p2.x, p2.y); }
        }
      }
      ctx.stroke();
    }
  }

  function drawOrbitalArcs(cx, cy, r) {
    ctx.strokeStyle = 'rgba(255, 157, 77, 0.24)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const tilt = (state.tick * 0.9 + i * 37) * Math.PI / 180;
      ctx.beginPath();
      for (let a = 0; a <= 360; a += 5) {
        const ang = a * Math.PI / 180;
        const x = cx + Math.cos(ang) * (r * (1.08 + i * 0.03));
        const y = cy + Math.sin(ang + tilt) * (r * (0.36 + i * 0.05));
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function draw() {
    const W = canvas.width;
    const H = canvas.height;
    const cx = W * 0.5;
    const cy = H * 0.52;
    const r = Math.min(W, H) * 0.38;

    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.65);
    bg.addColorStop(0, 'rgba(20, 56, 84, 0.55)');
    bg.addColorStop(1, 'rgba(2, 7, 14, 0.95)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    drawOrbitalArcs(cx, cy, r);

    const sphere = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.34, r * 0.12, cx, cy, r);
    sphere.addColorStop(0, 'rgba(88, 184, 243, 0.85)');
    sphere.addColorStop(0.42, 'rgba(21, 80, 124, 0.87)');
    sphere.addColorStop(1, 'rgba(7, 29, 48, 0.95)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = sphere;
    ctx.fill();
    ctx.strokeStyle = 'rgba(130, 213, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    drawGraticule(cx, cy, r);

    const entities = state.entities || [];
    const points = [];

    for (let j = 0; j < entities.length; j++) {
      const ent = entities[j];
      if (typeof ent.lat !== 'number' || typeof ent.lng !== 'number') continue;
      const p2 = project(ent.lat, ent.lng, cx, cy, r, rot);
      if (p2.z <= 0) continue;
      points.push({ id: ent.id, kind: ent.kind || 'entity', x: p2.x, y: p2.y, z: p2.z, meta: ent });
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 2.3 + p2.z * 1.7, 0, Math.PI * 2);
      ctx.fillStyle = ent.kind === 'satellite'
        ? 'rgba(255, 168, 94, 0.95)'
        : ent.kind === 'region'
          ? 'rgba(255, 220, 120, 0.88)'
          : 'rgba(107, 224, 255, 0.95)';
      ctx.fill();
    }

    if (selected) {
      const found = points.find(function (p3) { return p3.id === selected; });
      if (found) {
        ctx.beginPath();
        ctx.arc(found.x, found.y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 157, 77, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    canvas._points = points;
  }

  function pushEvent(kind, text) {
    const ev = { kind: kind || 'system', text: text || '', ts: new Date().toISOString() };
    events.unshift(ev);
    if (events.length > 48) events.pop();
    renderEvents();
  }

  function renderEvents() {
    eventStrip.innerHTML = events.slice(0, (IS_ADMIN ? 18 : 12)).map(function (e) {
      return '<div class="ev"><span class="t">' + e.ts.slice(11, 19) + '</span>' + e.text + '</div>';
    }).join('');
  }

  function renderLayers() {
    const entities = state.entities || [];
    const satCount = entities.filter(function (e) { return e.kind === 'satellite'; }).length;
    const flightCount = entities.filter(function (e) { return e.kind === 'flight'; }).length;
    const counts = [
      Math.max(3, flightCount),
      Math.max(1, Math.floor(flightCount * 0.25)),
      Math.max(2, (state.tick % 7) + 1),
      Math.max(4, satCount),
      Math.max(5, (state.tick % 13) + 6),
      Math.max(1, (state.tick % 5) + 1),
      Math.max(2, (state.tick % 8) + 2),
      Math.max(3, (state.tick % 9) + 3)
    ];
    layerList.innerHTML = layerDefs.map(function (l, i) {
      return '<div class="layer-row"><div class="led"></div><div>' + l.name + '</div><div class="count">' + counts[i] + '</div></div>';
    }).join('');
  }

  function updateStats() {
    var agents = (state.entities || []).filter(function (e) { return e.kind === 'agent'; }).length;
    var regions = (state.entities || []).filter(function (e) { return e.kind === 'region'; }).length;
    document.getElementById('tick').textContent = String(state.tick || 0);
    document.getElementById('agent-count').textContent = String(agents);
    document.getElementById('region-count').textContent = String(regions);
    if (state.started) {
      var sec = Math.floor((Date.now() - new Date(state.started)) / 1000);
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var s = sec % 60;
      document.getElementById('uptime').textContent = (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
    }
    renderLayers();
  }
  setInterval(updateStats, 1000);

  function renderEntityBox() {
    if (!selected) {
      entityBox.textContent = 'No entity selected';
      return;
    }
    const ent = (state.entities || []).find(function (e) { return e.id === selected; });
    if (ent) {
      entityBox.innerHTML =
        'Entity: ' + ent.id +
        '<br/>Kind: ' + (ent.kind || 'entity') +
        '<br/>Lat/Lng: ' + ent.lat.toFixed(2) + ', ' + ent.lng.toFixed(2);
      return;
    }
    entityBox.textContent = 'Entity not in current frame';
  }

  canvas.addEventListener('click', function (e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const points = canvas._points || [];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - x;
      const dy = points[i].y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 10 && d < bestD) { best = points[i]; bestD = d; }
    }
    selected = best ? best.id : null;
    renderEntityBox();
    draw();
  });

  function animate() {
    rot = (rot + 0.08) % 360;
    draw();
    requestAnimationFrame(animate);
  }

  async function fetchWorldview() {
    try {
      const res = await fetch('/rw/worldview/world', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      state = {
        entities: Array.isArray(data.entities) ? data.entities : [],
        tick: data.tick || 0,
        started: data.started || state.started
      };
      updateStats();
      renderEntityBox();
    } catch (_) {}
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = function () {
      statusEl.textContent = 'CONNECTED';
      statusEl.className = '';
      wsRetryDelay = 1000;
      pushEvent('system', 'WebSocket connected');
    };

    ws.onmessage = function (e) {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') {
        fetchWorldview();
      } else if (msg.type === 'event') {
        pushEvent(msg.data.kind || 'system', msg.data.msg || JSON.stringify(msg.data));
        fetchWorldview();
      }
    };

    ws.onclose = function () {
      statusEl.textContent = 'OFFLINE';
      statusEl.className = 'offline';
      pushEvent('system', 'WebSocket disconnected, retrying in ' + (wsRetryDelay / 1000) + 's');
      setTimeout(connect, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 16000);
    };

    ws.onerror = function () { ws.close(); };
  }

  function initWorldview() {
    console.log('WORLDVIEW MODE ACTIVE');
    fetchWorldview();
    setInterval(fetchWorldview, 3000);
    updateStats();
    renderLayers();
    renderEntityBox();
    animate();
    connect();
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

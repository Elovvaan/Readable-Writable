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
    /* ── NEW WORLDVIEW RENDERER — hard reset, no legacy code ── */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      overflow: hidden;
      background: #03070f;
      font-family: Consolas, 'Courier New', monospace;
    }
    #globe {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    /* HUD overlays — purely fixed-position, no panels */
    #hud-title {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 15px;
      letter-spacing: 4px;
      font-weight: 700;
      color: #66d9ff;
      text-shadow: 0 0 14px rgba(102, 217, 255, 0.65);
      pointer-events: none;
      z-index: 10;
    }
    #hud-status {
      position: fixed;
      top: 18px;
      right: 22px;
      font-size: 10px;
      letter-spacing: 2px;
      color: #5cf2b6;
      pointer-events: none;
      z-index: 10;
    }
    #hud-status.offline { color: #ff7d6e; }
    #hud-tick {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      letter-spacing: 3px;
      color: #3a6a84;
      pointer-events: none;
      z-index: 10;
    }
    #hud-entities {
      position: fixed;
      bottom: 36px;
      right: 22px;
      font-size: 10px;
      letter-spacing: 1px;
      color: #3a6a84;
      pointer-events: none;
      z-index: 10;
    }
  </style>
</head>
<body>
  <canvas id="globe"></canvas>
  <div id="hud-title">RW WORLDVIEW</div>
  <div id="hud-status">CONNECTING</div>
  <div id="hud-tick">TICK 0</div>
  <div id="hud-entities">ENTITIES 0</div>
<script>
(function () {
  'use strict';

  console.log("NEW WORLDVIEW RENDERER ACTIVE");

  /* ── Canvas setup ── */
  var canvas = document.getElementById('globe');
  var ctx = canvas.getContext('2d');
  var statusEl = document.getElementById('hud-status');
  var tickEl = document.getElementById('hud-tick');
  var entEl = document.getElementById('hud-entities');

  /* ── State ── */
  var state = { entities: [], tick: 0, started: null };
  var rot = 0;           // current rotation degrees
  var ws, wsDelay = 1000;
  var hits = [];         // clickable entity positions this frame

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  /* ── Spherical projection ──
     Converts geographic lat/lng to canvas x,y using orthographic projection.
     z > 0 = visible (facing viewer), z <= 0 = on far side of globe.
  */
  function project(lat, lng, cx, cy, r) {
    var la = lat  * Math.PI / 180;
    var lo = (lng - rot) * Math.PI / 180;
    var x3 = Math.cos(la) * Math.sin(lo);
    var y3 = Math.sin(la);
    var z3 = Math.cos(la) * Math.cos(lo);
    return { x: cx + r * x3, y: cy - r * y3, z: z3 };
  }

  /* ── Draw one animation frame ── */
  function drawFrame() {
    var W  = canvas.width;
    var H  = canvas.height;
    var cx = W * 0.5;
    var cy = H * 0.5;
    var r  = Math.min(W, H) * 0.40;

    /* Deep space background */
    ctx.fillStyle = '#03070f';
    ctx.fillRect(0, 0, W, H);

    /* Subtle atmospheric halo behind globe */
    var halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.28);
    halo.addColorStop(0, 'rgba(40, 120, 200, 0.18)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    /* Globe sphere — radial gradient gives 3-D depth */
    var globe = ctx.createRadialGradient(
      cx - r * 0.28, cy - r * 0.28, r * 0.04,
      cx, cy, r
    );
    globe.addColorStop(0,    'rgba(110, 200, 255, 0.92)');
    globe.addColorStop(0.25, 'rgba(35,  100, 170, 0.90)');
    globe.addColorStop(0.72, 'rgba(12,  45,  85,  0.93)');
    globe.addColorStop(1,    'rgba(5,   18,  38,  0.97)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = globe;
    ctx.fill();

    /* Crisp limb edge */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(102, 217, 255, 0.38)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    /* Latitude parallels — drawn as curved arcs on sphere surface */
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(70, 150, 210, 0.18)';
    var parallels = [-60, -30, 0, 30, 60];
    for (var pi = 0; pi < parallels.length; pi++) {
      var latP = parallels[pi];
      ctx.beginPath();
      var pmoved = false;
      for (var lng = -180; lng <= 180; lng += 3) {
        var pp = project(latP, lng, cx, cy, r);
        if (pp.z > 0) {
          if (!pmoved) { ctx.moveTo(pp.x, pp.y); pmoved = true; }
          else          { ctx.lineTo(pp.x, pp.y); }
        } else { pmoved = false; }
      }
      /* equator slightly brighter */
      ctx.strokeStyle = latP === 0
        ? 'rgba(102, 200, 255, 0.28)'
        : 'rgba(70, 150, 210, 0.15)';
      ctx.stroke();
    }

    /* Longitude meridians */
    ctx.strokeStyle = 'rgba(70, 150, 210, 0.14)';
    for (var lm = -150; lm <= 180; lm += 30) {
      ctx.beginPath();
      var mmoved = false;
      for (var lat = -88; lat <= 88; lat += 3) {
        var mp = project(lat, lm, cx, cy, r);
        if (mp.z > 0) {
          if (!mmoved) { ctx.moveTo(mp.x, mp.y); mmoved = true; }
          else          { ctx.lineTo(mp.x, mp.y); }
        } else { mmoved = false; }
      }
      ctx.stroke();
    }

    /* Entities on globe surface — lat/lng positioned dots */
    var entities = state.entities || [];
    hits = [];
    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      if (typeof ent.lat !== 'number' || typeof ent.lng !== 'number') continue;
      var ep = project(ent.lat, ent.lng, cx, cy, r);
      if (ep.z <= 0.04) continue;   /* on far side — skip */

      var dotR = 1.8 + ep.z * 2.8;
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = ent.kind === 'satellite'
        ? 'rgba(255, 168, 80, 0.95)'
        : ent.kind === 'region'
          ? 'rgba(255, 220, 100, 0.90)'
          : 'rgba(100, 220, 255, 0.95)';
      ctx.fill();

      /* faint pulse ring */
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, dotR + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.18)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      hits.push({ id: ent.id, x: ep.x, y: ep.y, meta: ent });
    }
  }

  /* ── Animation loop ── */
  function tick() {
    rot = (rot + 0.055) % 360;
    drawFrame();
    tickEl.textContent = 'TICK ' + (state.tick || 0);
    entEl.textContent  = 'ENTITIES ' + (state.entities ? state.entities.length : 0);
    requestAnimationFrame(tick);
  }

  /* ── Data fetch ── */
  async function fetchWorldview() {
    try {
      var res = await fetch('/rw/worldview/world', { cache: 'no-store' });
      if (!res.ok) return;
      var data = await res.json();
      state = {
        entities: Array.isArray(data.entities) ? data.entities : [],
        tick:     data.tick    || 0,
        started:  data.started || state.started
      };
    } catch (_) { /* keep last state */ }
  }

  /* ── WebSocket ── */
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = function () {
      statusEl.textContent = 'LIVE';
      statusEl.className   = '';
      wsDelay = 1000;
    };

    ws.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg && msg.type) fetchWorldview();
      } catch (_) {}
    };

    ws.onclose = function () {
      statusEl.textContent = 'OFFLINE';
      statusEl.className   = 'offline';
      setTimeout(connect, wsDelay);
      wsDelay = Math.min(wsDelay * 2, 16000);
    };

    ws.onerror = function () { ws.close(); };
  }

  /* ── Entry point ── */
  function initWorldview() {
    console.log("NEW WORLDVIEW RENDERER ACTIVE");
    fetchWorldview();
    setInterval(fetchWorldview, 3000);
    connect();
    requestAnimationFrame(tick);
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

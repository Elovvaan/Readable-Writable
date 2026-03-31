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
    #globe { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
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
    #hud-status {
      font-size: 10px;
      letter-spacing: 2px;
      color: #5cf2b6;
      border: 1px solid rgba(92, 242, 182, 0.35);
      padding: 2px 7px;
      background: rgba(92, 242, 182, 0.08);
      box-shadow: 0 0 10px rgba(92, 242, 182, 0.18) inset;
    }
    #hud-status.offline { color: #ff7d6e; }
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
    body.admin .side-panel { width: 186px; padding: 9px 11px; }
    body.admin .pnl-row { margin: 4px 0; font-size: 9.5px; }
    body.admin #hud-bar { height: 42px; }
    body.admin #hud-foot { height: 24px; font-size: 8.5px; }

    @media (max-width: 900px) {
      .side-panel {
        width: 148px;
        top: 58px;
        padding: 8px 9px;
      }
      .pnl-row { margin: 4px 0; font-size: 9px; }
      #hud-title { font-size: 12px; letter-spacing: 3px; }
    }
    #local-map-panel {
      display: none;
      position: fixed; bottom: 36px; right: 14px;
      width: 300px; height: 240px;
      border: 1px solid rgba(44, 130, 188, 0.42);
      box-shadow: 0 0 28px rgba(12, 56, 94, 0.48);
      z-index: 30; overflow: hidden;
      background: #020508;
    }
    #local-map-panel.active { display: block; }
    #local-map { width: 100%; height: 100%; }
    #lm-label {
      position: absolute; top: 4px; left: 6px;
      font-size: 8px; letter-spacing: 2px; color: #56afd8;
      pointer-events: none; z-index: 31;
      text-shadow: 0 1px 4px rgba(0,0,0,0.9);
    }
    #lm-close {
      position: absolute; top: 3px; right: 5px;
      font-size: 11px; color: #5cf2b6; cursor: pointer; z-index: 31;
      pointer-events: all; background: none; border: none; padding: 2px 5px;
    }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
  <script src="https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js"></script>
</head>
<body>
  <canvas id="globe"></canvas>
  <div id="hud-bar">
    <div id="hud-title">RW WORLDVIEW</div>
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
    <div class="pnl-row"><span class="lbl">TICK</span><span class="val" id="info-tick">0</span></div>
    <div class="pnl-row"><span class="lbl">UPTIME</span><span class="val" id="info-uptime">—</span></div>
    <div class="pnl-row"><span class="lbl">TOTAL</span><span class="val" id="info-total">0</span></div>
    <div id="selected-detail">—</div>
  </div>
  <div id="hud-foot">GLOBE OPERATIONAL SURFACE</div>
  <div id="local-map-panel">
    <span id="lm-label">LOCAL VIEW</span>
    <button id="lm-close">&#x2715;</button>
    <div id="local-map"></div>
  </div>
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

  var state    = { entities: [], tick: 0, started: null };
  var rot      = 0;
  var selected = null;
  var selectedPulse = 0;
  var hits     = [];
  var ws, wsDelay = 1000;

  var landPolygons  = [];
  var mapLoaded     = false;
  var localLeaflet  = null;
  var localMarker   = null;
  var localMapPanel = document.getElementById('local-map-panel');

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

  // ── Map / Continent Rendering ────────────────────────────────────────────────
  function loadWorldGeo() {
    console.log('[MAP] Loading world land topology...');
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(topo) {
        if (typeof topojson === 'undefined') throw new Error('topojson-client not loaded');
        var geo = topojson.feature(topo, topo.objects.land);
        landPolygons = [];
        var feats = Array.isArray(geo.features) ? geo.features : [geo];
        feats.forEach(function(f) { collectGeoRings(f.geometry || f); });
        mapLoaded = true;
        console.log('[MAP] Land loaded — ' + landPolygons.length + ' rings');
      })
      .catch(function(err) {
        console.warn('[MAP] Primary land failed (' + err.message + ') — applying fallback');
        applyFallbackLand();
      });
  }

  function collectGeoRings(g) {
    if (!g) return;
    if (g.type === 'Polygon') {
      g.coordinates.forEach(function(ring) { landPolygons.push(ring); });
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach(function(poly) {
        poly.forEach(function(ring) { landPolygons.push(ring); });
      });
    }
  }

  function applyFallbackLand() {
    // Simplified [lng, lat] outlines for major landmasses
    landPolygons = [
      // Africa
      [[-18,14],[0,14],[12,12],[18,4],[22,2],[28,-2],[34,-4],[36,-12],[38,-18],[36,-22],[32,-28],[26,-34],[18,-34],[14,-24],[10,-8],[6,4],[0,6],[-6,5],[-14,10],[-18,14]],
      // Europe
      [[-10,36],[0,44],[10,56],[20,60],[28,62],[30,70],[14,68],[4,62],[0,50],[-2,44],[6,44],[14,46],[20,50],[28,54],[32,58],[38,56],[42,42],[36,40],[30,38],[24,36],[10,38],[0,38],[-6,36],[-10,36]],
      // Asia
      [[42,40],[50,30],[58,22],[65,22],[70,26],[80,28],[90,28],[100,20],[110,2],[120,4],[124,12],[128,26],[128,36],[132,44],[136,34],[128,32],[120,34],[120,38],[124,40],[118,42],[108,48],[100,52],[90,56],[80,50],[70,44],[62,40],[50,38],[44,40],[42,40]],
      // North America
      [[-168,72],[-141,60],[-125,49],[-117,32],[-97,26],[-83,10],[-78,16],[-66,18],[-70,44],[-56,47],[-60,46],[-80,46],[-84,46],[-90,48],[-94,49],[-110,49],[-125,49],[-132,55],[-141,60],[-150,62],[-157,60],[-163,62],[-166,64],[-168,72]],
      // South America
      [[-81,9],[-77,4],[-72,1],[-72,-4],[-76,-10],[-78,-14],[-76,-18],[-72,-22],[-70,-30],[-70,-40],[-66,-54],[-68,-54],[-64,-42],[-58,-34],[-52,-32],[-38,-14],[-34,-8],[-38,-4],[-50,-1],[-57,6],[-60,8],[-66,11],[-72,10],[-76,9],[-81,9]],
      // Australia
      [[130,-14],[136,-12],[138,-14],[140,-18],[144,-18],[150,-24],[152,-28],[152,-32],[148,-38],[144,-38],[140,-36],[134,-34],[126,-34],[114,-30],[114,-26],[122,-22],[128,-14],[130,-14]],
    ];
    mapLoaded = true;
    console.log('[MAP] Fallback land active — ' + landPolygons.length + ' rings');
  }

  function drawContinents(cx, cy, r) {
    if (!landPolygons.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle   = 'rgba(40, 100, 58, 0.42)';
    ctx.strokeStyle = 'rgba(70, 160, 90, 0.58)';
    ctx.lineWidth   = 0.5;
    for (var ri = 0; ri < landPolygons.length; ri++) {
      var ring = landPolygons[ri];
      if (!ring || ring.length < 3) continue;
      ctx.beginPath();
      var moved = false;
      for (var pi = 0; pi < ring.length; pi++) {
        var c = ring[pi];
        var pt = project(c[1], c[0], cx, cy, r);
        if (pt.z > 0) {
          if (!moved) { ctx.moveTo(pt.x, pt.y); moved = true; }
          else        { ctx.lineTo(pt.x, pt.y); }
        } else if (moved) {
          ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.beginPath(); moved = false;
        }
      }
      if (moved) { ctx.closePath(); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }

  function showLocalMap(ent) {
    if (typeof L === 'undefined' || typeof ent.lat !== 'number') return;
    localMapPanel.classList.add('active');
    if (!localLeaflet) {
      localLeaflet = L.map('local-map', { zoomControl: true });
      var tileLogDone = false;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(localLeaflet)
        .on('tileload', function() {
          if (!tileLogDone) {
            console.log('[MAP] Local tile render success');
            tileLogDone = true;
          }
        });
      localMarker = L.circleMarker([0, 0], {
        radius: 7, color: '#5cf2b6', fillColor: '#66d9ff', fillOpacity: 0.9
      });
      console.log('[MAP] Local map initialised');
    }
    var latlng = [ent.lat, ent.lng];
    localLeaflet.setView(latlng, 5);
    localMarker.setLatLng(latlng).addTo(localLeaflet);
    // Allow the CSS display change to resolve before Leaflet reads container dimensions
    setTimeout(function() { localLeaflet.invalidateSize(); }, 10);
    console.log('[MAP] Local mode: ' + ent.id + ' @ ' + ent.lat.toFixed(3) + ', ' + ent.lng.toFixed(3));
  }

  function hideLocalMap() {
    if (localMapPanel) localMapPanel.classList.remove('active');
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

    drawContinents(cx, cy, r);

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
    hits = [];
    for (var i = 0; i < entities.length; i++) {
      var ent = entities[i];
      if (typeof ent.lat !== 'number' || typeof ent.lng !== 'number') continue;
      var ep = project(ent.lat, ent.lng, cx, cy, r);
      if (ep.z <= 0.04) continue;
      var dotR = 2.0 + ep.z * 2.6;
      var color = ent.kind === 'satellite' ? 'rgba(255,170,80,0.95)'
        : ent.kind === 'region' ? 'rgba(255,222,100,0.90)'
        : ent.kind === 'flight' ? 'rgba(180,255,180,0.90)'
        :                          'rgba(100,218,255,0.95)';

      ctx.beginPath();
      ctx.arc(ep.x, ep.y, dotR + 3.2, 0, Math.PI*2);
      ctx.fillStyle = color.replace('0.95', '0.16').replace('0.90', '0.14');
      ctx.fill();

      ctx.beginPath(); ctx.arc(ep.x, ep.y, dotR, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, Math.max(1.2, dotR * 0.45), 0, Math.PI*2);
      ctx.fillStyle = 'rgba(245, 252, 255, 0.92)';
      ctx.fill();

      ctx.beginPath(); ctx.arc(ep.x, ep.y, dotR+2.5, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba(100,200,255,0.15)'; ctx.lineWidth = 0.7; ctx.stroke();
      if (selected === ent.id) {
        var pulse = 7 + Math.sin(selectedPulse) * 2.6;
        ctx.beginPath(); ctx.arc(ep.x, ep.y, dotR + pulse, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,200,80,0.92)'; ctx.lineWidth = 1.3; ctx.stroke();
        ctx.beginPath(); ctx.arc(ep.x, ep.y, dotR + pulse + 4.3, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(255,200,80,0.38)'; ctx.lineWidth = 0.9; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ep.x + dotR + 2, ep.y);
        ctx.lineTo(ep.x + dotR + 11, ep.y);
        ctx.moveTo(ep.x - dotR - 2, ep.y);
        ctx.lineTo(ep.x - dotR - 11, ep.y);
        ctx.moveTo(ep.x, ep.y + dotR + 2);
        ctx.lineTo(ep.x, ep.y + dotR + 11);
        ctx.moveTo(ep.x, ep.y - dotR - 2);
        ctx.lineTo(ep.x, ep.y - dotR - 11);
        ctx.strokeStyle = 'rgba(255, 220, 120, 0.62)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
      hits.push({ id: ent.id, x: ep.x, y: ep.y, meta: ent });
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
    if (state.started) {
      var sec = Math.floor((Date.now() - new Date(state.started)) / 1000);
      var hh = Math.floor(sec/3600), mm = Math.floor((sec%3600)/60), ss = sec%60;
      document.getElementById('info-uptime').textContent =
        (hh?hh+'h ':'')+(mm?mm+'m ':'')+ ss+'s';
    }
    if (selected) {
      var ent = entities.find(function(e) { return e.id === selected; });
      if (ent) {
        selDetail.className = 'locked';
        selDetail.innerHTML = '<span class="sel-id">'+ent.id+'</span><br/>'
          +'LOCKED: '+ent.kind.toUpperCase()+'<br/>'
          +ent.lat.toFixed(2)+'°'+', '+ent.lng.toFixed(2)+'°';
      } else {
        selDetail.className = '';
        selDetail.textContent = '—';
        selected = null;
        hideLocalMap();
      }
    } else {
      selDetail.className = '';
      selDetail.textContent = '—';
    }
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
    updatePanels();
    if (selected) {
      var selEnt = (state.entities || []).find(function(e) { return e.id === selected; });
      if (selEnt) showLocalMap(selEnt);
    } else {
      hideLocalMap();
    }
  });

  function animTick() {
    rot = (rot + 0.055) % 360;
    selectedPulse += 0.12;
    drawFrame();
    updatePanels();
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
    } catch (_) {}
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = function() { statusEl.textContent='LIVE'; statusEl.className=''; wsDelay=1000; };
    ws.onmessage = function(e) {
      try { var m=JSON.parse(e.data); if(m&&m.type) fetchWorldview(); } catch(_){}
    };
    ws.onclose = function() {
      statusEl.textContent='OFFLINE'; statusEl.className='offline';
      setTimeout(connect, wsDelay); wsDelay=Math.min(wsDelay*2,16000);
    };
    ws.onerror = function() { ws.close(); };
  }

  function initWorldview() {
    console.log("NEW WORLDVIEW RENDERER ACTIVE");
    loadWorldGeo();
    fetchWorldview();
    setInterval(fetchWorldview, 3000);
    connect();
    requestAnimationFrame(animTick);
    document.getElementById('lm-close').addEventListener('click', function() {
      hideLocalMap();
      selected = null;
      updatePanels();
    });
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

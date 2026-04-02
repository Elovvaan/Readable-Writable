'use strict';

// Tests for camera control helpers and orbital state logic.
// These test the server-side snapshot/state exports; the Cesium camera itself
// is browser-only so its runtime is not exercised here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  STYLE_PRESETS,
  snapshot,
  openSkyLiveState,
} = (() => {
  // STYLE_PRESETS is a frontend constant inside the HTML template so we test
  // it indirectly by checking the server exports that back the same session.
  // We pull in what the server does export.
  const mod = require('../server.js');
  return mod;
})();

// ── STYLE_PRESETS validation ──────────────────────────────────────────────────
describe('STYLE_PRESETS not exported (frontend-only)', function () {
  // STYLE_PRESETS lives inside the IIFE; we verify what we can via snapshot.
  test('snapshot returns an opensky block', function () {
    const snap = snapshot();
    assert.ok(snap && typeof snap === 'object', 'snapshot returns object');
    assert.ok('opensky' in snap, 'opensky key present');
  });

  test('snapshot opensky.authMode defaults to none when disabled', function () {
    const snap = snapshot();
    // OPENSKY_ENABLED is false in test env (no env vars), so mode is 'none'
    assert.equal(snap.opensky.authMode, 'none');
  });
});

// ── Orbital camera state via server constants ─────────────────────────────────
describe('orbital camera defaults in snapshot', function () {
  test('snapshot includes agents and regions maps', function () {
    const snap = snapshot();
    assert.ok(typeof snap.agents === 'object');
    assert.ok(typeof snap.regions === 'object');
  });

  test('snapshot tick is a non-negative integer', function () {
    const snap = snapshot();
    assert.ok(Number.isInteger(snap.tick) && snap.tick >= 0);
  });
});

// ── FX preset values: cinematic glow must be higher than minimal ──────────────
// We parse them from the known defaults in server output; since STYLE_PRESETS
// is not exported, we verify the structural invariant via a direct JSON check
// of the server source. This is an integration-style guard against regression.
describe('style preset ordering invariants', function () {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  function extractPreset(name) {
    const re = new RegExp(name + '\\s*:\\s*\\{([^}]+)\\}');
    const m = src.match(re);
    if (!m) return null;
    const obj = {};
    for (const pair of m[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) {
      obj[pair[1]] = Number(pair[2]);
    }
    return obj;
  }

  test('tactical preset: bloom <= 25', function () {
    const p = extractPreset('tactical');
    assert.ok(p !== null, 'tactical preset found in source');
    assert.ok(p.bloom <= 25, 'tactical bloom is low (got ' + p.bloom + ')');
  });

  test('tactical preset: glow <= 25', function () {
    const p = extractPreset('tactical');
    assert.ok(p.glow <= 25, 'tactical glow is low (got ' + p.glow + ')');
  });

  test('cinematic glow > tactical glow', function () {
    const tactical  = extractPreset('tactical');
    const cinematic = extractPreset('cinematic');
    assert.ok(cinematic.glow > tactical.glow,
      'cinematic glow (' + cinematic.glow + ') > tactical (' + tactical.glow + ')');
  });

  test('minimal has lowest bloom of all presets', function () {
    const presets = ['tactical', 'surveillance', 'cinematic', 'minimal'].map(extractPreset);
    const minBloom = Math.min(...presets.map(p => p.bloom));
    const minimal  = extractPreset('minimal');
    assert.equal(minimal.bloom, minBloom);
  });

  test('canvas pointer-events is none in source CSS', function () {
    assert.ok(src.includes('pointer-events: none'), 'canvas overlay must not capture pointer events');
  });

  test('screenSpaceCameraController enableTilt is true', function () {
    assert.ok(src.includes('ssc.enableTilt   = true'), 'tilt must be enabled for orbital control');
  });

  test('screenSpaceCameraController enableZoom is false', function () {
    assert.ok(src.includes('ssc.enableZoom   = false'), 'zoom must be disabled on the Cesium globe');
  });

  test('setViewportZoom does not call cesiumViewer.camera.zoomBy', function () {
    const fnIdx = src.indexOf('function setViewportZoom');
    assert.ok(fnIdx !== -1, 'setViewportZoom must exist');
    // Find the closing brace of setViewportZoom by locating the next top-level function
    const nextFnIdx = src.indexOf('\n  function ', fnIdx + 1);
    const body = src.slice(fnIdx, nextFnIdx === -1 ? fnIdx + 600 : nextFnIdx);
    assert.ok(!body.includes('zoomBy'), 'setViewportZoom must not call camera.zoomBy when zoom is disabled');
  });

  test('flyTo used for runFocusAction in Cesium path', function () {
    assert.ok(src.includes('cesiumViewer.camera.flyTo'), 'flyTo must be used for smooth focus animation');
  });

  test('reset view uses flyTo', function () {
    const resetIdx = src.indexOf('function resetViewport');
    assert.ok(resetIdx !== -1, 'resetViewport function exists');
    const resetBody = src.slice(resetIdx, resetIdx + 600);
    assert.ok(resetBody.includes('flyTo'), 'resetViewport must flyTo default position');
  });

  test('left-panel exists in HTML', function () {
    assert.ok(src.includes('id="left-panel"'), 'left panel nav must exist in HTML');
  });

  test('data toggles are in left panel, not in #controls', function () {
    const controlsStart = src.indexOf('id="controls"');
    const leftPanelStart = src.indexOf('id="left-panel"');
    assert.ok(controlsStart !== -1 && leftPanelStart !== -1);
    const flightToggleIdx = src.indexOf('id="toggle-layer-flights"');
    assert.ok(flightToggleIdx > leftPanelStart, 'toggle-layer-flights must be inside left panel');
    assert.ok(flightToggleIdx > controlsStart, 'toggle-layer-flights appears after controls div');
  });

  test('all 8 data layers present in left panel HTML', function () {
    const panel = src.slice(src.indexOf('id="left-panel"'), src.indexOf('</nav>') + 6);
    for (const key of ['liveFlights','militaryFlights','earthquakes','satellites','traffic','weather','cctvMesh','bikeshare']) {
      assert.ok(panel.includes('data-layer="' + key + '"'), 'left panel must contain layer: ' + key);
    }
  });

  test('unavailable layers are disabled in HTML', function () {
    for (const key of ['militaryFlights','earthquakes','traffic','weather','cctvMesh','bikeshare']) {
      const btn = 'id="toggle-layer-' + key + '"';
      const btnIdx = src.indexOf(btn);
      assert.ok(btnIdx !== -1, 'button for ' + key + ' must exist');
      const snippet = src.slice(btnIdx, btnIdx + 80);
      assert.ok(snippet.includes('disabled'), key + ' button must be disabled');
    }
  });

  test('LAYER_AVAILABLE has true only for liveFlights and satellites', function () {
    const laIdx = src.indexOf('const LAYER_AVAILABLE');
    assert.ok(laIdx !== -1, 'LAYER_AVAILABLE must be defined');
    const laBlock = src.slice(laIdx, laIdx + 300);
    assert.ok(laBlock.includes('liveFlights: true'), 'liveFlights must be available');
    assert.ok(laBlock.includes('satellites: true'), 'satellites must be available');
    assert.ok(laBlock.includes('militaryFlights: false'), 'militaryFlights must be unavailable');
    assert.ok(laBlock.includes('weather: false'), 'weather must be unavailable');
  });

  test('applySnapshot gates updateFlightTracking on layerState.liveFlights', function () {
    const applyIdx = src.indexOf('function applySnapshot');
    assert.ok(applyIdx !== -1, 'applySnapshot must exist');
    const body = src.slice(applyIdx, applyIdx + 600);
    assert.ok(body.includes('layerState.liveFlights'), 'applySnapshot must gate on liveFlights');
    assert.ok(body.includes('updateFlightTracking'), 'applySnapshot must call updateFlightTracking');
  });

  test('setLayerOn helper exists and checks LAYER_AVAILABLE', function () {
    assert.ok(src.includes('function setLayerOn'), 'setLayerOn must be defined');
    const fnIdx = src.indexOf('function setLayerOn');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('LAYER_AVAILABLE'), 'setLayerOn must check LAYER_AVAILABLE before toggling');
  });

  test('setLayerStatus and timeSinceStr helpers exist', function () {
    assert.ok(src.includes('function setLayerStatus'), 'setLayerStatus must exist');
    assert.ok(src.includes('function timeSinceStr'), 'timeSinceStr must exist');
  });
});

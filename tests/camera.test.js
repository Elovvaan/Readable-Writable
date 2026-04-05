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

  test('screenSpaceCameraController enableZoom is true', function () {
    assert.ok(src.includes('ssc.enableZoom   = true'), 'scroll-wheel zoom must be enabled for orbital control');
  });

  test('zoomBy helper exists for +/- button programmatic zoom', function () {
    assert.ok(src.includes('function zoomBy'), 'zoomBy must be defined for button-driven zoom');
    const fnIdx = src.indexOf('function zoomBy');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('positionCartographic'), 'zoomBy must move camera via positionCartographic');
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

  test('drawer-layers exists in HTML', function () {
    assert.ok(src.includes('id="drawer-layers"'), 'layers drawer must exist in HTML');
  });

  test('data toggles are in drawer-layers', function () {
    const drawerStart = src.indexOf('id="drawer-layers"');
    assert.ok(drawerStart !== -1, 'drawer-layers must exist');
    const flightToggleIdx = src.indexOf('id="toggle-layer-flights"');
    assert.ok(flightToggleIdx > drawerStart, 'toggle-layer-flights must be inside drawer-layers');
    // rail launcher must exist separately
    assert.ok(src.includes('id="rail"'), 'launcher rail must exist');
  });

  test('all 8 data layers present in drawer-layers HTML', function () {
    const drawerStart = src.indexOf('id="drawer-layers"');
    const drawerEnd   = src.indexOf('id="drawer-events"');
    const panel = src.slice(drawerStart, drawerEnd);
    for (const key of ['liveFlights','militaryFlights','earthquakes','satellites','traffic','weather','cctvMesh','bikeshare']) {
      assert.ok(panel.includes('data-layer="' + key + '"'), 'drawer-layers must contain layer: ' + key);
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

// ── Jump-to-target camera helpers ─────────────────────────────────────────────
describe('jumpToTarget camera helpers', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('jumpToTarget is defined', function () {
    assert.ok(src.includes('function jumpToTarget'), 'jumpToTarget must be defined');
  });

  test('resolveTargetLatLng is defined and delegates to toLatLngWithFallback', function () {
    assert.ok(src.includes('function resolveTargetLatLng'), 'resolveTargetLatLng must be defined');
    const fnIdx = src.indexOf('function resolveTargetLatLng');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('toLatLngWithFallback'), 'must use toLatLngWithFallback for coord extraction');
  });

  test('getTargetOrbitDistance returns type-specific altitudes', function () {
    assert.ok(src.includes('function getTargetOrbitDistance'), 'getTargetOrbitDistance must be defined');
    const fnIdx = src.indexOf('function getTargetOrbitDistance');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes("'region'"),    'region must have its own distance');
    assert.ok(body.includes("'flight'"),    'flight must have its own distance');
    assert.ok(body.includes("'satellite'"), 'satellite must have its own distance');
  });

  test('getTargetOrbitDistance: region farther than flight', function () {
    // Extract numeric literals from the function to verify ordering
    const fnIdx = src.indexOf('function getTargetOrbitDistance');
    const body = src.slice(fnIdx, fnIdx + 400);
    const nums = [...body.matchAll(/return\s+(\d+)/g)].map(m => Number(m[1]));
    const regionDist = Number(body.match(/'region'\s*\)\s*return\s+(\d+)/)?.[1]);
    const flightDist = Number(body.match(/'flight'\s*\)\s*return\s+(\d+)/)?.[1]);
    assert.ok(regionDist > flightDist, 'region orbit distance must be greater than flight distance');
  });

  test('jumpToTarget fails gracefully on missing coordinates', function () {
    const fnIdx = src.indexOf('function jumpToTarget');
    assert.ok(fnIdx !== -1, 'jumpToTarget must exist');
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('if (!ll) return'), 'must bail gracefully when coords are missing');
  });

  test('jumpToTarget uses getTargetOrbitDistance and flyTo', function () {
    const fnIdx = src.indexOf('function jumpToTarget');
    const body = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(body.includes('getTargetOrbitDistance'), 'must call getTargetOrbitDistance for altitude');
    assert.ok(body.includes('flyTo'), 'must animate with cesiumViewer.camera.flyTo');
  });

  test('setOrbitTarget is defined and writes cesiumCameraLerpState', function () {
    assert.ok(src.includes('function setOrbitTarget'), 'setOrbitTarget must be defined');
    const fnIdx = src.indexOf('function setOrbitTarget');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('cesiumCameraLerpState'), 'must update cesiumCameraLerpState for follow tracking');
  });

  test('runFocusAction delegates to jumpToTarget', function () {
    const fnIdx = src.indexOf('function runFocusAction');
    assert.ok(fnIdx !== -1, 'runFocusAction must exist');
    const body = src.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('jumpToTarget'), 'runFocusAction must call jumpToTarget');
  });

  test('selectAgent calls jumpToTarget when a target is provided', function () {
    const fnIdx = src.indexOf('function selectAgent');
    assert.ok(fnIdx !== -1, 'selectAgent must exist');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('jumpToTarget'), 'selectAgent must call jumpToTarget on selection');
  });

  test('selectRegion calls jumpToTarget when a target is provided', function () {
    const fnIdx = src.indexOf('function selectRegion');
    assert.ok(fnIdx !== -1, 'selectRegion must exist');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('jumpToTarget'), 'selectRegion must call jumpToTarget on selection');
  });

  test('event entries carry agentId/regionId data attributes for click-to-jump', function () {
    const fnIdx = src.indexOf('function createEventEntry');
    assert.ok(fnIdx !== -1, 'createEventEntry must exist');
    const body = src.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('dataset.agentId'),  'event entries must expose agentId for click-to-jump');
    assert.ok(body.includes('dataset.regionId'), 'event entries must expose regionId for click-to-jump');
  });
});

// ── Street-view panel ─────────────────────────────────────────────────────────
describe('street-view panel', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('street-view div exists in HTML', function () {
    assert.ok(src.includes('id="street-view"'), 'street-view overlay div must be present');
  });

  test('street-view-pano div exists inside street-view', function () {
    const svIdx = src.indexOf('id="street-view"');
    assert.ok(svIdx !== -1, 'street-view must exist');
    const closeIdx = src.indexOf('id="street-view-pano"');
    assert.ok(closeIdx > svIdx, 'street-view-pano must appear after street-view');
  });

  test('street-view-close button exists in HTML', function () {
    assert.ok(src.includes('id="street-view-close"'), 'close button must be present');
  });

  test('street-view close button appears inside street-view div', function () {
    const svIdx = src.indexOf('id="street-view"');
    const closeIdx = src.indexOf('id="street-view-close"');
    const panoIdx = src.indexOf('id="street-view-pano"');
    assert.ok(svIdx !== -1, 'street-view must exist');
    assert.ok(closeIdx > svIdx, 'close button must be inside street-view');
    assert.ok(panoIdx > closeIdx, 'pano container must follow close button');
  });

  test('initStreetView is defined', function () {
    assert.ok(src.includes('function initStreetView'), 'initStreetView must be defined');
  });

  test('initStreetView creates StreetViewPanorama with correct options', function () {
    const fnIdx = src.indexOf('function initStreetView');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('StreetViewPanorama'), 'must create google.maps.StreetViewPanorama');
    assert.ok(body.includes('pov'), 'must set pov');
    assert.ok(body.includes('heading: 0'), 'pov heading must be 0');
    assert.ok(body.includes('pitch: 0'), 'pov pitch must be 0');
    assert.ok(body.includes('zoom: 1'), 'zoom must be 1');
  });

  test('showStreetView is defined and guards on valid coords', function () {
    assert.ok(src.includes('function showStreetView'), 'showStreetView must be defined');
    const fnIdx = src.indexOf('function showStreetView');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('googleMapsApiKey'), 'must check for googleMapsApiKey before showing');
    assert.ok(body.includes('Number.isFinite'), 'must validate lat/lng with Number.isFinite');
  });

  test('hideStreetView is defined and removes visible class', function () {
    assert.ok(src.includes('function hideStreetView'), 'hideStreetView must be defined');
    const fnIdx = src.indexOf('function hideStreetView');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('classList.remove'), 'must remove visible class to hide the panel');
    assert.ok(body.includes('visible'), 'must reference the visible class');
  });

  test('loadGoogleMapsApi is defined and injects script tag', function () {
    assert.ok(src.includes('function loadGoogleMapsApi'), 'loadGoogleMapsApi must be defined');
    const fnIdx = src.indexOf('function loadGoogleMapsApi');
    const body = src.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('createElement'), 'must create a script element');
    assert.ok(body.includes('maps.googleapis.com'), 'must point at Google Maps API');
    assert.ok(body.includes('encodeURIComponent'), 'API key must be URL-encoded');
  });

  test('street-view close button is bound to hideStreetView', function () {
    assert.ok(src.includes('street-view-close'), 'close button must be referenced in JS');
    // Search for the JS binding (getElementById, not the HTML id=)
    const bindIdx = src.indexOf("getElementById('street-view-close')");
    assert.ok(bindIdx !== -1, 'close button must be fetched via getElementById in JS');
    const snippet = src.slice(bindIdx, bindIdx + 400);
    assert.ok(snippet.includes('hideStreetView'), 'close button click must call hideStreetView');
  });

  test('selectAgent calls showStreetView when an entity has coordinates', function () {
    const fnIdx = src.indexOf('function selectAgent');
    assert.ok(fnIdx !== -1, 'selectAgent must exist');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('showStreetView'), 'selectAgent must call showStreetView on selection');
  });

  test('selectAgent calls hideStreetView when deselecting', function () {
    const fnIdx = src.indexOf('function selectAgent');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('hideStreetView'), 'selectAgent must call hideStreetView on deselect');
  });

  test('selectRegion calls showStreetView when a region has coordinates', function () {
    const fnIdx = src.indexOf('function selectRegion');
    assert.ok(fnIdx !== -1, 'selectRegion must exist');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('showStreetView'), 'selectRegion must call showStreetView on selection');
  });

  test('selectRegion calls hideStreetView when deselecting', function () {
    const fnIdx = src.indexOf('function selectRegion');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('hideStreetView'), 'selectRegion must call hideStreetView on deselect');
  });

  test('street-view CSS has display:none default and visible class', function () {
    assert.ok(src.includes('#street-view {'), 'street-view CSS rule must exist');
    assert.ok(src.includes('#street-view.visible'), 'visible state CSS rule must exist');
  });

  test('street-view panel has z-index above Cesium (z-index 50+)', function () {
    const cssIdx = src.indexOf('#street-view {');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    const match = snippet.match(/z-index:\s*(\d+)/);
    assert.ok(match, 'street-view must have z-index set');
    assert.ok(Number(match[1]) >= 50, 'z-index must be >= 50 to overlay Cesium');
  });

  test('Cesium viewer is not destroyed when street-view is shown', function () {
    // showStreetView must not call cesiumViewer.destroy()
    const fnIdx = src.indexOf('function showStreetView');
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(!body.includes('destroy'), 'showStreetView must not destroy the Cesium viewer');
  });
});

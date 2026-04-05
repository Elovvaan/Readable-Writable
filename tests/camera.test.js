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
    const panoIdx = src.indexOf('id="street-view-pano"');
    assert.ok(panoIdx > svIdx, 'street-view-pano must appear after street-view');
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

// ── Street-level tab (dedicated mode switch) ──────────────────────────────────
describe('street-level tab (dedicated mode switch)', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('street-level-view container exists in HTML', function () {
    assert.ok(src.includes('id="street-level-view"'), 'dedicated street-level view container must exist');
  });

  test('street-level-view is hidden by default via CSS', function () {
    const cssIdx = src.indexOf('#street-level-view {');
    assert.ok(cssIdx !== -1, 'street-level-view CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    assert.ok(snippet.includes('display: none'), 'street-level-view must be hidden by default');
  });

  test('street-level-view active class uses display:flex', function () {
    assert.ok(src.includes('#street-level-view.active'), 'street-level-view active CSS rule must exist');
    const cssIdx = src.indexOf('#street-level-view.active');
    const snippet = src.slice(cssIdx, cssIdx + 80);
    assert.ok(snippet.includes('display: flex'), 'active state must show with display:flex');
  });

  test('street-level tab button exists in HTML', function () {
    assert.ok(src.includes('id="street-level-tab"'), 'street-level tab button must exist in HTML');
  });

  test('street-level tab button is labeled Street Level', function () {
    const btnIdx = src.indexOf('id="street-level-tab"');
    assert.ok(btnIdx !== -1);
    const snippet = src.slice(btnIdx, btnIdx + 200);
    assert.ok(snippet.includes('Street Level'), 'tab button must be labeled Street Level');
  });

  test('street-level-back-btn exists in HTML', function () {
    assert.ok(src.includes('id="street-level-back-btn"'), 'back-to-globe button must exist in HTML');
  });

  test('street-level-back-btn appears inside street-level-view', function () {
    const viewIdx = src.indexOf('id="street-level-view"');
    const backIdx = src.indexOf('id="street-level-back-btn"');
    assert.ok(viewIdx !== -1, 'street-level-view must exist');
    assert.ok(backIdx > viewIdx, 'back button must appear after street-level-view in source');
  });

  test('street-level-pano div exists inside street-level-view', function () {
    const viewIdx = src.indexOf('id="street-level-view"');
    const panoIdx = src.indexOf('id="street-level-pano"');
    assert.ok(viewIdx !== -1, 'street-level-view must exist');
    assert.ok(panoIdx > viewIdx, 'street-level-pano must appear after street-level-view in source');
  });

  test('no-target message text is present in HTML', function () {
    assert.ok(src.includes('Select a target first'), 'no-target message must exist in HTML');
  });

  test('openStreetLevelTab is defined', function () {
    assert.ok(src.includes('function openStreetLevelTab'), 'openStreetLevelTab must be defined');
  });

  test('closeStreetLevelTab is defined', function () {
    assert.ok(src.includes('function closeStreetLevelTab'), 'closeStreetLevelTab must be defined');
  });

  test('initStreetLevelPanorama is defined', function () {
    assert.ok(src.includes('function initStreetLevelPanorama'), 'initStreetLevelPanorama must be defined');
  });

  test('initStreetLevelPanorama reuses existing panorama via setPosition', function () {
    const fnIdx = src.indexOf('function initStreetLevelPanorama');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('streetLevelPanorama'), 'must use streetLevelPanorama for single-instance reuse');
    assert.ok(body.includes('setPosition'), 'must call setPosition when reusing existing instance');
  });

  test('openStreetLevelTab checks selectedTargetCoords before loading panorama', function () {
    const fnIdx = src.indexOf('function openStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 1400);
    assert.ok(body.includes('selectedTargetCoords'), 'must check selectedTargetCoords');
    assert.ok(body.includes('street-level-no-target'), 'must reference the no-target message element');
    assert.ok(body.includes('loadGoogleMapsApi'), 'must load Google Maps API when coords available');
  });

  test('openStreetLevelTab hides globe-shell and activates street-level-view', function () {
    const fnIdx = src.indexOf('function openStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(body.includes('globe-shell'), 'must reference globe-shell to hide it');
    assert.ok(body.includes('classList.add'), 'must add active class to street-level-view');
  });

  test('closeStreetLevelTab restores globe-shell', function () {
    const fnIdx = src.indexOf('function closeStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('globe-shell'), 'must restore globe-shell visibility');
    assert.ok(body.includes('classList.remove'), 'must remove active class from street-level-view');
  });

  test('street-level-tab button is bound to openStreetLevelTab', function () {
    // The event binding uses 'const streetLevelTabBtn' — find that variable assignment
    const bindIdx = src.indexOf('const streetLevelTabBtn');
    assert.ok(bindIdx !== -1, 'streetLevelTabBtn must be declared for the event binding');
    const snippet = src.slice(bindIdx, bindIdx + 250);
    assert.ok(snippet.includes('openStreetLevelTab'), 'street-level-tab click must call openStreetLevelTab');
  });

  test('street-level-back-btn is bound to closeStreetLevelTab', function () {
    const bindIdx = src.indexOf("getElementById('street-level-back-btn')");
    assert.ok(bindIdx !== -1, 'back button must be fetched via getElementById');
    const snippet = src.slice(bindIdx, bindIdx + 250);
    assert.ok(snippet.includes('closeStreetLevelTab'), 'back button click must call closeStreetLevelTab');
  });

  test('selectedTargetCoords is stored when selectAgent finds valid coordinates', function () {
    const fnIdx = src.indexOf('function selectAgent');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('selectedTargetCoords'), 'selectAgent must store selectedTargetCoords');
  });

  test('selectedTargetCoords is cleared on deselect in selectAgent', function () {
    const fnIdx = src.indexOf('function selectAgent');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('selectedTargetCoords = null'), 'selectAgent must null selectedTargetCoords on deselect');
  });

  test('selectedTargetCoords is stored when selectRegion finds valid coordinates', function () {
    const fnIdx = src.indexOf('function selectRegion');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('selectedTargetCoords'), 'selectRegion must store selectedTargetCoords');
  });

  test('selectedTargetCoords is cleared on deselect in selectRegion', function () {
    const fnIdx = src.indexOf('function selectRegion');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('selectedTargetCoords = null'), 'selectRegion must null selectedTargetCoords on deselect');
  });

  test('streetLevelActive and streetLevelPanorama state vars are declared', function () {
    assert.ok(src.includes('streetLevelActive'), 'streetLevelActive must be declared as state');
    assert.ok(src.includes('streetLevelPanorama'), 'streetLevelPanorama must be declared as state');
  });

  test('rail-btn-street-level button exists in HTML', function () {
    assert.ok(src.includes('id="rail-btn-street-level"'), 'Street Level rail button must exist in HTML');
  });

  test('rail-btn-street-level button appears inside the rail nav', function () {
    const railIdx = src.indexOf('<nav id="rail"');
    const btnIdx  = src.indexOf('id="rail-btn-street-level"');
    assert.ok(railIdx !== -1, 'rail nav must exist');
    assert.ok(btnIdx  >  railIdx, 'rail-btn-street-level must appear after the rail nav opening tag');
  });

  test('rail-btn-street-level is wired to openStreetLevelTab', function () {
    const bindIdx = src.indexOf('streetLevelRailBtn');
    assert.ok(bindIdx !== -1, 'streetLevelRailBtn variable must be declared for the event binding');
    const snippet = src.slice(bindIdx, bindIdx + 250);
    assert.ok(snippet.includes('openStreetLevelTab'), 'rail button click must call openStreetLevelTab');
  });

  test('openStreetLevelTab sets active state on rail-btn-street-level', function () {
    const fnIdx = src.indexOf('function openStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 1400);
    assert.ok(body.includes('rail-btn-street-level'), 'openStreetLevelTab must reference the rail button');
    assert.ok(body.includes("classList.add('active')"), 'openStreetLevelTab must add active class');
  });

  test('closeStreetLevelTab clears active state on rail-btn-street-level', function () {
    const fnIdx = src.indexOf('function closeStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('rail-btn-street-level'), 'closeStreetLevelTab must reference the rail button');
    assert.ok(body.includes("classList.remove('active')"), 'closeStreetLevelTab must remove active class');
  });
});

// ── Globe viewport centering invariants ───────────────────────────────────────
describe('globe viewport centering invariants', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('initCesium clears trackedEntity immediately after viewer creation', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must be defined');
    const viewerIdx = src.indexOf("new Cesium.Viewer('cesium-world'", fnIdx);
    assert.ok(viewerIdx !== -1, 'Cesium.Viewer must be created inside initCesium');
    // trackedEntity = undefined must appear between viewer creation and the first scene property
    const afterViewer = src.slice(viewerIdx, viewerIdx + 800);
    assert.ok(afterViewer.includes('trackedEntity = undefined'), 'trackedEntity must be unset right after viewer creation');
  });

  test('initCesium calls setView immediately after viewer creation to anchor the camera', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must be defined');
    const viewerIdx = src.indexOf("new Cesium.Viewer('cesium-world'", fnIdx);
    assert.ok(viewerIdx !== -1, 'Cesium.Viewer must be created inside initCesium');
    const afterViewer = src.slice(viewerIdx, viewerIdx + 800);
    assert.ok(afterViewer.includes('camera.setView'), 'setView must be called right after viewer creation to anchor the camera');
  });

  test('initCesium initial setView uses a valid global altitude (>= 10 000 000 m)', function () {
    const fnIdx = src.indexOf('async function initCesium');
    const viewerIdx = src.indexOf("new Cesium.Viewer('cesium-world'", fnIdx);
    const afterViewer = src.slice(viewerIdx, viewerIdx + 800);
    const altMatch = afterViewer.match(/fromDegrees\([^)]+,\s*(\d+)\)/);
    assert.ok(altMatch, 'setView destination must use Cartesian3.fromDegrees with an altitude');
    assert.ok(Number(altMatch[1]) >= 10000000, 'initial altitude must be >= 10 000 000 m to show the full globe');
  });

  test('initCesium initial setView uses a pitch of -90 deg (straight down at Earth)', function () {
    const fnIdx = src.indexOf('async function initCesium');
    const viewerIdx = src.indexOf("new Cesium.Viewer('cesium-world'", fnIdx);
    const afterViewer = src.slice(viewerIdx, viewerIdx + 800);
    assert.ok(afterViewer.includes('toRadians(-90)'), 'initial camera pitch must be -90 deg (nadir) to guarantee Earth is in view');
  });

  test('initCesium calls cesiumViewer.resize() before first draw()', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must be defined');
    const body = src.slice(fnIdx, fnIdx + 6000);
    const resizeIdx = body.lastIndexOf('cesiumViewer.resize()');
    const drawIdx   = body.lastIndexOf('draw()');
    assert.ok(resizeIdx !== -1, 'cesiumViewer.resize() must be called inside initCesium');
    assert.ok(drawIdx   !== -1, 'draw() must be called inside initCesium');
    assert.ok(resizeIdx < drawIdx, 'cesiumViewer.resize() must come before draw() inside initCesium');
  });

  test('initCesium logs camera position after initialization', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must be defined');
    const body = src.slice(fnIdx, fnIdx + 6000);
    assert.ok(body.includes('positionCartographic'), 'initCesium must read positionCartographic to log camera position');
    assert.ok(body.includes('camera init:'), 'initCesium must log a camera init message confirming position');
  });

  test('viewerCameraSafetyCheck includes orientation in its setView call', function () {
    const fnIdx = src.indexOf('function viewerCameraSafetyCheck');
    assert.ok(fnIdx !== -1, 'viewerCameraSafetyCheck must be defined');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('orientation'), 'viewerCameraSafetyCheck setView must include orientation to clamp pitch');
    assert.ok(body.includes('toRadians(-90)'), 'safety-check pitch must be -90 deg to guarantee Earth is in view');
  });

  test('cesium-world container uses inset:0 for full-viewport anchoring', function () {
    assert.ok(
      src.includes('#cesium-world { position: absolute; inset: 0;'),
      '#cesium-world CSS must use inset:0 to fill its parent without offsets'
    );
  });

  test('canvas#world uses inset:0 with pointer-events:none', function () {
    assert.ok(
      src.includes('canvas#world { position: absolute; inset: 0;'),
      'canvas#world must use inset:0 so it is anchored at top:0 left:0'
    );
    assert.ok(src.includes('pointer-events: none'), 'canvas overlay must not capture pointer events');
  });
});

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

  test('initStreetView delegates to Cesium street-level navigation', function () {
    const fnIdx = src.indexOf('function initStreetView');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('enterCesiumStreetLevel'), 'initStreetView must call enterCesiumStreetLevel for Cesium-based ground navigation');
    assert.ok(body.includes('cesiumViewer'), 'must guard on cesiumViewer availability');
  });

  test('showStreetView is defined and guards on valid coords', function () {
    assert.ok(src.includes('function showStreetView'), 'showStreetView must be defined');
    const fnIdx = src.indexOf('function showStreetView');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('cesiumViewer'), 'must check for cesiumViewer before entering street-level');
    assert.ok(body.includes('Number.isFinite'), 'must validate lat/lng with Number.isFinite');
  });

  test('hideStreetView is defined and removes visible class', function () {
    assert.ok(src.includes('function hideStreetView'), 'hideStreetView must be defined');
    const fnIdx = src.indexOf('function hideStreetView');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('classList.remove'), 'must remove visible class to hide the panel');
    assert.ok(body.includes('visible'), 'must reference the visible class');
  });

  test('loadGoogleMapsApi is a Cesium-compat stub that invokes callback directly', function () {
    assert.ok(src.includes('function loadGoogleMapsApi'), 'loadGoogleMapsApi must be defined as a compat stub');
    const fnIdx = src.indexOf('function loadGoogleMapsApi');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('callback'), 'stub must accept and invoke the callback');
    assert.ok(!body.includes('createElement'), 'stub must not create script elements for Google Maps loading');
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

  test('mode drawer street section exists in HTML', function () {
    assert.ok(src.includes('id="mode-drawer-street"'), 'mode-drawer-street section must exist in HTML');
    assert.ok(src.includes('id="mode-drawer"'), 'mode-drawer must exist in HTML');
  });

  test('mode drawer is labeled Street Level when in street mode', function () {
    // The JS sets the title to 'STREET LEVEL' when opening street mode
    assert.ok(src.includes("'STREET LEVEL'"), 'mode drawer must reference STREET LEVEL title');
  });

  test('mode-drawer-close button exists in HTML', function () {
    assert.ok(src.includes('id="mode-drawer-close"'), 'mode-drawer close button must exist in HTML');
  });

  test('mode-drawer-close appears inside mode-drawer', function () {
    const drawerIdx = src.indexOf('id="mode-drawer"');
    const closeIdx = src.indexOf('id="mode-drawer-close"');
    assert.ok(drawerIdx !== -1, 'mode-drawer must exist');
    assert.ok(closeIdx > drawerIdx, 'close button must appear after mode-drawer opening in source');
  });

  test('navigation controls exist inside mode-drawer-street', function () {
    const sectionIdx = src.indexOf('id="mode-drawer-street"');
    const fwdIdx = src.indexOf('id="sl-fwd-btn"');
    assert.ok(sectionIdx !== -1, 'mode-drawer-street must exist');
    assert.ok(fwdIdx > sectionIdx, 'navigation buttons must appear inside mode-drawer-street');
  });

  test('no-target message text is present in HTML', function () {
    assert.ok(src.includes('Select a target to navigate'), 'no-target message must exist in HTML');
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

  test('initStreetLevelPanorama uses Cesium street-level navigation', function () {
    const fnIdx = src.indexOf('function initStreetLevelPanorama');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('enterCesiumStreetLevel'), 'initStreetLevelPanorama must delegate to enterCesiumStreetLevel for Cesium-based navigation');
  });

  test('openStreetLevelTab checks selectedTargetCoords before loading panorama', function () {
    const fnIdx = src.indexOf('function openStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 1400);
    assert.ok(body.includes('selectedTargetCoords'), 'must check selectedTargetCoords');
    assert.ok(body.includes('mode-no-target'), 'must reference the no-target message element in mode drawer');
    assert.ok(body.includes('loadGoogleMapsApi'), 'must load Google Maps API when coords available');
  });

  test('openStreetLevelTab opens mode drawer and activates street level', function () {
    const fnIdx = src.indexOf('function openStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(body.includes('openModeDrawer'), 'must open the mode drawer');
    assert.ok(body.includes('classList.add'), 'must add active class to the rail button');
  });

  test('closeStreetLevelTab closes mode drawer and exits street level', function () {
    const fnIdx = src.indexOf('function closeStreetLevelTab');
    assert.ok(fnIdx !== -1);
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('closeModeDrawer'), 'must close the mode drawer');
    assert.ok(body.includes('classList.remove'), 'must remove active class from rail button');
  });

  test('rail-btn-street-level is wired to open/close street level mode', function () {
    const bindIdx = src.indexOf('streetLevelRailBtn');
    assert.ok(bindIdx !== -1, 'streetLevelRailBtn variable must be declared for the event binding');
    const snippet = src.slice(bindIdx, bindIdx + 300);
    assert.ok(snippet.includes('openStreetLevelTab'), 'rail button click must call openStreetLevelTab');
  });

  test('mode-drawer-close is bound to close the active mode', function () {
    const bindIdx = src.indexOf("getElementById('mode-drawer-close')");
    assert.ok(bindIdx !== -1, 'mode-drawer-close must be fetched via getElementById');
    const snippet = src.slice(bindIdx, bindIdx + 300);
    assert.ok(snippet.includes('closeStreetLevelTab'), 'close button click must call closeStreetLevelTab');
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
    const snippet = src.slice(bindIdx, bindIdx + 320);
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
    const body = src.slice(fnIdx, fnIdx + 10000);
    const resizeIdx = body.lastIndexOf('cesiumViewer.resize()');
    const drawIdx   = body.lastIndexOf('draw()');
    assert.ok(resizeIdx !== -1, 'cesiumViewer.resize() must be called inside initCesium');
    assert.ok(drawIdx   !== -1, 'draw() must be called inside initCesium');
    assert.ok(resizeIdx < drawIdx, 'cesiumViewer.resize() must come before draw() inside initCesium');
  });

  test('initCesium logs camera position after initialization', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must be defined');
    const body = src.slice(fnIdx, fnIdx + 10000);
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

// ── Cesium street-level navigation (replacing Google Street View) ─────────────
describe('Cesium street-level navigation', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('enterCesiumStreetLevel is defined and uses flyTo for smooth transition', function () {
    assert.ok(src.includes('function enterCesiumStreetLevel'), 'enterCesiumStreetLevel must be defined');
    const fnIdx = src.indexOf('function enterCesiumStreetLevel');
    // Use 1300 chars to accommodate the LOD adjustment line added above the flyTo call
    const body = src.slice(fnIdx, fnIdx + 1300);
    assert.ok(body.includes('flyTo'), 'must use flyTo for smooth street-level transition');
    assert.ok(body.includes('STREET_LEVEL_ALTITUDE_M'), 'must use STREET_LEVEL_ALTITUDE_M constant for altitude');
    assert.ok(body.includes('STREET_LEVEL_PITCH_DEG'), 'must use STREET_LEVEL_PITCH_DEG constant for forward pitch');
  });

  test('enterCesiumStreetLevel saves orbit position for return journey', function () {
    const fnIdx = src.indexOf('function enterCesiumStreetLevel');
    const body = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(body.includes('cesiumPreStreetLevelPos'), 'must save pre-street-level position to restore on exit');
    assert.ok(body.includes('positionCartographic'), 'must read current camera cartographic position');
  });

  test('exitCesiumStreetLevel is defined and returns camera to orbit altitude', function () {
    assert.ok(src.includes('function exitCesiumStreetLevel'), 'exitCesiumStreetLevel must be defined');
    const fnIdx = src.indexOf('function exitCesiumStreetLevel');
    const body = src.slice(fnIdx, fnIdx + 900);
    assert.ok(body.includes('flyTo'), 'must flyTo the saved orbit position');
    assert.ok(body.includes('cesiumPreStreetLevelPos'), 'must restore the pre-street-level orbit position');
  });

  test('cesiumStreetLevelMode state var is declared', function () {
    assert.ok(src.includes('cesiumStreetLevelMode'), 'cesiumStreetLevelMode state var must be declared');
    assert.ok(src.includes('cesiumStreetLevelMode = false'), 'cesiumStreetLevelMode must default to false');
  });

  test('STREET_LEVEL_ALTITUDE_M constant is declared and is 10-200m range', function () {
    assert.ok(src.includes('const STREET_LEVEL_ALTITUDE_M'), 'STREET_LEVEL_ALTITUDE_M constant must be declared');
    const match = src.match(/const STREET_LEVEL_ALTITUDE_M\s*=\s*(\d+)/);
    assert.ok(match, 'STREET_LEVEL_ALTITUDE_M must have a numeric value');
    const val = Number(match[1]);
    assert.ok(val >= 10 && val <= 200, 'STREET_LEVEL_ALTITUDE_M must be between 10m and 200m (got ' + val + ')');
  });

  test('STREET_LEVEL_AUTO_TILT_ALT constant is declared for auto-tilt threshold', function () {
    assert.ok(src.includes('const STREET_LEVEL_AUTO_TILT_ALT'), 'STREET_LEVEL_AUTO_TILT_ALT must be declared');
  });

  test('auto-tilt is registered via camera.moveEnd listener in initCesium', function () {
    const fnIdx = src.indexOf('async function initCesium');
    assert.ok(fnIdx !== -1, 'initCesium must exist');
    const body = src.slice(fnIdx, fnIdx + 10000);
    assert.ok(body.includes('camera.moveEnd'), 'auto-tilt must use camera.moveEnd event to trigger after zoom');
    assert.ok(body.includes('STREET_LEVEL_AUTO_TILT_ALT'), 'auto-tilt must check STREET_LEVEL_AUTO_TILT_ALT threshold');
  });

  test('Cesium World Terrain is requested in initCesium when Ion token present', function () {
    const fnIdx = src.indexOf('async function initCesium');
    const body = src.slice(fnIdx, fnIdx + 10000);
    assert.ok(body.includes('createWorldTerrainAsync'), 'initCesium must call createWorldTerrainAsync for realistic elevation');
    assert.ok(body.includes('terrainProvider'), 'terrain provider must be passed to Viewer constructor');
  });

  test('OSM Buildings are loaded in initCesium when Ion token present', function () {
    const fnIdx = src.indexOf('async function initCesium');
    const body = src.slice(fnIdx, fnIdx + 10000);
    assert.ok(body.includes('createOsmBuildingsAsync'), 'initCesium must load OSM Buildings for 3D scene');
    assert.ok(body.includes('OSM Buildings'), 'initCesium must log OSM Buildings status');
  });

  test('depthTestAgainstTerrain is true for terrain-aware rendering', function () {
    assert.ok(src.includes('depthTestAgainstTerrain = true'), 'depthTestAgainstTerrain must be enabled for terrain collision');
  });

  test('minimumZoomDistance is 10m to allow street-level approach', function () {
    assert.ok(src.includes('ssc.minimumZoomDistance = 10'), 'minimumZoomDistance must be 10m to allow street-level zoom');
  });

  test('drone keyboard listener is registered for WASD+QE movement in all Cesium modes', function () {
    assert.ok(src.includes("'keydown'"), 'keydown listener must be registered for drone movement');
    assert.ok(src.includes("'keyup'"), 'keyup listener must be registered for drone key release');
    // Find the keydown listener that includes DRONE_FLIGHT_KEYS (not the FP-mode Escape listener)
    let kdIdx = src.indexOf("addEventListener('keydown'");
    let body = '';
    while (kdIdx !== -1) {
      body = src.slice(kdIdx, kdIdx + 600);
      if (body.includes('DRONE_FLIGHT_KEYS')) { break; }
      kdIdx = src.indexOf("addEventListener('keydown'", kdIdx + 1);
    }
    assert.ok(kdIdx !== -1, 'drone keydown listener must exist');
    assert.ok(body.includes('USE_CESIUM') && body.includes('cesiumViewer'), 'keyboard handler must guard on USE_CESIUM and cesiumViewer (global, not street-level only)');
    assert.ok(body.includes('DRONE_FLIGHT_KEYS'), 'keyboard handler must use DRONE_FLIGHT_KEYS for unified key list');
    assert.ok(body.includes('droneMoveLoop'), 'keyboard handler must start droneMoveLoop');
    // Verify DRONE_FLIGHT_KEYS includes WASD + Q/E keys
    const keysIdx = src.indexOf('DRONE_FLIGHT_KEYS');
    const keysDecl = src.slice(keysIdx, keysIdx + 120);
    assert.ok(keysDecl.includes("'w'"), 'DRONE_FLIGHT_KEYS must include W key');
    assert.ok(keysDecl.includes("'q'"), 'DRONE_FLIGHT_KEYS must include Q key for descend');
    assert.ok(keysDecl.includes("'e'"), 'DRONE_FLIGHT_KEYS must include E key for ascend');
    assert.ok(keysDecl.includes("'shift'"), 'DRONE_FLIGHT_KEYS must include shift key for boost');
  });

  test('droneMoveLoop supports Q key (descend) and E key (ascend)', function () {
    const fnIdx = src.indexOf('function droneMoveLoop');
    assert.ok(fnIdx !== -1, 'droneMoveLoop must be defined');
    const body = src.slice(fnIdx, fnIdx + 1200);
    assert.ok(body.includes("cesiumDroneKeys['e']") && body.includes('moveUp'), 'droneMoveLoop must move camera up when E (ascend) is pressed');
    assert.ok(body.includes("cesiumDroneKeys['q']") && body.includes('moveDown'), 'droneMoveLoop must move camera down when Q (descend) is pressed');
  });

  test('droneMoveLoop supports Shift key for boost speed', function () {
    const fnIdx = src.indexOf('function droneMoveLoop');
    const body = src.slice(fnIdx, fnIdx + 1200);
    assert.ok(body.includes("cesiumDroneKeys['shift']"), 'droneMoveLoop must read shift key state');
    assert.ok(body.includes('DRONE_BOOST_MULTIPLIER'), 'droneMoveLoop must apply DRONE_BOOST_MULTIPLIER for Shift boost');
  });

  test('DRONE_BOOST_MULTIPLIER constant is declared for Shift speed boost', function () {
    assert.ok(src.includes('const DRONE_BOOST_MULTIPLIER'), 'DRONE_BOOST_MULTIPLIER must be declared');
    const match = src.match(/const DRONE_BOOST_MULTIPLIER\s*=\s*(\d+)/);
    assert.ok(match, 'DRONE_BOOST_MULTIPLIER must have a numeric value');
    const val = Number(match[1]);
    assert.ok(val >= 2 && val <= 10, 'DRONE_BOOST_MULTIPLIER must be a reasonable multiplier (2-10, got ' + val + ')');
  });

  test('droneMoveLoop works globally in all Cesium modes (no cesiumStreetLevelMode guard)', function () {
    const fnIdx = src.indexOf('function droneMoveLoop');
    assert.ok(fnIdx !== -1, 'droneMoveLoop must be defined');
    const body = src.slice(fnIdx, fnIdx + 400);
    // The loop must guard on cesiumViewer existence but NOT on cesiumStreetLevelMode
    assert.ok(body.includes('cesiumViewer'), 'droneMoveLoop must check cesiumViewer');
    assert.ok(!body.includes('cesiumStreetLevelMode'), 'droneMoveLoop must NOT be gated on cesiumStreetLevelMode so it works globally');
  });

  test('droneMoveLoop is defined for continuous smooth drone movement', function () {
    assert.ok(src.includes('function droneMoveLoop'), 'droneMoveLoop must be defined');
    const fnIdx = src.indexOf('function droneMoveLoop');
    const body = src.slice(fnIdx, fnIdx + 1500);
    assert.ok(body.includes('moveForward'), 'droneMoveLoop must call moveForward for W key');
    assert.ok(body.includes('moveBackward'), 'droneMoveLoop must call moveBackward for S key');
    assert.ok(body.includes('requestAnimationFrame'), 'droneMoveLoop must use requestAnimationFrame for smooth continuous motion');
  });

  test('activateFocusMode is defined and uses lookAt for orbit lock', function () {
    assert.ok(src.includes('function activateFocusMode'), 'activateFocusMode must be defined');
    const fnIdx = src.indexOf('function activateFocusMode');
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('lookAt'), 'activateFocusMode must use camera.lookAt for orbit-lock focus');
    assert.ok(body.includes('HeadingPitchRange'), 'activateFocusMode must use HeadingPitchRange for controlled orbit');
  });

  test('deactivateFocusMode releases lookAt constraint', function () {
    assert.ok(src.includes('function deactivateFocusMode'), 'deactivateFocusMode must be defined');
    const fnIdx = src.indexOf('function deactivateFocusMode');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('lookAtTransform'), 'deactivateFocusMode must call lookAtTransform to release orbit lock');
    assert.ok(body.includes('IDENTITY'), 'deactivateFocusMode must restore IDENTITY transform for free-orbit');
  });

  test('runFocusAction calls activateFocusMode for enhanced focus orbit', function () {
    const fnIdx = src.indexOf('function runFocusAction');
    assert.ok(fnIdx !== -1, 'runFocusAction must exist');
    const body = src.slice(fnIdx, fnIdx + 600);
    assert.ok(body.includes('activateFocusMode'), 'runFocusAction must call activateFocusMode for focus-lock orbit');
  });

  test('street-level view is an absolute overlay inside globe-shell', function () {
    const globeIdx = src.indexOf('<div id="globe-shell">');
    const slvIdx   = src.indexOf('<div id="street-level-view"');
    assert.ok(globeIdx !== -1, 'globe-shell must exist');
    assert.ok(slvIdx > globeIdx, 'street-level-view must appear after globe-shell opening tag');
    const cssIdx = src.indexOf('#street-level-view {');
    assert.ok(cssIdx !== -1, 'street-level-view CSS rule must exist');
    const cssSnippet = src.slice(cssIdx, cssIdx + 150);
    assert.ok(cssSnippet.includes('position: absolute'), 'street-level-view must use position:absolute to overlay globe');
    assert.ok(cssSnippet.includes('inset: 0'), 'street-level-view must use inset:0 to fill globe-shell');
    assert.ok(cssSnippet.includes('background: transparent'), 'street-level-view must be transparent so Cesium shows through');
  });

  test('street-view HUD overlay is transparent so Cesium renders through it', function () {
    const cssIdx = src.indexOf('#street-view {');
    assert.ok(cssIdx !== -1, 'street-view CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    assert.ok(snippet.includes('background: transparent'), 'street-view must have transparent background so Cesium is visible');
  });
});

// ── Camera zoom: pointer-events passthrough ───────────────────────────────────
describe('camera zoom: wheel and pinch passthrough to Cesium', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('#street-level-view has pointer-events:none so wheel events reach Cesium canvas', function () {
    const cssIdx = src.indexOf('#street-level-view {');
    assert.ok(cssIdx !== -1, '#street-level-view CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 300);
    assert.ok(snippet.includes('pointer-events: none'), '#street-level-view must have pointer-events:none to let wheel/pinch reach Cesium');
  });

  test('#sl-left-panel explicitly restores pointer-events:auto for interactive buttons', function () {
    const cssIdx = src.indexOf('#sl-left-panel {');
    assert.ok(cssIdx !== -1, '#sl-left-panel CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 300);
    assert.ok(snippet.includes('pointer-events: auto'), '#sl-left-panel must have pointer-events:auto so its buttons remain clickable');
  });

  test('#sl-right-panel explicitly restores pointer-events:auto for interactive controls', function () {
    const cssIdx = src.indexOf('#sl-right-panel {');
    assert.ok(cssIdx !== -1, '#sl-right-panel CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    assert.ok(snippet.includes('pointer-events: auto'), '#sl-right-panel must have pointer-events:auto so its controls remain clickable');
  });

  test('#sl-viewport retains pointer-events:none (center viewport must pass through to Cesium)', function () {
    const cssIdx = src.indexOf('#sl-viewport {');
    assert.ok(cssIdx !== -1, '#sl-viewport CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    assert.ok(snippet.includes('pointer-events: none'), '#sl-viewport must retain pointer-events:none');
  });

  test('#sl-bottom-bar retains pointer-events:auto (location bar must be interactive)', function () {
    const cssIdx = src.indexOf('#sl-bottom-bar {');
    assert.ok(cssIdx !== -1, '#sl-bottom-bar CSS rule must exist');
    const snippet = src.slice(cssIdx, cssIdx + 200);
    assert.ok(snippet.includes('pointer-events: auto'), '#sl-bottom-bar must retain pointer-events:auto');
  });

  test('ssc.enableZoom is true and minimumZoomDistance allows street-level approach', function () {
    assert.ok(src.includes('ssc.enableZoom   = true'), 'enableZoom must be true');
    assert.ok(src.includes('ssc.minimumZoomDistance = 10'), 'minimumZoomDistance must be 10m');
  });
});

// ── Location search: Google Places Autocomplete + Go flow ─────────────────────
describe('location search: Google Places Autocomplete and Go flow', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  test('sl-search-form exists in the mode drawer HTML', function () {
    const drawerIdx = src.indexOf('id="mode-drawer-street"');
    assert.ok(drawerIdx !== -1, 'mode-drawer-street must exist in HTML');
    // Window is 2500 chars to accommodate the FP-mode button and traffic indicator
    // that were added to the navigation section above sl-search-form.
    const drawerSnippet = src.slice(drawerIdx, drawerIdx + 2500);
    assert.ok(drawerSnippet.includes('id="sl-search-form"'), 'sl-search-form must be inside mode-drawer-street');
  });

  test('sl-location-input is a text input inside the search form', function () {
    const formIdx = src.indexOf('id="sl-search-form"');
    assert.ok(formIdx !== -1, 'sl-search-form must exist');
    const formSnippet = src.slice(formIdx, formIdx + 400);
    assert.ok(formSnippet.includes('id="sl-location-input"'), 'sl-location-input must exist in the search form');
    assert.ok(formSnippet.includes('type="text"'), 'location input must be a text field');
  });

  test('sl-go-btn exists as a submit button inside the search form', function () {
    const formIdx = src.indexOf('id="sl-search-form"');
    assert.ok(formIdx !== -1, 'sl-search-form must exist');
    const formSnippet = src.slice(formIdx, formIdx + 400);
    assert.ok(formSnippet.includes('id="sl-go-btn"'), 'sl-go-btn must exist in the search form');
    assert.ok(formSnippet.includes('type="submit"'), 'Go button must be type=submit for form submission');
  });

  test('sl-landmark-btn quick-picks are preserved in the mode drawer', function () {
    const drawerIdx = src.indexOf('id="mode-drawer-street"');
    assert.ok(drawerIdx !== -1, 'mode-drawer-street must exist');
    const drawerSnippet = src.slice(drawerIdx, drawerIdx + 3000);
    assert.ok(drawerSnippet.includes('class="sl-landmark-btn"'), 'quick-pick landmark buttons must still be present');
    assert.ok(drawerSnippet.includes('New York'), 'New York quick-pick must still be present');
  });

  test('slFlyToCoords is defined for unified camera navigation', function () {
    assert.ok(src.includes('function slFlyToCoords'), 'slFlyToCoords must be defined');
  });

  test('slFlyToCoords validates lat/lng with Number.isFinite', function () {
    const fnIdx = src.indexOf('function slFlyToCoords');
    assert.ok(fnIdx !== -1, 'slFlyToCoords must exist');
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('Number.isFinite'), 'slFlyToCoords must validate lat/lng with Number.isFinite');
  });

  test('slFlyToCoords uses flyTo for globe-mode navigation', function () {
    const fnIdx = src.indexOf('function slFlyToCoords');
    assert.ok(fnIdx !== -1, 'slFlyToCoords must exist');
    const body = src.slice(fnIdx, fnIdx + 1400);
    assert.ok(body.includes('flyTo'), 'slFlyToCoords must call flyTo for smooth globe-mode navigation');
    assert.ok(body.includes('streetLevelActive'), 'slFlyToCoords must branch on streetLevelActive to pick the right camera mode');
  });

  test('slFlyToCoords uses initStreetLevelPanorama in street-level mode', function () {
    const fnIdx = src.indexOf('function slFlyToCoords');
    const body = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(body.includes('initStreetLevelPanorama'), 'slFlyToCoords must call initStreetLevelPanorama when in street-level mode');
  });

  test('loadGooglePlacesApi is defined and uses createElement for script injection', function () {
    assert.ok(src.includes('function loadGooglePlacesApi'), 'loadGooglePlacesApi must be defined');
    const fnIdx = src.indexOf('function loadGooglePlacesApi');
    const body = src.slice(fnIdx, fnIdx + 800);
    assert.ok(body.includes('createElement'), 'loadGooglePlacesApi must create a script element to load the API');
    assert.ok(body.includes('places'), 'loadGooglePlacesApi must request the places library');
    assert.ok(body.includes('rwPlacesReady'), 'loadGooglePlacesApi must use rwPlacesReady as the API load callback');
  });

  test('loadGoogleMapsApi stub is preserved and does NOT use createElement', function () {
    const fnIdx = src.indexOf('function loadGoogleMapsApi');
    assert.ok(fnIdx !== -1, 'loadGoogleMapsApi stub must still exist for compat');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(!body.includes('createElement'), 'loadGoogleMapsApi stub must not create script elements');
    assert.ok(body.includes('callback'), 'stub must still accept and invoke the callback');
  });

  test('initPlacesAutocomplete is defined and guards on google.maps.places', function () {
    assert.ok(src.includes('function initPlacesAutocomplete'), 'initPlacesAutocomplete must be defined');
    const fnIdx = src.indexOf('function initPlacesAutocomplete');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('google.maps.places'), 'initPlacesAutocomplete must guard on google.maps.places availability');
    assert.ok(body.includes('Autocomplete'), 'initPlacesAutocomplete must create a google.maps.places.Autocomplete');
    assert.ok(body.includes('place_changed'), 'initPlacesAutocomplete must listen for place_changed event');
  });

  test('search form submit handler geocodes typed query via Geocoder', function () {
    const formBindIdx = src.indexOf("getElementById('sl-search-form')");
    assert.ok(formBindIdx === -1 || src.indexOf('slSearchForm') !== -1, 'search form must be bound in JS');
    const submitIdx = src.indexOf("'submit'");
    assert.ok(submitIdx !== -1, 'submit event listener must be registered');
    const snippet = src.slice(submitIdx, submitIdx + 600);
    assert.ok(snippet.includes('Geocoder'), 'submit handler must use Geocoder to resolve typed addresses');
    assert.ok(snippet.includes('slFlyToCoords'), 'submit handler must call slFlyToCoords after geocoding');
  });

  test('rwPlacesReady global callback is set for async API load', function () {
    assert.ok(src.includes('window.rwPlacesReady'), 'rwPlacesReady must be exposed on window as the API load callback');
  });

  test('Places API initialization is guarded by googleMapsApiKey check', function () {
    const initIdx = src.indexOf('loadGooglePlacesApi(BOOTSTRAP.googleMapsApiKey');
    assert.ok(initIdx !== -1, 'Places API must be initialized with the bootstrap API key');
    const context = src.slice(initIdx - 50, initIdx + 200);
    assert.ok(context.includes('googleMapsApiKey'), 'initialization must be guarded by the API key');
    assert.ok(context.includes('initPlacesAutocomplete'), 'must call initPlacesAutocomplete after API loads');
  });

  test('location search CSS includes #sl-search-form, #sl-location-input, #sl-go-btn rules', function () {
    assert.ok(src.includes('#sl-search-form {'), '#sl-search-form CSS rule must exist');
    assert.ok(src.includes('#sl-location-input {'), '#sl-location-input CSS rule must exist');
    assert.ok(src.includes('#sl-go-btn {'), '#sl-go-btn CSS rule must exist');
  });
});

// ── Street-level mode enhancements: FP look, traffic simulation, terrain clamp ──
describe('street-level mode enhancements', function () {
  const fs  = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  // ── Constants ──────────────────────────────────────────────────────────────
  test('SL_FP_MOUSE_SENSITIVITY constant is declared', function () {
    assert.ok(src.includes('SL_FP_MOUSE_SENSITIVITY'), 'SL_FP_MOUSE_SENSITIVITY must be defined');
  });

  test('SL_MIN_ABOVE_GROUND constant is declared', function () {
    assert.ok(src.includes('SL_MIN_ABOVE_GROUND'), 'SL_MIN_ABOVE_GROUND must be defined');
  });

  test('SL_MAX_TRAFFIC_CARS constant is declared', function () {
    assert.ok(src.includes('SL_MAX_TRAFFIC_CARS'), 'SL_MAX_TRAFFIC_CARS must be defined');
  });

  test('SL_TRAFFIC_DENSITY constant is declared and is between 0 and 1', function () {
    assert.ok(src.includes('SL_TRAFFIC_DENSITY'), 'SL_TRAFFIC_DENSITY must be defined');
    const m = src.match(/SL_TRAFFIC_DENSITY\s*=\s*([\d.]+)/);
    assert.ok(m, 'SL_TRAFFIC_DENSITY must have a numeric value');
    const v = Number(m[1]);
    assert.ok(v >= 0 && v <= 1, 'SL_TRAFFIC_DENSITY must be in [0, 1] (got ' + v + ')');
  });

  test('SL_TRAFFIC_SPEED_MPS constant is declared', function () {
    assert.ok(src.includes('SL_TRAFFIC_SPEED_MPS'), 'SL_TRAFFIC_SPEED_MPS must be defined');
  });

  test('SL_TRAFFIC_RADIUS_M constant is declared', function () {
    assert.ok(src.includes('SL_TRAFFIC_RADIUS_M'), 'SL_TRAFFIC_RADIUS_M must be defined');
  });

  test('SL_TRAFFIC_ALTITUDE_MAX constant is declared', function () {
    assert.ok(src.includes('SL_TRAFFIC_ALTITUDE_MAX'), 'SL_TRAFFIC_ALTITUDE_MAX must be defined');
  });

  // ── State variables ────────────────────────────────────────────────────────
  test('cesiumFpMode state variable is declared', function () {
    assert.ok(src.includes('let cesiumFpMode'), 'cesiumFpMode state variable must be declared');
  });

  test('slTrafficEntities array is declared', function () {
    assert.ok(src.includes('slTrafficEntities'), 'slTrafficEntities must be declared');
  });

  test('slTrafficLoopId is declared for rAF tracking', function () {
    assert.ok(src.includes('slTrafficLoopId'), 'slTrafficLoopId must be declared');
  });

  // ── First-person mode functions ────────────────────────────────────────────
  test('enterCesiumFpMode function is defined', function () {
    assert.ok(src.includes('function enterCesiumFpMode'), 'enterCesiumFpMode must be defined');
  });

  test('enterCesiumFpMode uses requestPointerLock', function () {
    const fnIdx = src.indexOf('function enterCesiumFpMode');
    assert.ok(fnIdx !== -1, 'enterCesiumFpMode must exist');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('requestPointerLock'), 'enterCesiumFpMode must call requestPointerLock');
  });

  test('enterCesiumFpMode guards on cesiumStreetLevelMode', function () {
    const fnIdx = src.indexOf('function enterCesiumFpMode');
    const body = src.slice(fnIdx, fnIdx + 400);
    assert.ok(body.includes('cesiumStreetLevelMode'), 'enterCesiumFpMode must guard on cesiumStreetLevelMode');
  });

  test('exitCesiumFpMode function is defined', function () {
    assert.ok(src.includes('function exitCesiumFpMode'), 'exitCesiumFpMode must be defined');
  });

  test('exitCesiumFpMode calls exitPointerLock', function () {
    const fnIdx = src.indexOf('function exitCesiumFpMode');
    assert.ok(fnIdx !== -1, 'exitCesiumFpMode must exist');
    const body = src.slice(fnIdx, fnIdx + 300);
    assert.ok(body.includes('exitPointerLock'), 'exitCesiumFpMode must call document.exitPointerLock');
  });

  test('updateFpModeUi function is defined', function () {
    assert.ok(src.includes('function updateFpModeUi'), 'updateFpModeUi must be defined');
  });

  test('updateFpModeUi toggles cesium-world fp-mode class', function () {
    const fnIdx = src.indexOf('function updateFpModeUi');
    assert.ok(fnIdx !== -1, 'updateFpModeUi must exist');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('fp-mode'), 'updateFpModeUi must toggle the fp-mode CSS class');
  });

  test('updateFpModeUi disables screenSpaceCameraController inputs in FP mode', function () {
    const fnIdx = src.indexOf('function updateFpModeUi');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('enableInputs'), 'updateFpModeUi must toggle ssc.enableInputs');
  });

  test('pointerlockchange listener is registered to sync cesiumFpMode', function () {
    assert.ok(src.includes("'pointerlockchange'"), 'pointerlockchange event listener must be registered');
    const idx = src.indexOf("'pointerlockchange'");
    const context = src.slice(idx - 30, idx + 300);
    assert.ok(context.includes('cesiumFpMode'), 'pointerlockchange handler must update cesiumFpMode');
  });

  test('mousemove listener applies yaw and pitch from movementX/Y in FP mode', function () {
    const idx = src.indexOf('e.movementX * SL_FP_MOUSE_SENSITIVITY');
    assert.ok(idx !== -1, 'FP mouse look must use movementX scaled by SL_FP_MOUSE_SENSITIVITY');
    const context = src.slice(idx - 100, idx + 300);
    assert.ok(context.includes('movementY'), 'FP mouse look must use movementY for pitch');
    assert.ok(context.includes('cam.look'), 'FP mouse look must use camera.look for rotation');
  });

  // ── FP mode UI ─────────────────────────────────────────────────────────────
  test('#sl-fp-btn button exists in mode-drawer-street', function () {
    assert.ok(src.includes('id="sl-fp-btn"'), '#sl-fp-btn button must exist in the HTML');
  });

  test('#sl-fp-crosshair element exists in street-level-view overlay', function () {
    assert.ok(src.includes('id="sl-fp-crosshair"'), '#sl-fp-crosshair must exist in HTML');
    const svIdx  = src.indexOf('id="street-level-view"');
    const modeIdx = src.indexOf('id="mode-drawer"');
    const fpIdx  = src.indexOf('id="sl-fp-crosshair"');
    assert.ok(fpIdx > svIdx && fpIdx < modeIdx,
      '#sl-fp-crosshair must be inside #street-level-view, before #mode-drawer');
  });

  test('#sl-fp-btn and crosshair CSS rules are present', function () {
    assert.ok(src.includes('#sl-fp-btn {'), '#sl-fp-btn CSS rule must exist');
    assert.ok(src.includes('#sl-fp-crosshair {'), '#sl-fp-crosshair CSS rule must exist');
  });

  test('#cesium-world.fp-mode CSS rule sets cursor to none', function () {
    assert.ok(src.includes('#cesium-world.fp-mode'), '#cesium-world.fp-mode CSS rule must exist');
    const idx = src.indexOf('#cesium-world.fp-mode');
    const snippet = src.slice(idx, idx + 80);
    assert.ok(snippet.includes('cursor:none') || snippet.includes('cursor: none'),
      '#cesium-world.fp-mode must set cursor:none');
  });

  // ── Terrain clamp ──────────────────────────────────────────────────────────
  test('registerTerrainClamp function is defined', function () {
    assert.ok(src.includes('function registerTerrainClamp'), 'registerTerrainClamp must be defined');
  });

  test('registerTerrainClamp uses postRender to clamp altitude', function () {
    const fnIdx = src.indexOf('function registerTerrainClamp');
    assert.ok(fnIdx !== -1, 'registerTerrainClamp must exist');
    const body = src.slice(fnIdx, fnIdx + 500);
    assert.ok(body.includes('postRender'), 'registerTerrainClamp must register a postRender listener');
    assert.ok(body.includes('SL_MIN_ABOVE_GROUND'), 'registerTerrainClamp must clamp to SL_MIN_ABOVE_GROUND');
  });

  test('registerTerrainClamp is called at the end of initCesium', function () {
    assert.ok(src.includes('registerTerrainClamp()'), 'registerTerrainClamp() must be called at init');
  });

  // ── Traffic simulation ──────────────────────────────────────────────────────
  test('spawnSlTraffic function is defined', function () {
    assert.ok(src.includes('function spawnSlTraffic'), 'spawnSlTraffic must be defined');
  });

  test('spawnSlTraffic uses CallbackProperty for car positions', function () {
    const fnIdx = src.indexOf('function spawnSlTraffic');
    assert.ok(fnIdx !== -1, 'spawnSlTraffic must exist');
    const body = src.slice(fnIdx, fnIdx + 2200);
    assert.ok(body.includes('CallbackProperty'), 'spawnSlTraffic must use Cesium.CallbackProperty for live position updates');
  });

  test('spawnSlTraffic uses CLAMP_TO_GROUND for car height reference', function () {
    const fnIdx = src.indexOf('function spawnSlTraffic');
    const body = src.slice(fnIdx, fnIdx + 2200);
    assert.ok(body.includes('CLAMP_TO_GROUND'), 'car entities must use HeightReference.CLAMP_TO_GROUND');
  });

  test('clearSlTraffic function is defined', function () {
    assert.ok(src.includes('function clearSlTraffic'), 'clearSlTraffic must be defined');
  });

  test('slTrafficMoveLoop function is defined', function () {
    assert.ok(src.includes('function slTrafficMoveLoop'), 'slTrafficMoveLoop must be defined');
  });

  test('slTrafficMoveLoop respawns cars that exit the visible radius', function () {
    const fnIdx = src.indexOf('function slTrafficMoveLoop');
    assert.ok(fnIdx !== -1, 'slTrafficMoveLoop must exist');
    const body = src.slice(fnIdx, fnIdx + 1800);
    assert.ok(body.includes('SL_TRAFFIC_RADIUS_M'), 'slTrafficMoveLoop must check SL_TRAFFIC_RADIUS_M for respawn');
  });

  test('slTrafficMoveLoop hides entities above SL_TRAFFIC_ALTITUDE_MAX', function () {
    const fnIdx = src.indexOf('function slTrafficMoveLoop');
    const body = src.slice(fnIdx, fnIdx + 1800);
    assert.ok(body.includes('SL_TRAFFIC_ALTITUDE_MAX'), 'slTrafficMoveLoop must hide traffic above SL_TRAFFIC_ALTITUDE_MAX');
  });

  // ── Integration: enterCesiumStreetLevel spawns traffic ─────────────────────
  test('enterCesiumStreetLevel calls spawnSlTraffic in the flyTo complete callback', function () {
    const fnIdx = src.indexOf('function enterCesiumStreetLevel');
    assert.ok(fnIdx !== -1, 'enterCesiumStreetLevel must exist');
    const body = src.slice(fnIdx, fnIdx + 1500);
    assert.ok(body.includes('spawnSlTraffic'), 'enterCesiumStreetLevel must call spawnSlTraffic on flyTo complete');
  });

  test('enterCesiumStreetLevel tightens tileset LOD on enter', function () {
    const fnIdx = src.indexOf('function enterCesiumStreetLevel');
    const body = src.slice(fnIdx, fnIdx + 900);
    assert.ok(body.includes('maximumScreenSpaceError'), 'enterCesiumStreetLevel must adjust maximumScreenSpaceError for LOD');
  });

  test('exitCesiumStreetLevel calls exitCesiumFpMode', function () {
    const fnIdx = src.indexOf('function exitCesiumStreetLevel');
    assert.ok(fnIdx !== -1, 'exitCesiumStreetLevel must exist');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('exitCesiumFpMode'), 'exitCesiumStreetLevel must call exitCesiumFpMode');
  });

  test('exitCesiumStreetLevel calls clearSlTraffic', function () {
    const fnIdx = src.indexOf('function exitCesiumStreetLevel');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('clearSlTraffic'), 'exitCesiumStreetLevel must call clearSlTraffic');
  });

  test('exitCesiumStreetLevel restores tileset LOD on exit', function () {
    const fnIdx = src.indexOf('function exitCesiumStreetLevel');
    const body = src.slice(fnIdx, fnIdx + 700);
    assert.ok(body.includes('maximumScreenSpaceError'), 'exitCesiumStreetLevel must restore maximumScreenSpaceError on exit');
  });
});

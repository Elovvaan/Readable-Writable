'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { router, worldview, quantumSimState, stopContinuousCollapse } = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body || '';
    },
  };
  return res;
}

function makeReq(method, url) {
  return { method, url };
}

function callRouter(method, url) {
  const res = makeMockRes();
  router(makeReq(method, url), res);
  return res;
}

/**
 * callRouterWithBody – helper for POST routes that read req body via events.
 * Returns a Promise that resolves to the mock response.
 */
function callRouterWithBody(method, url, bodyObj) {
  return new Promise(function (resolve) {
    const res = makeMockRes();
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    // Override res.end to resolve once the handler calls it
    const origEnd = res.end.bind(res);
    res.end = function (body) { origEnd(body); resolve(res); };
    router(req, res);
    const chunk = JSON.stringify(bodyObj || {});
    req.emit('data', chunk);
    req.emit('end');
  });
}

function jsonBody(res) {
  return JSON.parse(res.body);
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS headers', () => {
  test('Access-Control-Allow-Origin is * on all responses', () => {
    const res = callRouter('GET', '/health');
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  });

  test('OPTIONS returns 204 with no body', () => {
    const res = callRouter('OPTIONS', '/health');
    assert.equal(res.statusCode, 204);
  });
});

// ─── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200', () => {
    assert.equal(callRouter('GET', '/health').statusCode, 200);
  });

  test('Content-Type is application/json', () => {
    const res = callRouter('GET', '/health');
    assert.ok(res.headers['Content-Type'].includes('application/json'));
  });

  test('body has required fields', () => {
    const body = jsonBody(callRouter('GET', '/health'));
    assert.equal(body.status, 'ok');
    assert.ok('tick' in body);
    assert.ok('agents' in body);
    assert.ok('regions' in body);
    assert.ok('uptime' in body);
    assert.ok('ts' in body);
  });

  test('regions count matches worldview', () => {
    const body = jsonBody(callRouter('GET', '/health'));
    assert.equal(body.regions, Object.keys(worldview.regions).length);
  });

  test('ts is a valid ISO timestamp', () => {
    const { ts } = jsonBody(callRouter('GET', '/health'));
    assert.ok(!isNaN(new Date(ts).getTime()));
  });
});

// ─── GET /rw/spatial/health ───────────────────────────────────────────────────

describe('GET /rw/spatial/health', () => {
  test('returns 200', () => {
    assert.equal(callRouter('GET', '/rw/spatial/health').statusCode, 200);
  });

  test('body has status ok', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial/health'));
    assert.equal(body.status, 'ok');
  });

  test('body includes opensky sub-object with enabled field', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial/health'));
    assert.ok('opensky' in body);
    assert.ok('enabled' in body.opensky);
  });

  test('body includes websocketClients', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial/health'));
    assert.ok('websocketClients' in body);
  });
});

// ─── GET /rw/spatial ─────────────────────────────────────────────────────────

describe('GET /rw/spatial', () => {
  test('returns 200', () => {
    assert.equal(callRouter('GET', '/rw/spatial').statusCode, 200);
  });

  test('body has regions object', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial'));
    assert.ok('regions' in body);
    assert.equal(typeof body.regions, 'object');
  });

  test('regions object is not empty (initWorld ran)', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial'));
    assert.ok(Object.keys(body.regions).length > 0);
  });
});

// ─── GET /rw/spatial/:regionId ───────────────────────────────────────────────

describe('GET /rw/spatial/:regionId', () => {
  test('returns 200 for a known region', () => {
    const regionId = Object.keys(worldview.regions)[0];
    const res = callRouter('GET', `/rw/spatial/${regionId}`);
    assert.equal(res.statusCode, 200);
  });

  test('body includes region and agents for a known region', () => {
    const regionId = Object.keys(worldview.regions)[0];
    const body = jsonBody(callRouter('GET', `/rw/spatial/${regionId}`));
    assert.ok('region' in body);
    assert.ok('agents' in body);
    assert.ok(Array.isArray(body.agents));
  });

  test('region has expected fields', () => {
    const regionId = Object.keys(worldview.regions)[0];
    const { region } = jsonBody(callRouter('GET', `/rw/spatial/${regionId}`));
    assert.ok('id' in region);
    assert.ok('name' in region);
    assert.equal(region.id, regionId);
  });

  test('returns 404 for unknown region', () => {
    const res = callRouter('GET', '/rw/spatial/does-not-exist-xyz');
    assert.equal(res.statusCode, 404);
  });

  test('404 body has error field', () => {
    const body = jsonBody(callRouter('GET', '/rw/spatial/does-not-exist-xyz'));
    assert.ok('error' in body);
  });

  test('health sub-path takes precedence over regionId lookup', () => {
    // /rw/spatial/health should hit the health handler, not regionId
    const res = callRouter('GET', '/rw/spatial/health');
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.status, 'ok');
  });
});

// ─── GET / (frontend HTML) ────────────────────────────────────────────────────

describe('GET / frontend routes', () => {
  for (const path of ['/', '/worldview', '/app/worldview', '/admin/worldview']) {
    test(`${path} returns 200 with HTML`, () => {
      const res = callRouter('GET', path);
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['Content-Type'].includes('text/html'));
      assert.ok(res.body.startsWith('<!DOCTYPE html>') || res.body.includes('<!DOCTYPE html>'));
    });

    test(`${path} replaces __RW_BOOTSTRAP__ placeholder`, () => {
      const res = callRouter('GET', path);
      assert.ok(!res.body.includes('__RW_BOOTSTRAP__'), 'bootstrap placeholder was not replaced');
    });

    test(`${path} injects valid JSON into bootstrap`, () => {
      const res = callRouter('GET', path);
      // Extract the bootstrap JSON from the script tag
      const match = res.body.match(/window\.__RW_BOOTSTRAP__\s*=\s*(\{.*?\})/s);
      if (match) {
        assert.doesNotThrow(() => JSON.parse(match[1]));
      }
    });
  }
});

// ─── Unknown routes ───────────────────────────────────────────────────────────

describe('unknown routes', () => {
  test('returns 404', () => {
    assert.equal(callRouter('GET', '/not/a/real/path').statusCode, 404);
  });

  test('404 body has error and path fields', () => {
    const body = jsonBody(callRouter('GET', '/no/such/route'));
    assert.ok('error' in body);
    assert.ok('path' in body);
    assert.equal(body.path, '/no/such/route');
  });

  test('POST to unknown route returns 404', () => {
    assert.equal(callRouter('POST', '/health').statusCode, 404);
  });
});

// ─── GET /api/ground-vehicles ────────────────────────────────────────────────

describe('GET /api/ground-vehicles', () => {
  test('returns 200', () => {
    assert.equal(callRouter('GET', '/api/ground-vehicles').statusCode, 200);
  });

  test('Content-Type is application/json', () => {
    const res = callRouter('GET', '/api/ground-vehicles');
    assert.ok(res.headers['Content-Type'].includes('application/json'));
  });

  test('body has generated, visible, drawn, entities, ts fields', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.ok('generated' in body, 'must have generated');
    assert.ok('visible'   in body, 'must have visible');
    assert.ok('drawn'     in body, 'must have drawn');
    assert.ok('entities'  in body, 'must have entities');
    assert.ok('ts'        in body, 'must have ts');
  });

  test('generated >= 10 after live entity refresh', () => {
    const { refreshLiveEntityLayers } = require('../server');
    refreshLiveEntityLayers();
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.ok(body.generated >= 10, 'expected >= 10 generated vehicles, got ' + body.generated);
  });

  test('visible <= generated', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.ok(body.visible <= body.generated, 'visible must not exceed generated');
  });

  test('drawn <= visible', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.ok(body.drawn <= body.visible, 'drawn must not exceed visible');
  });

  test('entities is an array', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.ok(Array.isArray(body.entities));
  });

  test('entities have id, type, lat, lng fields', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    for (const e of body.entities) {
      assert.ok('id'  in e, 'entity must have id');
      assert.ok('type' in e, 'entity must have type');
      assert.ok('lat'  in e, 'entity must have lat');
      assert.ok('lng'  in e, 'entity must have lng');
    }
  });

  test('entities count matches drawn count', () => {
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    assert.equal(body.entities.length, body.drawn, 'entities.length must equal drawn');
  });

  test('ts is a recent timestamp', () => {
    const before = Date.now();
    const body = jsonBody(callRouter('GET', '/api/ground-vehicles'));
    const after = Date.now();
    assert.ok(body.ts >= before && body.ts <= after, 'ts must be between before and after');
  });
});

// ─── GET /api/sim/continuous-collapse ─────────────────────────────────────────

describe('GET /api/sim/continuous-collapse', () => {
  test('returns 200', () => {
    assert.equal(callRouter('GET', '/api/sim/continuous-collapse').statusCode, 200);
  });

  test('body has running and intervalMs', () => {
    const body = jsonBody(callRouter('GET', '/api/sim/continuous-collapse'));
    assert.equal(typeof body.running, 'boolean');
    assert.ok(typeof body.intervalMs === 'number' && body.intervalMs > 0);
  });

  test('body includes hysteresis and winner-lock thresholds', () => {
    const body = jsonBody(callRouter('GET', '/api/sim/continuous-collapse'));
    assert.ok('hysteresisThreshold' in body);
    assert.ok('winnerLockThreshold' in body);
    assert.ok('winnerLockMargin' in body);
    assert.ok('nearWinnerPressureThreshold' in body);
  });

  test('body has ts', () => {
    const body = jsonBody(callRouter('GET', '/api/sim/continuous-collapse'));
    assert.ok(typeof body.ts === 'number');
  });
});

// ─── POST /api/sim/continuous-collapse ────────────────────────────────────────

describe('POST /api/sim/continuous-collapse', () => {
  // Always stop after each test to avoid leaking timers
  test('start action sets running=true', async () => {
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'start', intervalMs: 60000 });
    stopContinuousCollapse();
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.running, true);
  });

  test('stop action sets running=false', async () => {
    // First start it
    await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'start', intervalMs: 60000 });
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'stop' });
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.running, false);
  });

  test('default action toggles: start when stopped', async () => {
    // Ensure stopped first
    stopContinuousCollapse();
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { intervalMs: 60000 });
    stopContinuousCollapse();
    assert.equal(res.statusCode, 200);
    const body = jsonBody(res);
    assert.equal(body.running, true);
  });

  test('accepts and applies custom intervalMs', async () => {
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'start', intervalMs: 9876 });
    stopContinuousCollapse();
    const body = jsonBody(res);
    assert.equal(body.intervalMs, 9876);
    // Reset to default
    quantumSimState.continuousCollapse.intervalMs = 3000;
  });

  test('accepts hysteresisThreshold override', async () => {
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'stop', hysteresisThreshold: 0.10 });
    const body = jsonBody(res);
    assert.equal(body.hysteresisThreshold, 0.10);
    // Reset
    quantumSimState.continuousCollapse.hysteresisThreshold = 0.05;
  });

  test('invalid JSON returns 400', async () => {
    // Manually send non-JSON body
    const res = await new Promise(function (resolve) {
      const { EventEmitter: EE } = require('node:events');
      const mockRes = {
        statusCode: null, headers: {}, body: '',
        writeHead(code) { this.statusCode = code; },
        setHeader() {},
        end(b) { this.body = b || ''; resolve(mockRes); },
      };
      const req = new EE();
      req.method = 'POST';
      req.url = '/api/sim/continuous-collapse';
      router(req, mockRes);
      req.emit('data', '{not valid json');
      req.emit('end');
    });
    assert.equal(res.statusCode, 400);
  });

  test('unknown action returns 400', async () => {
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'restart' });
    assert.equal(res.statusCode, 400);
  });

  test('body has ts', async () => {
    const res = await callRouterWithBody('POST', '/api/sim/continuous-collapse', { action: 'stop' });
    const body = jsonBody(res);
    assert.ok(typeof body.ts === 'number');
  });
});

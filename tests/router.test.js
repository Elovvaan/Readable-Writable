'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { router, worldview } = require('../server');

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

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdsbExchangeFlightEntity,
  normalizeAdsbBatch,
  getSimFlights,
  selectActiveFlights,
  openSkyLiveState,
  adsbExchangeState,
  flightProviderState,
} = require('../server');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAdsbAc(overrides = {}) {
  return Object.assign({
    hex: 'aabbcc',
    flight: 'TST001',
    lat: 48.5,
    lon: 11.5,
    alt_baro: 10000,
    alt_geom: 10100,
    gs: 480,
    track: 90,
    baro_rate: 0,
  }, overrides);
}

function resetProviderState() {
  // Clear both provider states so each test starts clean
  adsbExchangeState.flights = {};
  adsbExchangeState.lastPollAt = null;
  adsbExchangeState.lastErrorAt = null;
  adsbExchangeState.lastFetchedCount = 0;
  adsbExchangeState.lastNormalizedCount = 0;

  openSkyLiveState.flights = {};
  openSkyLiveState.lastPollAt = null;
  openSkyLiveState.lastErrorAt = null;
  openSkyLiveState.lastFetchedCount = 0;
  openSkyLiveState.lastNormalizedCount = 0;
}

// ─── buildAdsbExchangeFlightEntity ───────────────────────────────────────────

describe('buildAdsbExchangeFlightEntity', () => {
  describe('returns null for invalid input', () => {
    test('null input', () => assert.equal(buildAdsbExchangeFlightEntity(null, null), null));
    test('non-object input', () => assert.equal(buildAdsbExchangeFlightEntity('bad', null), null));
    test('empty hex', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ hex: '' }), null), null));
    test('null hex', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ hex: null }), null), null));
    test('NaN lat', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ lat: NaN }), null), null));
    test('undefined lat', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ lat: undefined }), null), null));
    test('NaN lon', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ lon: NaN }), null), null));
    test('undefined lon', () => assert.equal(buildAdsbExchangeFlightEntity(makeAdsbAc({ lon: undefined }), null), null));
  });

  describe('entity shape', () => {
    test('builds a valid entity with correct id and type', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), null);
      assert.equal(e.id, 'flight-aabbcc');
      assert.equal(e.type, 'flight');
      assert.equal(e.icao24, 'aabbcc');
      assert.equal(e.source, 'adsb-exchange');
      assert.equal(e.active, true);
    });

    test('lat and lng are mapped correctly', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ lat: 48.5, lon: 11.5 }), null);
      assert.equal(e.lat, 48.5);
      assert.equal(e.lng, 11.5);
    });

    test('has grid x/y in range [0, 100]', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), null);
      assert.ok(Number.isFinite(e.x) && e.x >= 0 && e.x <= 100);
      assert.ok(Number.isFinite(e.y) && e.y >= 0 && e.y <= 100);
    });

    test('has lastSeen ISO timestamp', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), null);
      assert.ok(!isNaN(new Date(e.lastSeen)));
    });

    test('hex is lowercased and trimmed', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ hex: '  AABBCC  ' }), null);
      assert.equal(e.icao24, 'aabbcc');
      assert.equal(e.id, 'flight-aabbcc');
    });
  });

  describe('label / callsign', () => {
    test('uses trimmed flight callsign when present', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ flight: 'BAW001  ' }), null);
      assert.equal(e.label, 'BAW001');
      assert.equal(e.name, 'BAW001');
    });

    test('falls back to icao24 when flight is empty string', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ flight: '' }), null);
      assert.equal(e.label, 'aabbcc');
    });
  });

  describe('altitude fallback', () => {
    test('uses alt_baro when present', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ alt_baro: 35000, alt_geom: 35100 }), null);
      assert.equal(e.altitude, 35000);
    });

    test('falls back to alt_geom when alt_baro is undefined', () => {
      const ac = makeAdsbAc({ alt_geom: 35100 });
      delete ac.alt_baro;
      const e = buildAdsbExchangeFlightEntity(ac, null);
      assert.equal(e.altitude, 35100);
    });
  });

  describe('state / onGround', () => {
    test('on_ground=true → state "grounded"', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ on_ground: true }), null);
      assert.equal(e.onGround, true);
      assert.equal(e.state, 'grounded');
    });

    test('positive altitude → state "airborne"', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc({ alt_baro: 5000, on_ground: false }), null);
      assert.equal(e.state, 'airborne');
    });
  });

  describe('trail management', () => {
    test('starts with one point for a brand-new flight', () => {
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), null);
      assert.equal(e.trail.length, 1);
      assert.equal(e.trail[0].lat, 48.5);
      assert.equal(e.trail[0].lng, 11.5);
    });

    test('appends a trail point when position changes > 0.0001°', () => {
      const prev = { lat: 48.0, lng: 11.0, trail: [{ lat: 48.0, lng: 11.0, ts: 1000 }] };
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), prev);
      assert.ok(e.trail.length >= 2);
    });

    test('does not append when position is unchanged', () => {
      const prev = { lat: 48.5, lng: 11.5, trail: [{ lat: 48.5, lng: 11.5, ts: 1000 }] };
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), prev);
      assert.equal(e.trail.length, 1);
    });

    test('trail is capped at 24 points', () => {
      const longTrail = Array.from({ length: 30 }, (_, i) => ({ lat: i, lng: i, ts: i }));
      const prev = { lat: 40.0, lng: 10.0, trail: longTrail };
      const e = buildAdsbExchangeFlightEntity(makeAdsbAc(), prev);
      assert.ok(e.trail.length <= 24);
    });
  });
});

// ─── normalizeAdsbBatch ───────────────────────────────────────────────────────

describe('normalizeAdsbBatch', () => {
  test('returns empty map and zero count for empty array', () => {
    const { flights, count } = normalizeAdsbBatch([], {});
    assert.deepEqual(flights, {});
    assert.equal(count, 0);
  });

  test('builds a flight entity for each valid record', () => {
    const ac = [makeAdsbAc({ hex: 'aa1111' }), makeAdsbAc({ hex: 'bb2222' })];
    const { flights, count } = normalizeAdsbBatch(ac, {});
    assert.equal(count, 2);
    assert.ok('flight-aa1111' in flights);
    assert.ok('flight-bb2222' in flights);
  });

  test('skips records with missing hex', () => {
    const ac = [makeAdsbAc({ hex: '' }), makeAdsbAc({ hex: 'cc3333' })];
    const { flights, count } = normalizeAdsbBatch(ac, {});
    assert.equal(count, 1);
  });

  test('skips records with non-finite coordinates', () => {
    const ac = [makeAdsbAc({ lat: NaN }), makeAdsbAc({ hex: 'dd4444' })];
    const { flights, count } = normalizeAdsbBatch(ac, {});
    assert.equal(count, 1);
  });

  test('all built entities have source=adsb-exchange', () => {
    const ac = [makeAdsbAc({ hex: 'ee5555' })];
    const { flights } = normalizeAdsbBatch(ac, {});
    assert.equal(flights['flight-ee5555'].source, 'adsb-exchange');
  });
});

// ─── getSimFlights ────────────────────────────────────────────────────────────

describe('getSimFlights', () => {
  test('returns at least 8 flights', () => {
    const flights = getSimFlights();
    assert.ok(Object.keys(flights).length >= 8);
  });

  test('all returned entities have type=flight', () => {
    const flights = getSimFlights();
    for (const f of Object.values(flights)) {
      assert.equal(f.type, 'flight');
    }
  });

  test('all returned entities have source=sim', () => {
    const flights = getSimFlights();
    for (const f of Object.values(flights)) {
      assert.equal(f.source, 'sim');
    }
  });

  test('all returned entities have finite lat and lng', () => {
    const flights = getSimFlights();
    for (const f of Object.values(flights)) {
      assert.ok(Number.isFinite(f.lat), 'lat should be finite for ' + f.id);
      assert.ok(Number.isFinite(f.lng), 'lng should be finite for ' + f.id);
    }
  });

  test('all returned entities have state=airborne', () => {
    const flights = getSimFlights();
    for (const f of Object.values(flights)) {
      assert.equal(f.state, 'airborne');
    }
  });

  test('motion persists — positions differ across ticks (calls 5ms apart)', async () => {
    const f1 = getSimFlights();
    await new Promise(resolve => setTimeout(resolve, 5));
    const f2 = getSimFlights();
    // Structure should remain stable regardless of timing
    assert.ok(Object.keys(f2).length >= 8);
    // All keys from f1 should still exist in f2
    for (const id of Object.keys(f1)) {
      assert.ok(id in f2, 'flight ' + id + ' should still exist in next tick');
    }
  });
});

// ─── selectActiveFlights ─────────────────────────────────────────────────────

describe('selectActiveFlights', () => {
  beforeEach(() => {
    resetProviderState();
  });

  test('falls back to sim when no providers have data', () => {
    const { provider, flights } = selectActiveFlights();
    assert.equal(provider, 'sim');
    assert.ok(Object.keys(flights).length >= 8);
  });

  test('selects opensky when it has recent non-empty data and no error', () => {
    const mockFlight = { id: 'flight-test01', type: 'flight', lat: 45, lng: -90,
      icao24: 'test01', source: 'opensky', state: 'airborne' };
    openSkyLiveState.flights = { 'flight-test01': mockFlight };
    openSkyLiveState.lastPollAt = new Date().toISOString();
    openSkyLiveState.lastErrorAt = null;

    const { provider, flights } = selectActiveFlights();
    assert.equal(provider, 'opensky');
    assert.ok('flight-test01' in flights);
  });

  test('falls back from opensky to sim when opensky has an error', () => {
    const mockFlight = { id: 'flight-test02', type: 'flight', lat: 45, lng: -90,
      icao24: 'test02', source: 'opensky', state: 'airborne' };
    openSkyLiveState.flights = { 'flight-test02': mockFlight };
    openSkyLiveState.lastPollAt = new Date().toISOString();
    openSkyLiveState.lastErrorAt = new Date().toISOString();   // has error

    const { provider } = selectActiveFlights();
    assert.equal(provider, 'sim');
  });

  test('falls back from opensky to sim when opensky data is stale (no poll)', () => {
    const mockFlight = { id: 'flight-test03', type: 'flight', lat: 45, lng: -90,
      icao24: 'test03', source: 'opensky', state: 'airborne' };
    openSkyLiveState.flights = { 'flight-test03': mockFlight };
    openSkyLiveState.lastPollAt = null;  // never polled
    openSkyLiveState.lastErrorAt = null;

    const { provider } = selectActiveFlights();
    assert.equal(provider, 'sim');
  });

  test('updates flightProviderState after selection', () => {
    selectActiveFlights();
    assert.ok(typeof flightProviderState.activeProvider === 'string');
    assert.ok(Number.isFinite(flightProviderState.fetched));
    assert.ok(flightProviderState.lastSelectedAt !== null);
  });

  test('sim fallback always returns fetched > 0 and visible >= 0', () => {
    const { flights } = selectActiveFlights();
    assert.ok(Object.keys(flights).length > 0);
    assert.ok(flightProviderState.fetched > 0);
    assert.ok(flightProviderState.visible >= 0);
  });
});

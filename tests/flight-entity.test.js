'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOpenSkyFlightEntity,
  countVisibleOpenSkyFlights,
  resolveClosestRegion,
  worldview,
} = require('../server');

// Build a minimal valid OpenSky state vector row.
// Indices: [icao24, callsign, origin_country, time_position, last_contact,
//           lng(5), lat(6), baro_alt(7), on_ground(8), velocity(9),
//           heading(10), vertical_rate(11), sensors(12), geo_alt(13)]
function makeRow(overrides = {}) {
  const row = ['abc123', 'TEST01', 'US', 1700000000, 1700000000,
               -73.5, 40.7, 10000, false, 250, 90, 0, null, 10100];
  for (const [i, v] of Object.entries(overrides)) row[Number(i)] = v;
  return row;
}

// ─── buildOpenSkyFlightEntity ─────────────────────────────────────────────────

describe('buildOpenSkyFlightEntity', () => {
  describe('returns null for invalid input', () => {
    test('null row', () => assert.equal(buildOpenSkyFlightEntity(null, null), null));
    test('string row', () => assert.equal(buildOpenSkyFlightEntity('bad', null), null));
    test('object row', () => assert.equal(buildOpenSkyFlightEntity({}, null), null));
    test('empty string icao24', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 0: '' }), null), null));
    test('null icao24', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 0: null }), null), null));
    // null coerces to 0 via safeNumber (Number(null)===0), so null lat/lng is treated as 0°
    // NaN and undefined are non-finite and cause an early null return
    test('NaN lat', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 6: NaN }), null), null));
    test('undefined lat', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 6: undefined }), null), null));
    test('NaN lng', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 5: NaN }), null), null));
    test('undefined lng', () => assert.equal(buildOpenSkyFlightEntity(makeRow({ 5: undefined }), null), null));
  });

  describe('entity shape', () => {
    test('builds a valid entity with correct id and type', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.equal(e.id, 'flight-abc123');
      assert.equal(e.type, 'flight');
      assert.equal(e.icao24, 'abc123');
      assert.equal(e.source, 'opensky');
      assert.equal(e.active, true);
    });

    test('lat and lng are set correctly', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.equal(e.lat, 40.7);
      assert.equal(e.lng, -73.5);
    });

    test('has lastSeen ISO timestamp', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.doesNotThrow(() => new Date(e.lastSeen));
      assert.ok(!isNaN(new Date(e.lastSeen)));
    });

    test('has grid x/y in range [0, 100]', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.ok(Number.isFinite(e.x) && e.x >= 0 && e.x <= 100);
      assert.ok(Number.isFinite(e.y) && e.y >= 0 && e.y <= 100);
    });
  });

  describe('label/name fallback', () => {
    test('uses callsign when present', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.equal(e.label, 'TEST01');
      assert.equal(e.name, 'TEST01');
    });

    test('falls back to icao24 when callsign is empty string', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 1: '' }), null);
      assert.equal(e.label, 'abc123');
      assert.equal(e.name, 'abc123');
    });

    test('icao24 is lowercased and trimmed', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 0: '  ABC123  ' }), null);
      assert.equal(e.icao24, 'abc123');
      assert.equal(e.id, 'flight-abc123');
    });
  });

  describe('on_ground / state', () => {
    test('onGround=true → state "grounded"', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 8: true }), null);
      assert.equal(e.onGround, true);
      assert.equal(e.state, 'grounded');
    });

    test('onGround=false → state "airborne"', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 8: false }), null);
      assert.equal(e.onGround, false);
      assert.equal(e.state, 'airborne');
    });
  });

  describe('altitude fallback', () => {
    test('uses row[7] (baro_alt) when present', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 7: 11000, 13: 9500 }), null);
      assert.equal(e.altitude, 11000);
    });

    test('falls back to row[13] (geo_alt) when row[7] is null', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 7: null, 13: 9500 }), null);
      assert.equal(e.altitude, 9500);
    });

    test('altitude is 0 when both row[7] and row[13] are null (null coerces to 0)', () => {
      const e = buildOpenSkyFlightEntity(makeRow({ 7: null, 13: null }), null);
      assert.equal(e.altitude, 0);
    });
  });

  describe('prevLat / prevLng', () => {
    test('null when no previous entity', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.equal(e.prevLat, null);
      assert.equal(e.prevLng, null);
    });

    test('carries lat/lng from previous entity', () => {
      const prev = { lat: 40.6, lng: -73.4, trail: [] };
      const e = buildOpenSkyFlightEntity(makeRow(), prev);
      assert.equal(e.prevLat, 40.6);
      assert.equal(e.prevLng, -73.4);
    });

    test('null when previous entity has non-finite lat', () => {
      const prev = { lat: NaN, lng: -73.4, trail: [] };
      const e = buildOpenSkyFlightEntity(makeRow(), prev);
      assert.equal(e.prevLat, null);
    });
  });

  describe('trail management', () => {
    test('starts with one point for a brand-new flight (no previous)', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.equal(e.trail.length, 1);
      assert.equal(e.trail[0].lat, 40.7);
      assert.equal(e.trail[0].lng, -73.5);
    });

    test('appends a point when position has moved > 0.0001°', () => {
      const prev = { lat: 40.6, lng: -73.4, trail: [{ lat: 40.6, lng: -73.4, ts: 1000 }] };
      const e = buildOpenSkyFlightEntity(makeRow(), prev);
      assert.ok(e.trail.length >= 2);
    });

    test('does not append when position is unchanged (within 0.0001°)', () => {
      const prev = { lat: 40.7, lng: -73.5, trail: [{ lat: 40.7, lng: -73.5, ts: 1000 }] };
      const e = buildOpenSkyFlightEntity(makeRow(), prev);
      assert.equal(e.trail.length, 1);
    });

    test('trail is capped at 24 points', () => {
      const longTrail = Array.from({ length: 30 }, (_, i) => ({ lat: i, lng: i, ts: i }));
      const prev = { lat: 40.0, lng: -73.0, trail: longTrail };
      const e = buildOpenSkyFlightEntity(makeRow(), prev);
      assert.ok(e.trail.length <= 24);
    });

    test('each trail point has lat, lng, ts', () => {
      const e = buildOpenSkyFlightEntity(makeRow(), null);
      assert.ok('lat' in e.trail[0]);
      assert.ok('lng' in e.trail[0]);
      assert.ok('ts' in e.trail[0]);
    });
  });
});

// ─── countVisibleOpenSkyFlights ───────────────────────────────────────────────

describe('countVisibleOpenSkyFlights', () => {
  test('returns zeros for empty object', () => {
    assert.deepEqual(countVisibleOpenSkyFlights({}, 0), { passProjection: 0, passMinZ: 0 });
  });

  test('returns zeros for null', () => {
    assert.deepEqual(countVisibleOpenSkyFlights(null, 0), { passProjection: 0, passMinZ: 0 });
  });

  test('skips flights with invalid lat/lng', () => {
    const flights = {
      a: { lat: null, lng: null },
      b: { lat: NaN, lng: 0 },
      c: { lat: 0, lng: NaN },
    };
    const r = countVisibleOpenSkyFlights(flights, -2);
    assert.equal(r.passProjection, 0);
    assert.equal(r.passMinZ, 0);
  });

  test('counts flights with valid lat/lng', () => {
    const flights = {
      a: { lat: 45, lng: -122 },
      b: { lat: 51, lng: -0.1 },
    };
    const r = countVisibleOpenSkyFlights(flights, -2);
    assert.equal(r.passProjection, 2);
  });

  test('filters by minZ: front-facing (lng≈0) passes, back-facing (lng≈180) fails at minZ=0', () => {
    const flights = {
      front: { lat: 0, lng: 0 },    // z ≈ +1
      back:  { lat: 0, lng: 180 },  // z ≈ -1
    };
    const r = countVisibleOpenSkyFlights(flights, 0);
    assert.equal(r.passProjection, 2);
    assert.equal(r.passMinZ, 1);
  });

  test('non-finite minZ passes all flights that have a vector', () => {
    const flights = {
      a: { lat: 0, lng: 0 },
      b: { lat: 0, lng: 180 },
    };
    const r = countVisibleOpenSkyFlights(flights, NaN);
    assert.equal(r.passProjection, 2);
    assert.equal(r.passMinZ, 2);
  });
});

// ─── resolveClosestRegion ─────────────────────────────────────────────────────

describe('resolveClosestRegion', () => {
  test('returns null for entity without lat/lng', () => {
    // worldview.regions is populated by initWorld() at module load
    const result = resolveClosestRegion({ x: 50, y: 50 });
    assert.equal(result, null);
  });

  test('returns a region id for entity with lat/lng', () => {
    const entity = { lat: 45, lng: -100 }; // near North America
    const result = resolveClosestRegion(entity);
    assert.ok(typeof result === 'string' && result.length > 0);
    assert.ok(result in worldview.regions);
  });

  test('returns "north-america" for a coordinate clearly in North America', () => {
    const entity = { lat: 45, lng: -102 };
    assert.equal(resolveClosestRegion(entity), 'north-america');
  });

  test('returns "europe" for a coordinate clearly in Europe', () => {
    const entity = { lat: 52, lng: 15 };
    assert.equal(resolveClosestRegion(entity), 'europe');
  });
});

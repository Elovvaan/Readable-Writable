'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  safeNumber,
  hasLatLng,
  latLngToGrid,
  getGlobeUnitVectorFromLatLng,
  normalizeEntityGridPosition,
  uid,
} = require('../src/core');

describe('src/core geo utilities', () => {
  test('safeNumber matches existing server contract', () => {
    assert.equal(safeNumber('3.14'), 3.14);
    assert.equal(safeNumber(null), 0);
    assert.equal(safeNumber(''), 0);
    assert.equal(safeNumber(undefined), null);
    assert.equal(safeNumber('abc'), null);
    assert.equal(safeNumber(Infinity), null);
  });

  test('hasLatLng accepts only finite coordinate pairs', () => {
    assert.equal(hasLatLng({ lat: 0, lng: 0 }), true);
    assert.equal(hasLatLng({ lat: NaN, lng: 0 }), false);
    assert.equal(hasLatLng({ lat: 0, lng: Infinity }), false);
    assert.equal(hasLatLng(null), false);
  });

  test('latLngToGrid maps and clamps coordinates', () => {
    assert.deepEqual(latLngToGrid(0, 0), { x: 50, y: 50 });
    assert.equal(latLngToGrid(90, 0).y, 0);
    assert.equal(latLngToGrid(-90, 0).y, 100);
    assert.equal(latLngToGrid(0, -180).x, 0);
    assert.equal(latLngToGrid(0, 180).x, 100);
    assert.equal(latLngToGrid(100, 200).x, 100);
    assert.equal(latLngToGrid(100, 200).y, 0);
  });

  test('getGlobeUnitVectorFromLatLng returns normalized vectors', () => {
    const v00 = getGlobeUnitVectorFromLatLng(0, 0);
    assert.ok(v00);
    assert.ok(Math.abs(v00.x - 0) < 1e-10);
    assert.ok(Math.abs(v00.y - 0) < 1e-10);
    assert.ok(Math.abs(v00.z - 1) < 1e-10);

    const v090 = getGlobeUnitVectorFromLatLng(0, 90);
    assert.ok(v090);
    assert.ok(Math.abs(v090.x - 1) < 1e-10);
    assert.ok(Math.abs(v090.z - 0) < 1e-10);

    for (const [lat, lng] of [[0, 0], [45, 90], [-33, 151], [90, 0], [-90, 0]]) {
      const v = getGlobeUnitVectorFromLatLng(lat, lng);
      const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      assert.ok(Math.abs(mag - 1) < 1e-10, `magnitude=${mag}`);
    }

    // Out-of-range values should be clamped (matching server behavior)
    assert.deepEqual(getGlobeUnitVectorFromLatLng(100, 0), getGlobeUnitVectorFromLatLng(90, 0));
    assert.deepEqual(getGlobeUnitVectorFromLatLng(0, 200), getGlobeUnitVectorFromLatLng(0, 180));

    assert.equal(getGlobeUnitVectorFromLatLng(NaN, 0), null);
    assert.equal(getGlobeUnitVectorFromLatLng(0, Infinity), null);
    assert.equal(getGlobeUnitVectorFromLatLng(null, null), null);
  });

  test('normalizeEntityGridPosition mutates only entities with valid lat/lng', () => {
    const entity = { lat: 0, lng: 0 };
    normalizeEntityGridPosition(entity);
    assert.equal(entity.x, 50);
    assert.equal(entity.y, 50);

    const existing = { lat: NaN, lng: 0, x: 5, y: 5 };
    normalizeEntityGridPosition(existing);
    assert.equal(existing.x, 5);
    assert.equal(existing.y, 5);

    assert.doesNotThrow(() => normalizeEntityGridPosition(null));
  });
});

describe('src/core id utilities', () => {
  test('uid preserves prefix and produces lowercase hex suffixes', () => {
    const id = uid('agent');
    assert.match(id, /^agent-[0-9a-f]{8}$/);
  });

  test('uid generates unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uid('x')));
    assert.equal(ids.size, 200);
  });
});

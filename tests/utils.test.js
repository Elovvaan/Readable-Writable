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
} = require('../server');

// ─── safeNumber ──────────────────────────────────────────────────────────────

describe('safeNumber', () => {
  test('converts numeric strings', () => {
    assert.equal(safeNumber('3.14'), 3.14);
    assert.equal(safeNumber('0'), 0);
    assert.equal(safeNumber('-42'), -42);
  });

  test('passes through finite numbers', () => {
    assert.equal(safeNumber(3.14), 3.14);
    assert.equal(safeNumber(0), 0);
  });

  test('null coerces to 0 (Number(null) === 0)', () => {
    assert.equal(safeNumber(null), 0);
  });

  test('returns null for undefined', () => {
    assert.equal(safeNumber(undefined), null);
  });

  test('empty string coerces to 0 (Number("") === 0)', () => {
    assert.equal(safeNumber(''), 0);
  });

  test('returns null for non-numeric string', () => {
    assert.equal(safeNumber('abc'), null);
  });

  test('returns null for NaN', () => {
    assert.equal(safeNumber(NaN), null);
  });

  test('returns null for Infinity', () => {
    assert.equal(safeNumber(Infinity), null);
    assert.equal(safeNumber(-Infinity), null);
  });
});

// ─── hasLatLng ───────────────────────────────────────────────────────────────

describe('hasLatLng', () => {
  test('returns true for valid finite coordinates', () => {
    assert.equal(hasLatLng({ lat: 0, lng: 0 }), true);
    assert.equal(hasLatLng({ lat: 45.5, lng: -122.3 }), true);
    assert.equal(hasLatLng({ lat: -90, lng: 180 }), true);
  });

  test('returns falsy for null or undefined entity', () => {
    assert.ok(!hasLatLng(null));
    assert.ok(!hasLatLng(undefined));
  });

  test('returns false when lat or lng is missing', () => {
    assert.equal(hasLatLng({}), false);
    assert.equal(hasLatLng({ lat: 45 }), false);
    assert.equal(hasLatLng({ lng: 90 }), false);
  });

  test('returns false when lat or lng is null', () => {
    assert.equal(hasLatLng({ lat: null, lng: 0 }), false);
    assert.equal(hasLatLng({ lat: 45, lng: null }), false);
  });

  test('returns false when lat or lng is NaN', () => {
    assert.equal(hasLatLng({ lat: NaN, lng: 0 }), false);
    assert.equal(hasLatLng({ lat: 45, lng: NaN }), false);
  });

  test('returns false when lat or lng is Infinity', () => {
    assert.equal(hasLatLng({ lat: Infinity, lng: 0 }), false);
    assert.equal(hasLatLng({ lat: 0, lng: -Infinity }), false);
  });
});

// ─── latLngToGrid ─────────────────────────────────────────────────────────────

describe('latLngToGrid', () => {
  test('maps (0, 0) to (x=50, y=50)', () => {
    const { x, y } = latLngToGrid(0, 0);
    assert.equal(x, 50);
    assert.equal(y, 50);
  });

  test('maps north pole (lat=90) to y=0', () => {
    assert.equal(latLngToGrid(90, 0).y, 0);
  });

  test('maps south pole (lat=-90) to y=100', () => {
    assert.equal(latLngToGrid(-90, 0).y, 100);
  });

  test('maps lng=-180 to x=0', () => {
    assert.equal(latLngToGrid(0, -180).x, 0);
  });

  test('maps lng=180 to x=100', () => {
    assert.equal(latLngToGrid(0, 180).x, 100);
  });

  test('clamps lat above 90 to same as lat=90', () => {
    assert.equal(latLngToGrid(100, 0).y, latLngToGrid(90, 0).y);
  });

  test('clamps lat below -90 to same as lat=-90', () => {
    assert.equal(latLngToGrid(-100, 0).y, latLngToGrid(-90, 0).y);
  });

  test('clamps lng above 180 to same as lng=180', () => {
    assert.equal(latLngToGrid(0, 200).x, latLngToGrid(0, 180).x);
  });

  test('clamps lng below -180 to same as lng=-180', () => {
    assert.equal(latLngToGrid(0, -200).x, latLngToGrid(0, -180).x);
  });

  test('x and y are in range [0, 100]', () => {
    for (const [lat, lng] of [[45, -122], [-33, 151], [51, -0.1], [0, 180], [-90, -180]]) {
      const { x, y } = latLngToGrid(lat, lng);
      assert.ok(x >= 0 && x <= 100, `x=${x} out of range for (${lat},${lng})`);
      assert.ok(y >= 0 && y <= 100, `y=${y} out of range for (${lat},${lng})`);
    }
  });
});

// ─── getGlobeUnitVectorFromLatLng ─────────────────────────────────────────────

describe('getGlobeUnitVectorFromLatLng', () => {
  test('returns null for non-finite lat', () => {
    assert.equal(getGlobeUnitVectorFromLatLng(NaN, 0), null);
    assert.equal(getGlobeUnitVectorFromLatLng(Infinity, 0), null);
  });

  test('returns null for non-finite lng', () => {
    assert.equal(getGlobeUnitVectorFromLatLng(0, NaN), null);
    assert.equal(getGlobeUnitVectorFromLatLng(0, Infinity), null);
  });

  test('returns null for null inputs', () => {
    assert.equal(getGlobeUnitVectorFromLatLng(null, null), null);
  });

  test('returns an object with x, y, z for valid inputs', () => {
    const v = getGlobeUnitVectorFromLatLng(45, -122);
    assert.ok(v !== null);
    assert.ok('x' in v && 'y' in v && 'z' in v);
  });

  test('returned vector has magnitude ≈ 1 (unit vector)', () => {
    for (const [lat, lng] of [[0, 0], [45, 90], [-33, 151], [90, 0], [-90, 0]]) {
      const v = getGlobeUnitVectorFromLatLng(lat, lng);
      const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      assert.ok(Math.abs(mag - 1) < 1e-10, `magnitude=${mag} for (${lat},${lng})`);
    }
  });

  test('north pole (lat=90) has y≈1', () => {
    const v = getGlobeUnitVectorFromLatLng(90, 0);
    assert.ok(Math.abs(v.y - 1) < 1e-10);
  });

  test('south pole (lat=-90) has y≈-1', () => {
    const v = getGlobeUnitVectorFromLatLng(-90, 0);
    assert.ok(Math.abs(v.y + 1) < 1e-10);
  });

  test('all components are finite numbers', () => {
    const v = getGlobeUnitVectorFromLatLng(45, 90);
    assert.ok(Number.isFinite(v.x));
    assert.ok(Number.isFinite(v.y));
    assert.ok(Number.isFinite(v.z));
  });
});

// ─── normalizeEntityGridPosition ─────────────────────────────────────────────

describe('normalizeEntityGridPosition', () => {
  test('does not throw for null entity', () => {
    assert.doesNotThrow(() => normalizeEntityGridPosition(null));
  });

  test('does not throw for undefined entity', () => {
    assert.doesNotThrow(() => normalizeEntityGridPosition(undefined));
  });

  test('sets x/y from lat/lng when both are finite', () => {
    const entity = { lat: 0, lng: 0 };
    normalizeEntityGridPosition(entity);
    assert.equal(entity.x, 50);
    assert.equal(entity.y, 50);
  });

  test('does not modify x/y when lat/lng are absent', () => {
    const entity = { x: 10, y: 20 };
    normalizeEntityGridPosition(entity);
    assert.equal(entity.x, 10);
    assert.equal(entity.y, 20);
  });

  test('does not modify x/y when lat is NaN', () => {
    const entity = { lat: NaN, lng: 0, x: 5, y: 5 };
    normalizeEntityGridPosition(entity);
    assert.equal(entity.x, 5);
    assert.equal(entity.y, 5);
  });
});

// ─── uid ──────────────────────────────────────────────────────────────────────

describe('uid', () => {
  test('starts with the given prefix', () => {
    assert.ok(uid('agent').startsWith('agent-'));
    assert.ok(uid('region').startsWith('region-'));
  });

  test('suffix is lowercase hex', () => {
    const id = uid('test');
    const suffix = id.slice('test-'.length);
    assert.match(suffix, /^[0-9a-f]+$/);
  });

  test('generates unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uid('x')));
    assert.equal(ids.size, 200);
  });
});

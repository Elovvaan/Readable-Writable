'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const serverCore = require('../server');
const extractedCore = require('../src/core');

function assertNear(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-10, label + ': expected ' + expected + ', got ' + actual);
}

function assertVectorNear(actual, expected, label) {
  assert.ok(actual, label + ': vector must exist');
  assertNear(actual.x, expected.x, label + '.x');
  assertNear(actual.y, expected.y, label + '.y');
  assertNear(actual.z, expected.z, label + '.z');
}

describe('server/core utility contract', () => {
  test('safeNumber matches extracted core', () => {
    for (const value of ['3.14', '0', '-42', 3.14, 0, null, undefined, '', 'abc', NaN, Infinity, -Infinity]) {
      assert.equal(serverCore.safeNumber(value), extractedCore.safeNumber(value));
    }
  });

  test('hasLatLng matches extracted core', () => {
    const samples = [
      { lat: 0, lng: 0 },
      { lat: 45.5, lng: -122.3 },
      { lat: -90, lng: 180 },
      {},
      { lat: 45 },
      { lng: 90 },
      { lat: null, lng: 0 },
      { lat: 0, lng: null },
      { lat: NaN, lng: 0 },
      { lat: 0, lng: Infinity },
      null,
      undefined,
    ];
    for (const sample of samples) {
      assert.equal(serverCore.hasLatLng(sample), extractedCore.hasLatLng(sample));
    }
  });

  test('latLngToGrid matches extracted core', () => {
    for (const [lat, lng] of [[0, 0], [90, 0], [-90, 0], [0, -180], [0, 180], [100, 200], [-100, -200], [45, -122], [-33, 151]]) {
      assert.deepEqual(serverCore.latLngToGrid(lat, lng), extractedCore.latLngToGrid(lat, lng));
    }
  });

  test('getGlobeUnitVectorFromLatLng matches extracted core and preserves axis orientation', () => {
    const origin = serverCore.getGlobeUnitVectorFromLatLng(0, 0);
    assertVectorNear(origin, { x: 0, y: 0, z: 1 }, 'server origin vector');

    const antiMeridian = serverCore.getGlobeUnitVectorFromLatLng(0, 180);
    assertNear(antiMeridian.y, 0, 'server antiMeridian.y');
    assertNear(antiMeridian.z, -1, 'server antiMeridian.z');

    for (const [lat, lng] of [[0, 0], [0, 90], [0, 180], [45, 90], [-33, 151], [90, 0], [-90, 0], [100, 200], [-100, -200]]) {
      const fromServer = serverCore.getGlobeUnitVectorFromLatLng(lat, lng);
      const fromCore = extractedCore.getGlobeUnitVectorFromLatLng(lat, lng);
      assertVectorNear(fromServer, fromCore, 'vector ' + lat + ',' + lng);
    }
  });

  test('normalizeEntityGridPosition matches extracted core mutation behavior', () => {
    const fromServer = { lat: 0, lng: 0 };
    const fromCore = { lat: 0, lng: 0 };
    serverCore.normalizeEntityGridPosition(fromServer);
    extractedCore.normalizeEntityGridPosition(fromCore);
    assert.deepEqual(fromServer, fromCore);

    const invalidServer = { lat: NaN, lng: 0, x: 5, y: 5 };
    const invalidCore = { lat: NaN, lng: 0, x: 5, y: 5 };
    serverCore.normalizeEntityGridPosition(invalidServer);
    extractedCore.normalizeEntityGridPosition(invalidCore);
    assert.deepEqual(invalidServer, invalidCore);
  });

  test('uid keeps server-compatible prefix and suffix shape', () => {
    assert.match(serverCore.uid('agent'), /^agent-[0-9a-f]{8}$/);
    assert.match(extractedCore.uid('agent'), /^agent-[0-9a-f]{8}$/);
    assert.ok(serverCore.uid('').startsWith('-'));
    assert.ok(extractedCore.uid('').startsWith('-'));
    assert.ok(serverCore.uid(0).startsWith('0-'));
    assert.ok(extractedCore.uid(0).startsWith('0-'));
  });
});

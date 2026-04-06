'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVehicleEntity,
  buildAircraftEntity,
  buildVesselEntity,
  buildSensorEntity,
  buildWeatherCellEntity,
  sanitizeEntityForRender,
  liveEntityState,
  trafficState,
  timelineState,
  entityEventHistory,
  appendEntityEvent,
  refreshLiveEntityLayers,
  refreshTrafficLayer,
  recordTimelineSnapshot,
  seedSensorNodes,
  snapshot,
} = require('../server');

// ─── buildVehicleEntity ───────────────────────────────────────────────────────

describe('buildVehicleEntity', () => {
  test('returns null for missing id', () => {
    assert.equal(buildVehicleEntity(null, { lat: 40, lng: -74 }, null), null);
  });

  test('returns null for non-finite lat', () => {
    assert.equal(buildVehicleEntity('v1', { lat: NaN, lng: -74 }, null), null);
  });

  test('returns null for non-finite lng', () => {
    assert.equal(buildVehicleEntity('v1', { lat: 40, lng: Infinity }, null), null);
  });

  test('builds a valid vehicle entity', () => {
    const e = buildVehicleEntity('v1', { lat: 40.7, lng: -74.0, heading: 90, speed: 15, label: 'UNIT-1', subtype: 'police', source: 'sim', confidence: 0.9 }, null);
    assert.ok(e, 'entity should not be null');
    assert.equal(e.id, 'vehicle-v1');
    assert.equal(e.type, 'vehicle');
    assert.equal(e.subtype, 'police');
    assert.equal(e.source, 'sim');
    assert.equal(e.lat, 40.7);
    assert.equal(e.lng, -74.0);
    assert.equal(e.heading, 90);
    assert.equal(e.speed, 15);
    assert.equal(e.confidence, 0.9);
    assert.equal(e.active, true);
  });

  test('entity has grid x/y in range [0, 100]', () => {
    const e = buildVehicleEntity('v2', { lat: 51.5, lng: -0.12 }, null);
    assert.ok(Number.isFinite(e.x) && e.x >= 0 && e.x <= 100);
    assert.ok(Number.isFinite(e.y) && e.y >= 0 && e.y <= 100);
  });

  test('entity has trail array starting with one point', () => {
    const e = buildVehicleEntity('v3', { lat: 35.68, lng: 139.69 }, null);
    assert.ok(Array.isArray(e.trail));
    assert.equal(e.trail.length, 1);
    assert.equal(e.trail[0].lat, 35.68);
  });

  test('appends trail point when position moves', () => {
    const prev = { lat: 40.6, lng: -74.0, trail: [{ lat: 40.6, lng: -74.0, ts: 1000 }] };
    const e = buildVehicleEntity('v4', { lat: 40.7, lng: -74.0 }, prev);
    assert.ok(e.trail.length >= 2);
  });

  test('eventHistory defaults to empty array', () => {
    const e = buildVehicleEntity('v5', { lat: 10, lng: 10 }, null);
    assert.deepEqual(e.eventHistory, []);
  });

  test('carries eventHistory from previous entity', () => {
    const history = [{ ts: '2024-01-01T00:00:00.000Z', kind: 'move', msg: 'moved' }];
    const prev = { lat: 10, lng: 10, trail: [], eventHistory: history };
    const e = buildVehicleEntity('v6', { lat: 10.01, lng: 10.01 }, prev);
    assert.deepEqual(e.eventHistory, history);
  });

  test('has lastUpdateMs as a finite number', () => {
    const e = buildVehicleEntity('v7', { lat: 0, lng: 0 }, null);
    assert.ok(Number.isFinite(e.lastUpdateMs));
  });
});

// ─── buildVesselEntity ────────────────────────────────────────────────────────

describe('buildVesselEntity', () => {
  test('returns null for missing id', () => {
    assert.equal(buildVesselEntity(null, { lat: 51, lng: 4 }, null), null);
  });

  test('returns null for invalid coordinates', () => {
    assert.equal(buildVesselEntity('sh1', { lat: undefined, lng: 4 }, null), null);
  });

  test('builds a valid vessel entity', () => {
    const e = buildVesselEntity('sh1', { lat: 51.9, lng: 4.0, heading: 180, speed: 8, label: 'CARGO-1', subtype: 'cargo', mmsi: '244820000', source: 'ais', confidence: 0.9 }, null);
    assert.equal(e.id, 'vessel-sh1');
    assert.equal(e.type, 'vessel');
    assert.equal(e.subtype, 'cargo');
    assert.equal(e.mmsi, '244820000');
    assert.equal(e.source, 'ais');
    assert.equal(e.confidence, 0.9);
    assert.equal(e.state, 'underway');
  });

  test('trail capped at 16 points', () => {
    const longTrail = Array.from({ length: 20 }, (_, i) => ({ lat: i, lng: i, ts: i }));
    const prev = { lat: 50.0, lng: 3.0, trail: longTrail };
    const e = buildVesselEntity('sh2', { lat: 51.0, lng: 4.0 }, prev);
    assert.ok(e.trail.length <= 16);
  });
});

// ─── buildSensorEntity ────────────────────────────────────────────────────────

describe('buildSensorEntity', () => {
  test('returns null for missing id', () => {
    assert.equal(buildSensorEntity(null, { lat: 40, lng: -74 }), null);
  });

  test('builds a valid sensor entity', () => {
    const e = buildSensorEntity('sn1', { lat: 40.71, lng: -74.01, label: 'CAM-01', subtype: 'cctv', source: 'infra', confidence: 0.95, state: 'online' });
    assert.equal(e.id, 'sensor-sn1');
    assert.equal(e.type, 'sensor');
    assert.equal(e.subtype, 'cctv');
    assert.equal(e.state, 'online');
    assert.equal(e.confidence, 0.95);
    assert.deepEqual(e.trail, []);  // sensors don't move
  });

  test('sensor altitude defaults to 10', () => {
    const e = buildSensorEntity('sn2', { lat: 0, lng: 0 });
    assert.equal(e.altitude, 10);
  });

  test('respects custom altitude', () => {
    const e = buildSensorEntity('sn3', { lat: 0, lng: 0, altitude: 50 });
    assert.equal(e.altitude, 50);
  });
});

// ─── buildWeatherCellEntity ───────────────────────────────────────────────────

describe('buildWeatherCellEntity', () => {
  test('returns null for missing id', () => {
    assert.equal(buildWeatherCellEntity(null, { lat: 30, lng: -90 }, null), null);
  });

  test('returns null for invalid coordinates', () => {
    assert.equal(buildWeatherCellEntity('wc1', { lat: NaN, lng: -90 }, null), null);
  });

  test('builds a valid storm cell entity', () => {
    const e = buildWeatherCellEntity('wc1', { lat: 30.0, lng: -90.0, subtype: 'storm', radiusKm: 120, intensity: 0.85, source: 'noaa', confidence: 0.8 }, null);
    assert.equal(e.id, 'weather-wc1');
    assert.equal(e.type, 'weather');
    assert.equal(e.subtype, 'storm');
    assert.equal(e.radiusKm, 120);
    assert.equal(e.intensity, 0.85);
    assert.equal(e.source, 'noaa');
    assert.equal(e.confidence, 0.8);
  });

  test('defaults radiusKm to 50 when missing', () => {
    const e = buildWeatherCellEntity('wc2', { lat: 0, lng: 0 }, null);
    assert.equal(e.radiusKm, 50);
  });

  test('defaults intensity to 0.5 when missing', () => {
    const e = buildWeatherCellEntity('wc3', { lat: 0, lng: 0 }, null);
    assert.equal(e.intensity, 0.5);
  });
});

// ─── buildAircraftEntity ──────────────────────────────────────────────────────

describe('buildAircraftEntity', () => {
  test('returns null for missing id', () => {
    assert.equal(buildAircraftEntity(null, { lat: 51.5, lng: -0.1 }, null), null);
  });

  test('returns null for non-finite lat', () => {
    assert.equal(buildAircraftEntity('ac1', { lat: NaN, lng: -0.1 }, null), null);
  });

  test('returns null for non-finite lng', () => {
    assert.equal(buildAircraftEntity('ac1', { lat: 51.5, lng: Infinity }, null), null);
  });

  test('builds a valid aircraft entity', () => {
    const e = buildAircraftEntity('ac1', { lat: 51.48, lng: -0.45, callsign: 'BAW001', subtype: 'commercial', altitude: 11000, heading: 270, speed: 230, source: 'sim', confidence: 0.92 }, null);
    assert.ok(e, 'entity should not be null');
    assert.equal(e.id, 'aircraft-ac1');
    assert.equal(e.type, 'aircraft');
    assert.equal(e.callsign, 'BAW001');
    assert.equal(e.subtype, 'commercial');
    assert.equal(e.source, 'sim');
    assert.equal(e.lat, 51.48);
    assert.equal(e.lng, -0.45);
    assert.equal(e.altitude, 11000);
    assert.equal(e.heading, 270);
    assert.equal(e.speed, 230);
    assert.equal(e.confidence, 0.92);
    assert.equal(e.active, true);
    assert.equal(e.state, 'airborne');
  });

  test('defaults altitude to 10000 when missing', () => {
    const e = buildAircraftEntity('ac2', { lat: 40.0, lng: -74.0 }, null);
    assert.equal(e.altitude, 10000);
  });

  test('defaults subtype to commercial when missing', () => {
    const e = buildAircraftEntity('ac3', { lat: 40.0, lng: -74.0 }, null);
    assert.equal(e.subtype, 'commercial');
  });

  test('has trail array starting with one point', () => {
    const e = buildAircraftEntity('ac4', { lat: 35.68, lng: 139.69, altitude: 10000 }, null);
    assert.ok(Array.isArray(e.trail));
    assert.equal(e.trail.length, 1);
    assert.equal(e.trail[0].lat, 35.68);
  });

  test('appends trail point when position moves', () => {
    const prev = { lat: 40.6, lng: -74.0, trail: [{ lat: 40.6, lng: -74.0, alt: 10000, ts: 1000 }], eventHistory: [] };
    const e = buildAircraftEntity('ac5', { lat: 40.7, lng: -74.0, altitude: 10000 }, prev);
    assert.ok(e.trail.length >= 2);
  });

  test('eventHistory defaults to empty array', () => {
    const e = buildAircraftEntity('ac6', { lat: 10, lng: 10 }, null);
    assert.deepEqual(e.eventHistory, []);
  });

  test('carries eventHistory from previous entity', () => {
    const history = [{ ts: '2024-01-01T00:00:00.000Z', kind: 'move', msg: 'climbed' }];
    const prev = { lat: 10, lng: 10, trail: [], eventHistory: history };
    const e = buildAircraftEntity('ac7', { lat: 10.01, lng: 10.01 }, prev);
    assert.deepEqual(e.eventHistory, history);
  });

  test('has lastUpdateMs as a finite number', () => {
    const e = buildAircraftEntity('ac8', { lat: 0, lng: 0 }, null);
    assert.ok(Number.isFinite(e.lastUpdateMs));
  });

  test('trail capped at 24 points', () => {
    const longTrail = Array.from({ length: 30 }, (_, i) => ({ lat: i * 0.1, lng: i * 0.1, alt: 10000, ts: i }));
    const prev = { lat: 50.0, lng: 3.0, trail: longTrail, eventHistory: [] };
    const e = buildAircraftEntity('ac9', { lat: 51.0, lng: 4.0, altitude: 10000 }, prev);
    assert.ok(e.trail.length <= 24);
  });
});

// ─── refreshLiveEntityLayers ──────────────────────────────────────────────────

describe('refreshLiveEntityLayers', () => {
  test('populates vehicles after refresh', () => {
    refreshLiveEntityLayers();
    const vehicles = Object.values(liveEntityState.vehicles);
    assert.ok(vehicles.length > 0, 'should have at least one vehicle');
  });

  test('populates vessels after refresh', () => {
    const vessels = Object.values(liveEntityState.vessels);
    assert.ok(vessels.length > 0, 'should have at least one vessel');
  });

  test('populates aircraft after refresh', () => {
    const aircraft = Object.values(liveEntityState.aircraft);
    assert.ok(aircraft.length > 0, 'should have at least one aircraft');
  });

  test('all vehicles have type="vehicle"', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) assert.equal(v.type, 'vehicle');
  });

  test('all vessels have type="vessel"', () => {
    const vessels = Object.values(liveEntityState.vessels);
    for (const v of vessels) assert.equal(v.type, 'vessel');
  });

  test('all aircraft have type="aircraft"', () => {
    const aircraft = Object.values(liveEntityState.aircraft);
    for (const a of aircraft) assert.equal(a.type, 'aircraft');
  });

  test('all vehicles have confidence in [0,1]', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) {
      assert.ok(v.confidence >= 0 && v.confidence <= 1,
        'vehicle confidence out of range: ' + v.confidence);
    }
  });

  test('all aircraft have confidence in [0,1]', () => {
    const aircraft = Object.values(liveEntityState.aircraft);
    for (const a of aircraft) {
      assert.ok(a.confidence >= 0 && a.confidence <= 1,
        'aircraft confidence out of range: ' + a.confidence);
    }
  });

  test('all vehicles have finite lat/lng', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) {
      assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng),
        'vehicle ' + v.id + ' has invalid coordinates');
    }
  });

  test('vehicle positions stay within orbital radius of base (~2 km)', () => {
    // Orbital radius is 0.018° — positions must remain within that bound + floating-point epsilon
    const bases = {
      'v001': { lat: 40.71, lng: -74.01 }, 'v002': { lat: 51.50, lng: -0.12 },
      'v003': { lat: 48.85, lng: 2.35 },   'v004': { lat: 35.68, lng: 139.69 },
      'v005': { lat: 34.05, lng: -118.24 }, 'v006': { lat: 19.43, lng: -99.13 },
    };
    for (const v of Object.values(liveEntityState.vehicles)) {
      const seed = v.id.replace('vehicle-', '');
      if (!bases[seed]) continue;
      const b = bases[seed];
      assert.ok(Math.abs(v.lat - b.lat) <= 0.018 + 1e-9, 'vehicle lat drift too large: ' + Math.abs(v.lat - b.lat));
      assert.ok(Math.abs(v.lng - b.lng) <= 0.018 + 1e-9, 'vehicle lng drift too large: ' + Math.abs(v.lng - b.lng));
    }
  });

  test('vessel positions stay within orbital radius of base (~5 km)', () => {
    // Orbital radius is 0.045° — positions must remain within that bound + floating-point epsilon
    const bases = {
      'sh001': { lat: 51.90, lng: 4.00 },   'sh002': { lat: 1.28,  lng: 103.83 },
      'sh003': { lat: 37.77, lng: -122.41 }, 'sh004': { lat: 29.98, lng: 32.56 },
    };
    for (const v of Object.values(liveEntityState.vessels)) {
      const seed = v.id.replace('vessel-', '');
      if (!bases[seed]) continue;
      const b = bases[seed];
      assert.ok(Math.abs(v.lat - b.lat) <= 0.045 + 1e-9, 'vessel lat drift too large: ' + Math.abs(v.lat - b.lat));
      assert.ok(Math.abs(v.lng - b.lng) <= 0.045 + 1e-9, 'vessel lng drift too large: ' + Math.abs(v.lng - b.lng));
    }
  });

  test('vehicles and vessels have heading in [0, 360)', () => {
    for (const v of Object.values(liveEntityState.vehicles)) {
      assert.ok(Number.isFinite(v.heading) && v.heading >= 0 && v.heading < 360,
        'vehicle heading out of range: ' + v.heading);
    }
    for (const v of Object.values(liveEntityState.vessels)) {
      assert.ok(Number.isFinite(v.heading) && v.heading >= 0 && v.heading < 360,
        'vessel heading out of range: ' + v.heading);
    }
  });
});

// ─── seedSensorNodes ──────────────────────────────────────────────────────────

describe('seedSensorNodes', () => {
  test('seeds at least 1 sensor', () => {
    const sensors = Object.values(liveEntityState.sensors);
    assert.ok(sensors.length >= 1, 'should have at least one sensor after seeding');
  });

  test('sensors have type="sensor"', () => {
    const sensors = Object.values(liveEntityState.sensors);
    for (const s of sensors) assert.equal(s.type, 'sensor');
  });

  test('sensors have confidence=0.95', () => {
    const sensors = Object.values(liveEntityState.sensors);
    for (const s of sensors) assert.equal(s.confidence, 0.95);
  });

  test('sensors have empty trail (fixed nodes)', () => {
    const sensors = Object.values(liveEntityState.sensors);
    for (const s of sensors) assert.deepEqual(s.trail, []);
  });

  test('calling seedSensorNodes again does not duplicate sensors', () => {
    const countBefore = Object.keys(liveEntityState.sensors).length;
    seedSensorNodes();
    const countAfter = Object.keys(liveEntityState.sensors).length;
    assert.equal(countBefore, countAfter);
  });
});

// ─── refreshTrafficLayer ──────────────────────────────────────────────────────

describe('refreshTrafficLayer', () => {
  test('populates traffic segments', () => {
    refreshTrafficLayer();
    assert.ok(trafficState.segments.length > 0, 'should have at least one segment');
  });

  test('each segment has speedKph and congestion', () => {
    for (const seg of trafficState.segments) {
      assert.ok(Number.isFinite(seg.speedKph), 'speedKph must be finite');
      assert.ok(Number.isFinite(seg.congestion), 'congestion must be finite');
      assert.ok(seg.congestion >= 0 && seg.congestion <= 1, 'congestion in [0,1]');
    }
  });

  test('each segment has a level field (free|light|moderate|heavy)', () => {
    const validLevels = new Set(['free', 'light', 'moderate', 'heavy']);
    for (const seg of trafficState.segments) {
      assert.ok(validLevels.has(seg.level), 'invalid level: ' + seg.level);
    }
  });

  test('each segment has source and ts', () => {
    for (const seg of trafficState.segments) {
      assert.ok(seg.source, 'segment must have source');
      assert.ok(Number.isFinite(seg.ts), 'segment must have ts');
    }
  });

  test('incidents are an array', () => {
    assert.ok(Array.isArray(trafficState.incidents));
  });

  test('all incidents have lat/lng', () => {
    for (const inc of trafficState.incidents) {
      assert.ok(Number.isFinite(inc.lat) && Number.isFinite(inc.lng));
    }
  });

  test('all incidents have confidence', () => {
    for (const inc of trafficState.incidents) {
      assert.ok(Number.isFinite(inc.confidence));
    }
  });

  test('zoneAlerts are an array', () => {
    assert.ok(Array.isArray(trafficState.zoneAlerts));
  });

  test('lastUpdateAt is set after refresh', () => {
    assert.ok(Number.isFinite(trafficState.lastUpdateAt));
  });

  test('closures are an array', () => {
    assert.ok(Array.isArray(trafficState.closures));
  });
});

// ─── recordTimelineSnapshot ───────────────────────────────────────────────────

describe('recordTimelineSnapshot', () => {
  test('adds a snapshot after first call', () => {
    // force the call by resetting lastSnapshotAt
    timelineState.lastSnapshotAt = null;
    recordTimelineSnapshot();
    assert.ok(timelineState.snapshots.length > 0, 'should have at least one snapshot');
  });

  test('snapshot has required fields', () => {
    const snap = timelineState.snapshots[timelineState.snapshots.length - 1];
    assert.ok(Number.isFinite(snap.ts), 'snapshot must have ts');
    assert.ok(Number.isFinite(snap.agentCount) || snap.agentCount === 0);
    assert.ok(Array.isArray(snap.events));
  });

  test('sets replayStart and replayEnd', () => {
    assert.ok(Number.isFinite(timelineState.replayStart));
    assert.ok(Number.isFinite(timelineState.replayEnd));
    assert.ok(timelineState.replayEnd >= timelineState.replayStart);
  });

  test('does not add duplicate snapshot within interval', () => {
    const before = timelineState.snapshots.length;
    recordTimelineSnapshot(); // should be skipped — lastSnapshotAt was just set
    const after = timelineState.snapshots.length;
    assert.equal(before, after, 'should not add duplicate snapshot within interval');
  });
});

// ─── appendEntityEvent ────────────────────────────────────────────────────────

describe('appendEntityEvent', () => {
  test('adds an event to entity history', () => {
    appendEntityEvent('test-entity-1', 'move', 'moved north');
    const history = entityEventHistory['test-entity-1'];
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, 'move');
    assert.equal(history[0].msg, 'moved north');
    assert.ok(typeof history[0].ts === 'string');
  });

  test('caps history at 10 entries', () => {
    const id = 'test-entity-cap';
    for (let i = 0; i < 15; i++) appendEntityEvent(id, 'test', 'msg ' + i);
    assert.ok(entityEventHistory[id].length <= 10);
  });

  test('ignores null entityId', () => {
    const before = Object.keys(entityEventHistory).length;
    appendEntityEvent(null, 'move', 'test');
    const after = Object.keys(entityEventHistory).length;
    assert.equal(before, after);
  });
});

// ─── sanitizeEntityForRender ──────────────────────────────────────────────────

describe('sanitizeEntityForRender', () => {
  test('returns null for null input', () => {
    assert.equal(sanitizeEntityForRender(null), null);
  });

  test('returns null for non-object inputs', () => {
    assert.equal(sanitizeEntityForRender('string'), null);
    assert.equal(sanitizeEntityForRender(42), null);
    assert.equal(sanitizeEntityForRender(undefined), null);
  });

  test('returns null for objects with more than 1000 keys', () => {
    const big = {};
    for (let i = 0; i < 1001; i++) big['k' + i] = i;
    assert.equal(sanitizeEntityForRender(big), null);
  });

  test('strips eventHistory from entity', () => {
    const entity = { id: 'v1', type: 'vehicle', lat: 40, lng: -74, altitude: 0, state: 'moving', confidence: 0.9, eventHistory: [{ ts: '2024', kind: 'move', msg: 'moved' }], trail: [{ lat: 40, lng: -74, ts: 1 }] };
    const result = sanitizeEntityForRender(entity);
    assert.ok(!('eventHistory' in result), 'eventHistory should be stripped');
  });

  test('strips trail from entity', () => {
    const entity = { id: 'v1', type: 'vehicle', lat: 40, lng: -74, altitude: 0, state: 'moving', confidence: 0.9, trail: [{ lat: 40, lng: -74, ts: 1 }] };
    const result = sanitizeEntityForRender(entity);
    assert.ok(!('trail' in result), 'trail should be stripped');
  });

  test('keeps required render fields', () => {
    const entity = { id: 'ac1', type: 'aircraft', lat: 51.5, lng: -0.1, altitude: 10000, state: 'airborne', confidence: 0.92, callsign: 'BAW001', heading: 270, speed: 230 };
    const result = sanitizeEntityForRender(entity);
    assert.equal(result.id, 'ac1');
    assert.equal(result.type, 'aircraft');
    assert.equal(result.lat, 51.5);
    assert.equal(result.lng, -0.1);
    assert.equal(result.alt, 10000);
    assert.equal(result.status, 'airborne');
    assert.equal(result.confidence, 0.92);
  });

  test('does not include extra fields beyond the allowed set', () => {
    const entity = { id: 'v1', type: 'vehicle', lat: 40, lng: -74, altitude: 0, state: 'moving', confidence: 0.9, heading: 90, speed: 15, subtype: 'car', label: 'UNIT-1' };
    const result = sanitizeEntityForRender(entity);
    const keys = Object.keys(result);
    const allowed = new Set(['id', 'type', 'lat', 'lng', 'alt', 'status', 'confidence']);
    for (const k of keys) assert.ok(allowed.has(k), 'unexpected key: ' + k);
  });
});

// ─── snapshot includes live entity data ───────────────────────────────────────

describe('snapshot live entity integration', () => {
  test('snapshot includes liveEntities field', () => {
    const snap = snapshot();
    assert.ok(snap && typeof snap.liveEntities === 'object', 'liveEntities must be present');
  });

  test('snapshot.liveEntities has vehicles, aircraft, vessels, sensors, weather', () => {
    const snap = snapshot();
    assert.ok(Array.isArray(snap.liveEntities.vehicles));
    assert.ok(Array.isArray(snap.liveEntities.aircraft));
    assert.ok(Array.isArray(snap.liveEntities.vessels));
    assert.ok(Array.isArray(snap.liveEntities.sensors));
    assert.ok(Array.isArray(snap.liveEntities.weather));
  });

  test('snapshot aircraft have type="aircraft"', () => {
    const snap = snapshot();
    for (const a of snap.liveEntities.aircraft) {
      assert.equal(a.type, 'aircraft');
    }
  });

  test('snapshot live entities do not contain eventHistory', () => {
    const snap = snapshot();
    for (const layer of ['vehicles', 'aircraft', 'vessels', 'sensors', 'weather']) {
      for (const e of snap.liveEntities[layer]) {
        assert.ok(!('eventHistory' in e), layer + ' entity should not have eventHistory');
      }
    }
  });

  test('snapshot live entities do not contain trail', () => {
    const snap = snapshot();
    for (const layer of ['vehicles', 'aircraft', 'vessels', 'sensors', 'weather']) {
      for (const e of snap.liveEntities[layer]) {
        assert.ok(!('trail' in e), layer + ' entity should not have trail');
      }
    }
  });

  test('snapshot live entity has only allowed render fields', () => {
    const snap = snapshot();
    const allowed = new Set(['id', 'type', 'lat', 'lng', 'alt', 'status', 'confidence']);
    for (const layer of ['vehicles', 'aircraft', 'vessels']) {
      for (const e of snap.liveEntities[layer]) {
        for (const k of Object.keys(e)) {
          assert.ok(allowed.has(k), layer + ' entity has unexpected field: ' + k);
        }
      }
    }
  });

  test('snapshot includes traffic field', () => {
    const snap = snapshot();
    assert.ok(snap && typeof snap.traffic === 'object', 'traffic must be present');
    assert.ok(Array.isArray(snap.traffic.segments));
    assert.ok(Array.isArray(snap.traffic.incidents));
    assert.ok(Array.isArray(snap.traffic.zoneAlerts));
    assert.ok(Array.isArray(snap.traffic.closures));
  });

  test('snapshot includes timeline field', () => {
    const snap = snapshot();
    assert.ok(snap && typeof snap.timeline === 'object', 'timeline must be present');
    assert.ok('mode' in snap.timeline, 'timeline must have mode');
    assert.ok('snapshotCount' in snap.timeline, 'timeline must have snapshotCount');
  });

  test('snapshot sensors match seeded sensor nodes', () => {
    const snap = snapshot();
    const sensors = snap.liveEntities.sensors;
    assert.ok(sensors.length >= 8, 'should have at least 8 seeded sensors');
  });
});

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVehicleEntity,
  buildVesselEntity,
  buildSensorEntity,
  buildWeatherCellEntity,
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

  test('all vehicles have type="vehicle"', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) assert.equal(v.type, 'vehicle');
  });

  test('all vessels have type="vessel"', () => {
    const vessels = Object.values(liveEntityState.vessels);
    for (const v of vessels) assert.equal(v.type, 'vessel');
  });

  test('all vehicles have confidence in [0,1]', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) {
      assert.ok(v.confidence >= 0 && v.confidence <= 1,
        'vehicle confidence out of range: ' + v.confidence);
    }
  });

  test('all vehicles have finite lat/lng', () => {
    const vehicles = Object.values(liveEntityState.vehicles);
    for (const v of vehicles) {
      assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng),
        'vehicle ' + v.id + ' has invalid coordinates');
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

  test('caps history at 50 entries', () => {
    const id = 'test-entity-cap';
    for (let i = 0; i < 55; i++) appendEntityEvent(id, 'test', 'msg ' + i);
    assert.ok(entityEventHistory[id].length <= 50);
  });

  test('ignores null entityId', () => {
    const before = Object.keys(entityEventHistory).length;
    appendEntityEvent(null, 'move', 'test');
    const after = Object.keys(entityEventHistory).length;
    assert.equal(before, after);
  });
});

// ─── snapshot includes live entity data ───────────────────────────────────────

describe('snapshot live entity integration', () => {
  test('snapshot includes liveEntities field', () => {
    const snap = snapshot();
    assert.ok(snap && typeof snap.liveEntities === 'object', 'liveEntities must be present');
  });

  test('snapshot.liveEntities has vehicles, vessels, sensors, weather', () => {
    const snap = snapshot();
    assert.ok(Array.isArray(snap.liveEntities.vehicles));
    assert.ok(Array.isArray(snap.liveEntities.vessels));
    assert.ok(Array.isArray(snap.liveEntities.sensors));
    assert.ok(Array.isArray(snap.liveEntities.weather));
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

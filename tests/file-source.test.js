'use strict';

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fileCredentials,
  detectAnomalies,
  loadOpenSkyFile,
  openSkyFileState,
  eventLog,
} = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Write a temporary opensky.json-shaped file and return its path.
function writeTmp(payload) {
  const p = path.join(os.tmpdir(), 'rw-test-opensky-' + process.pid + '.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

// Build a minimal valid OpenSky state vector row.
function makeRow(overrides = {}) {
  const row = ['abc123', 'TEST01', 'US', 1700000000, 1700000000,
               -73.5, 40.7, 10000, false, 245, 90, 0, null, 10100];
  for (const [i, v] of Object.entries(overrides)) row[Number(i)] = v;
  return row;
}

// Redirect OPENSKY_FILE_PATH for the duration of a test by temporarily
// monkey-patching the module's internal path via process.env + re-using
// loadOpenSkyFile with the real fs.  Instead we directly call loadOpenSkyFile
// after pointing the server's resolved path — but since the constant is baked
// in at require time, the simplest approach is to stub fs.readFileSync.
//
// For these tests we rely on the real loadOpenSkyFile but patch the file it
// reads by temporarily overwriting the actual opensky.json path used by the
// module. We save & restore the real file around each test.

const REAL_FILE = path.resolve('opensky.json');

function withFile(payload, fn) {
  const existed = fs.existsSync(REAL_FILE);
  const backup = existed ? fs.readFileSync(REAL_FILE, 'utf8') : null;
  try {
    fs.writeFileSync(REAL_FILE, JSON.stringify(payload), 'utf8');
    return fn();
  } finally {
    if (backup !== null) {
      fs.writeFileSync(REAL_FILE, backup, 'utf8');
    } else if (fs.existsSync(REAL_FILE)) {
      fs.unlinkSync(REAL_FILE);
    }
  }
}

// ─── detectAnomalies ─────────────────────────────────────────────────────────

describe('detectAnomalies', () => {
  test('returns empty array for empty flights', () => {
    assert.deepEqual(detectAnomalies({}), []);
  });

  test('returns empty array for normal flights', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: 245, id: 'flight-abc' },
      'flight-def': { icao24: 'def', velocity: 270, id: 'flight-def' },
    };
    assert.deepEqual(detectAnomalies(flights), []);
  });

  test('flags impossible speed (> 600 m/s)', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: 950, id: 'flight-abc' },
    };
    const anomalies = detectAnomalies(flights);
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].type, 'impossible_speed');
    assert.equal(anomalies[0].id, 'flight-abc');
    assert.equal(anomalies[0].velocity, 950);
  });

  test('does not flag speed exactly at threshold (600 m/s)', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: 600, id: 'flight-abc' },
    };
    assert.deepEqual(detectAnomalies(flights), []);
  });

  test('flags speed one unit above threshold', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: 600.1, id: 'flight-abc' },
    };
    assert.equal(detectAnomalies(flights)[0].type, 'impossible_speed');
  });

  test('does not flag non-finite velocity', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: null, id: 'flight-abc' },
      'flight-def': { icao24: 'def', velocity: NaN,  id: 'flight-def' },
    };
    assert.deepEqual(detectAnomalies(flights), []);
  });

  test('flags duplicate ICAO24', () => {
    const flights = {
      'flight-aaa1': { icao24: 'aaa', velocity: 200, id: 'flight-aaa1' },
      'flight-aaa2': { icao24: 'aaa', velocity: 210, id: 'flight-aaa2' },
    };
    const anomalies = detectAnomalies(flights);
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].type, 'duplicate_icao');
    assert.equal(anomalies[0].icao24, 'aaa');
    assert.ok(anomalies[0].ids.includes('flight-aaa1'));
    assert.ok(anomalies[0].ids.includes('flight-aaa2'));
  });

  test('does not flag duplicate when icao24 is absent', () => {
    const flights = {
      'flight-x': { icao24: '', velocity: 200, id: 'flight-x' },
      'flight-y': { icao24: '', velocity: 210, id: 'flight-y' },
    };
    assert.deepEqual(detectAnomalies(flights), []);
  });

  test('can flag both anomaly types simultaneously', () => {
    const flights = {
      'flight-fast': { icao24: 'f1', velocity: 1200, id: 'flight-fast' },
      'flight-dup1': { icao24: 'd1', velocity: 200,  id: 'flight-dup1' },
      'flight-dup2': { icao24: 'd1', velocity: 210,  id: 'flight-dup2' },
    };
    const anomalies = detectAnomalies(flights);
    assert.equal(anomalies.length, 2);
    const types = anomalies.map(a => a.type);
    assert.ok(types.includes('impossible_speed'));
    assert.ok(types.includes('duplicate_icao'));
  });

  test('anomaly message is a non-empty string', () => {
    const flights = {
      'flight-abc': { icao24: 'abc', velocity: 800, id: 'flight-abc' },
    };
    const [a] = detectAnomalies(flights);
    assert.ok(typeof a.msg === 'string' && a.msg.length > 0);
  });
});

// ─── loadOpenSkyFile ─────────────────────────────────────────────────────────

describe('loadOpenSkyFile', () => {
  beforeEach(() => {
    // Reset shared state before each test
    openSkyFileState.flights = {};
    openSkyFileState.lastLoadAt = null;
    openSkyFileState.lastErrorAt = null;
    openSkyFileState.lastContentHash = null;
    openSkyFileState.anomalies = [];
    eventLog.length = 0;
  });

  test('loads flights from a valid file', () => {
    withFile({ states: [makeRow()] }, () => {
      loadOpenSkyFile();
      assert.equal(Object.keys(openSkyFileState.flights).length, 1);
      assert.ok(openSkyFileState.lastLoadAt !== null);
      assert.equal(openSkyFileState.lastErrorAt, null);
    });
  });

  test('flight source is set to "file"', () => {
    withFile({ states: [makeRow()] }, () => {
      loadOpenSkyFile();
      const flight = Object.values(openSkyFileState.flights)[0];
      assert.equal(flight.source, 'file');
    });
  });

  test('loads multiple flights', () => {
    withFile({
      states: [
        makeRow({ 0: 'aaa111' }),
        makeRow({ 0: 'bbb222' }),
        makeRow({ 0: 'ccc333' }),
      ],
    }, () => {
      loadOpenSkyFile();
      assert.equal(Object.keys(openSkyFileState.flights).length, 3);
    });
  });

  test('sets lastErrorAt and emits event on parse error', () => {
    const backup = fs.existsSync(REAL_FILE) ? fs.readFileSync(REAL_FILE, 'utf8') : null;
    try {
      fs.writeFileSync(REAL_FILE, '{ not valid json', 'utf8');
      loadOpenSkyFile();
      assert.ok(openSkyFileState.lastErrorAt !== null);
      assert.equal(eventLog.filter(e => e.msg.includes('parse error')).length, 1);
    } finally {
      if (backup !== null) {
        fs.writeFileSync(REAL_FILE, backup, 'utf8');
      } else if (fs.existsSync(REAL_FILE)) {
        fs.unlinkSync(REAL_FILE);
      }
    }
  });

  test('handles missing file gracefully (no error state)', () => {
    // Temporarily rename the real file if it exists
    const backup = fs.existsSync(REAL_FILE) ? fs.readFileSync(REAL_FILE, 'utf8') : null;
    if (fs.existsSync(REAL_FILE)) fs.unlinkSync(REAL_FILE);
    try {
      loadOpenSkyFile(); // ENOENT should be silently ignored
      assert.equal(openSkyFileState.lastErrorAt, null);
    } finally {
      if (backup !== null) fs.writeFileSync(REAL_FILE, backup, 'utf8');
    }
  });

  test('emits appear event for new flights', () => {
    withFile({ states: [makeRow()] }, () => {
      loadOpenSkyFile();
      const appearEvents = eventLog.filter(e => e.msg.includes('appeared'));
      assert.equal(appearEvents.length, 1);
    });
  });

  test('emits disappear event when flight drops out', () => {
    // First load: one flight
    withFile({ states: [makeRow({ 0: 'abc123' })] }, () => {
      loadOpenSkyFile();
    });
    // Second load: empty states
    withFile({ states: [] }, () => {
      loadOpenSkyFile();
      const disappear = eventLog.filter(e => e.msg.includes('disappeared'));
      assert.equal(disappear.length, 1);
    });
  });

  test('does not re-emit anomaly event for the same anomaly on reload', () => {
    const fastRow = makeRow({ 9: 900 }); // velocity = 900 m/s → impossible speed
    withFile({ states: [fastRow] }, () => {
      loadOpenSkyFile(); // first load — emits anomaly event
      const countAfterFirst = eventLog.filter(e => e.msg.includes('anomaly')).length;

      loadOpenSkyFile(); // second load — same anomaly, should NOT emit again
      const countAfterSecond = eventLog.filter(e => e.msg.includes('anomaly')).length;

      assert.equal(countAfterFirst, 1);
      assert.equal(countAfterSecond, 1); // no duplicate event
    });
  });

  test('handles empty states array without error', () => {
    withFile({ states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(Object.keys(openSkyFileState.flights).length, 0);
      assert.equal(openSkyFileState.lastErrorAt, null);
    });
  });

  test('invalid rows are skipped without crashing', () => {
    withFile({ states: [null, 'bad', [], makeRow()] }, () => {
      loadOpenSkyFile();
      assert.equal(Object.keys(openSkyFileState.flights).length, 1); // only the valid row
    });
  });
});

// ─── File credentials ─────────────────────────────────────────────────────────

describe('loadOpenSkyFile credential loading', () => {
  beforeEach(() => {
    fileCredentials.username = '';
    fileCredentials.password = '';
  });

  test('loads username and password fields', () => {
    withFile({ username: 'myuser', password: 'mypass', states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(fileCredentials.username, 'myuser');
      assert.equal(fileCredentials.password, 'mypass');
    });
  });

  test('accepts client_id / client_secret as aliases', () => {
    withFile({ client_id: 'cid', client_secret: 'csecret', states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(fileCredentials.username, 'cid');
      assert.equal(fileCredentials.password, 'csecret');
    });
  });

  test('username takes priority over client_id when both present', () => {
    withFile({ username: 'u', client_id: 'c', password: 'p', states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(fileCredentials.username, 'u');
    });
  });

  test('does not set credentials when only one field is present', () => {
    withFile({ username: 'u', states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(fileCredentials.username, '');
    });
  });

  test('trims whitespace from credential values', () => {
    withFile({ username: '  user  ', password: '  pass  ', states: [] }, () => {
      loadOpenSkyFile();
      assert.equal(fileCredentials.username, 'user');
      assert.equal(fileCredentials.password, 'pass');
    });
  });

  test('does not update credentials when fields are absent', () => {
    fileCredentials.username = 'prev';
    fileCredentials.password = 'prevpass';
    withFile({ states: [] }, () => {
      loadOpenSkyFile();
      // Unchanged — no credentials in file
      assert.equal(fileCredentials.username, 'prev');
      assert.equal(fileCredentials.password, 'prevpass');
    });
  });
});

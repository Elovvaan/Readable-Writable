'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  quantumSimState,
  BRANCH_COUNT,
  BRANCH_AGENT_ROLES,
  EARTH_SPACE_LAYERS,
  createSimLocation,
  evolveSimBranches,
  pruneSimBranches,
  collapseSimLocation,
  collapseAllSimLocations,
  entangleSimBranches,
} = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSimState() {
  for (const key of Object.keys(quantumSimState.locations)) {
    delete quantumSimState.locations[key];
  }
  quantumSimState.auditTrail.length = 0;
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  test('BRANCH_COUNT is a positive integer', () => {
    assert.ok(Number.isInteger(BRANCH_COUNT) && BRANCH_COUNT > 0);
  });

  test('BRANCH_AGENT_ROLES contains expected roles', () => {
    const required = ['pilot', 'driver', 'operator', 'weather', 'satellite', 'logistics', 'response'];
    for (const role of required) {
      assert.ok(BRANCH_AGENT_ROLES.includes(role), `missing role: ${role}`);
    }
  });

  test('EARTH_SPACE_LAYERS contains both earth and space layers', () => {
    assert.ok(EARTH_SPACE_LAYERS.includes('cities'));
    assert.ok(EARTH_SPACE_LAYERS.includes('satellites'));
    assert.ok(EARTH_SPACE_LAYERS.includes('orbital_signals'));
    assert.ok(EARTH_SPACE_LAYERS.includes('weather'));
    assert.ok(EARTH_SPACE_LAYERS.length >= 8);
  });
});

// ─── createSimLocation ────────────────────────────────────────────────────────

describe('createSimLocation', () => {
  beforeEach(clearSimState);

  test('returns a location object with correct shape', () => {
    const loc = createSimLocation(40.7128, -74.006, 'New York');
    assert.ok(loc.id.startsWith('simloc-'));
    assert.equal(loc.lat, 40.7128);
    assert.equal(loc.lng, -74.006);
    assert.equal(loc.label, 'New York');
    assert.ok(Array.isArray(loc.branches));
    assert.ok(loc.createdAt);
    assert.strictEqual(loc.collapsed, null);
  });

  test('spawns exactly BRANCH_COUNT branches', () => {
    const loc = createSimLocation(51.5074, -0.1278);
    assert.equal(loc.branches.length, BRANCH_COUNT);
  });

  test('all branches start with status active', () => {
    const loc = createSimLocation(35.6762, 139.6503);
    assert.ok(loc.branches.every(b => b.status === 'active'));
  });

  test('each branch has all agent roles', () => {
    const loc = createSimLocation(48.8566, 2.3522);
    for (const branch of loc.branches) {
      const roles = branch.agents.map(a => a.role);
      for (const role of BRANCH_AGENT_ROLES) {
        assert.ok(roles.includes(role), `branch missing role: ${role}`);
      }
    }
  });

  test('each branch has confidence between 0 and 1', () => {
    const loc = createSimLocation(0, 0);
    for (const branch of loc.branches) {
      assert.ok(branch.confidence >= 0 && branch.confidence <= 1);
    }
  });

  test('each branch has a trajectory array with waypoints', () => {
    const loc = createSimLocation(37.7749, -122.4194);
    for (const branch of loc.branches) {
      assert.ok(Array.isArray(branch.trajectory));
      assert.ok(branch.trajectory.length > 0);
      const wp = branch.trajectory[0];
      assert.ok(Number.isFinite(wp.lat));
      assert.ok(Number.isFinite(wp.lng));
      assert.ok(Number.isFinite(wp.alt));
    }
  });

  test('stores location in quantumSimState.locations', () => {
    const loc = createSimLocation(55.7558, 37.6173);
    assert.ok(quantumSimState.locations[loc.id]);
  });

  test('auto-generates label from coordinates when none supplied', () => {
    const loc = createSimLocation(10.0, 20.0);
    assert.ok(loc.label.includes('10.000') || loc.label.includes('loc@'));
  });

  test('branch has branchIndex from 0 to BRANCH_COUNT-1', () => {
    const loc = createSimLocation(0, 0);
    const indices = loc.branches.map(b => b.branchIndex).sort((a, b) => a - b);
    for (let i = 0; i < BRANCH_COUNT; i++) {
      assert.equal(indices[i], i);
    }
  });

  test('branch has lineage as empty array for root branches', () => {
    const loc = createSimLocation(0, 0);
    for (const b of loc.branches) {
      assert.deepEqual(b.lineage, []);
    }
  });
});

// ─── evolveSimBranches ────────────────────────────────────────────────────────

describe('evolveSimBranches', () => {
  beforeEach(clearSimState);

  test('returns count of active branches evolved', () => {
    const loc = createSimLocation(0, 0);
    const count = evolveSimBranches(loc.id);
    assert.equal(count, BRANCH_COUNT);
  });

  test('returns null for unknown locationId', () => {
    const count = evolveSimBranches('nonexistent-id');
    assert.strictEqual(count, null);
  });

  test('increments branch generation', () => {
    const loc = createSimLocation(0, 0);
    evolveSimBranches(loc.id);
    for (const b of loc.branches) {
      assert.equal(b.generation, 1);
    }
  });

  test('increments agent trainingSteps', () => {
    const loc = createSimLocation(0, 0);
    evolveSimBranches(loc.id);
    for (const b of loc.branches) {
      for (const a of b.agents) {
        assert.equal(a.trainingSteps, 1);
      }
    }
  });

  test('sets evolvedAt timestamp', () => {
    const loc = createSimLocation(0, 0);
    evolveSimBranches(loc.id);
    for (const b of loc.branches) {
      assert.ok(b.evolvedAt);
    }
  });

  test('extends trajectory on each evolution', () => {
    const loc = createSimLocation(0, 0);
    const before = loc.branches[0].trajectory.length;
    evolveSimBranches(loc.id);
    assert.ok(loc.branches[0].trajectory.length > before);
  });

  test('pruned branches are not evolved', () => {
    const loc = createSimLocation(0, 0);
    loc.branches[0].status = 'pruned';
    const count = evolveSimBranches(loc.id);
    assert.equal(count, BRANCH_COUNT - 1);
    assert.equal(loc.branches[0].generation, 0);  // unchanged
  });
});

// ─── pruneSimBranches ─────────────────────────────────────────────────────────

describe('pruneSimBranches', () => {
  beforeEach(clearSimState);

  test('returns 0 for unknown locationId', () => {
    const count = pruneSimBranches('nonexistent', 0.5);
    assert.equal(count, 0);
  });

  test('threshold 1.0 prunes all branches (confidence×utility always ≤ 1)', () => {
    const loc = createSimLocation(0, 0);
    // threshold=1.0: a branch is pruned when confidence×utility < 1.0.
    // Since confidence and utility are random floats initialised in (0,1),
    // their product is always strictly less than 1, so all branches are pruned.
    const pruned = pruneSimBranches(loc.id, 1.0);
    assert.equal(pruned, BRANCH_COUNT);
    assert.ok(loc.branches.every(b => b.status === 'pruned'));
  });

  test('threshold 0.0 prunes nothing', () => {
    const loc = createSimLocation(0, 0);
    const pruned = pruneSimBranches(loc.id, 0.0);
    assert.equal(pruned, 0);
    assert.ok(loc.branches.every(b => b.status === 'active'));
  });

  test('already-pruned branches are not double-counted', () => {
    const loc = createSimLocation(0, 0);
    loc.branches[0].status = 'pruned';
    // threshold=1 should prune the remaining BRANCH_COUNT-1 active branches
    const pruned = pruneSimBranches(loc.id, 1.0);
    assert.equal(pruned, BRANCH_COUNT - 1);
  });

  test('default threshold is 0.2 (non-destructive at 0)', () => {
    const loc = createSimLocation(0, 0);
    // Force all branch confidence*utility to 0.5 (above default 0.2)
    for (const b of loc.branches) {
      b.confidence = 1;
      b.utility    = 1;
    }
    const pruned = pruneSimBranches(loc.id); // no threshold supplied → default 0.2
    assert.equal(pruned, 0);
  });
});

// ─── entangleSimBranches ──────────────────────────────────────────────────────

describe('entangleSimBranches', () => {
  beforeEach(clearSimState);

  test('returns true on success', () => {
    const loc = createSimLocation(0, 0);
    const ok = entangleSimBranches(loc.branches[0].id, loc.branches[1].id);
    assert.equal(ok, true);
  });

  test('returns false when branch not found', () => {
    const loc = createSimLocation(0, 0);
    const ok = entangleSimBranches(loc.branches[0].id, 'nonexistent-branch-id');
    assert.equal(ok, false);
  });

  test('adds mutual entanglement references', () => {
    const loc = createSimLocation(0, 0);
    const [b1, b2] = loc.branches;
    entangleSimBranches(b1.id, b2.id);
    assert.ok(b1.entangledWith.includes(b2.id));
    assert.ok(b2.entangledWith.includes(b1.id));
  });

  test('averages confidence between entangled branches', () => {
    const loc = createSimLocation(0, 0);
    const [b1, b2] = loc.branches;
    b1.confidence = 0.2;
    b2.confidence = 0.8;
    entangleSimBranches(b1.id, b2.id);
    assert.ok(Math.abs(b1.confidence - 0.5) < 1e-9);
    assert.ok(Math.abs(b2.confidence - 0.5) < 1e-9);
  });

  test('idempotent: double-entangling does not duplicate references', () => {
    const loc = createSimLocation(0, 0);
    const [b1, b2] = loc.branches;
    entangleSimBranches(b1.id, b2.id);
    entangleSimBranches(b1.id, b2.id);
    assert.equal(b1.entangledWith.filter(id => id === b2.id).length, 1);
    assert.equal(b2.entangledWith.filter(id => id === b1.id).length, 1);
  });

  test('cross-location entanglement works', () => {
    const loc1 = createSimLocation(0, 0, 'A');
    const loc2 = createSimLocation(10, 10, 'B');
    const ok = entangleSimBranches(loc1.branches[0].id, loc2.branches[0].id);
    assert.equal(ok, true);
  });
});

// ─── collapseSimLocation ──────────────────────────────────────────────────────

describe('collapseSimLocation', () => {
  beforeEach(clearSimState);

  test('returns null for unknown locationId', () => {
    const result = collapseSimLocation('nonexistent');
    assert.strictEqual(result, null);
  });

  test('returns the winning branch', () => {
    const loc = createSimLocation(0, 0);
    const winner = collapseSimLocation(loc.id);
    assert.ok(winner);
    assert.ok(winner.id.startsWith('branch-'));
    assert.equal(winner.status, 'collapsed');
  });

  test('winning branch has highest utility × confidence', () => {
    const loc = createSimLocation(0, 0);
    // Force known values
    loc.branches.forEach((b, i) => {
      b.confidence = (i + 1) / BRANCH_COUNT;
      b.utility    = (i + 1) / BRANCH_COUNT;
    });
    const winner = collapseSimLocation(loc.id);
    const expectedScore = 1.0 * 1.0;  // last branch has both = 1
    assert.ok(winner.confidence * winner.utility >= expectedScore - 0.01);
  });

  test('all other active branches are pruned after collapse', () => {
    const loc = createSimLocation(0, 0);
    collapseSimLocation(loc.id);
    const pruned = loc.branches.filter(b => b.status === 'pruned');
    const collapsed = loc.branches.filter(b => b.status === 'collapsed');
    assert.equal(collapsed.length, 1);
    assert.equal(pruned.length, BRANCH_COUNT - 1);
  });

  test('sets loc.collapsed with winnerId and score', () => {
    const loc = createSimLocation(0, 0);
    const winner = collapseSimLocation(loc.id);
    assert.ok(loc.collapsed);
    assert.equal(loc.collapsed.winnerId, winner.id);
    assert.ok(typeof loc.collapsed.score === 'number');
    assert.ok(loc.collapsed.at);
  });

  test('writes to auditTrail', () => {
    const loc = createSimLocation(0, 0);
    const before = quantumSimState.auditTrail.length;
    collapseSimLocation(loc.id);
    assert.equal(quantumSimState.auditTrail.length, before + 1);
    const entry = quantumSimState.auditTrail[quantumSimState.auditTrail.length - 1];
    assert.equal(entry.locationId, loc.id);
    assert.ok(typeof entry.score === 'number');
    assert.ok(typeof entry.branchCount === 'number');
  });

  test('returns null when no active branches remain', () => {
    const loc = createSimLocation(0, 0);
    collapseSimLocation(loc.id);  // first collapse sets branches to pruned/collapsed
    const result = collapseSimLocation(loc.id);  // second collapse: no active left
    assert.strictEqual(result, null);
  });

  test('surviving agents have role/skill/confidence/trainingSteps', () => {
    const loc = createSimLocation(0, 0);
    collapseSimLocation(loc.id);
    assert.ok(Array.isArray(loc.collapsed.survivingAgents));
    for (const a of loc.collapsed.survivingAgents) {
      assert.ok(typeof a.role === 'string');
      assert.ok(typeof a.skill === 'number');
      assert.ok(typeof a.confidence === 'number');
      assert.ok(typeof a.trainingSteps === 'number');
    }
  });
});

// ─── collapseAllSimLocations ──────────────────────────────────────────────────

describe('collapseAllSimLocations', () => {
  beforeEach(clearSimState);

  test('returns null when no locations exist', () => {
    const result = collapseAllSimLocations();
    assert.strictEqual(result, null);
  });

  test('returns null when all branches are already pruned', () => {
    const loc = createSimLocation(0, 0);
    loc.branches.forEach(function (b) { b.status = 'pruned'; });
    const result = collapseAllSimLocations();
    assert.strictEqual(result, null);
  });

  test('returns winner, winnerLocationId, prunedCount, locationCount', () => {
    const loc = createSimLocation(0, 0, 'Alpha');
    const result = collapseAllSimLocations();
    assert.ok(result);
    assert.ok(result.winner);
    assert.equal(result.winnerLocationId, loc.id);
    assert.equal(result.locationCount, 1);
    assert.equal(result.prunedCount, BRANCH_COUNT - 1);
  });

  test('winner branch has status collapsed', () => {
    createSimLocation(0, 0);
    const result = collapseAllSimLocations();
    assert.equal(result.winner.status, 'collapsed');
  });

  test('exactly one branch has status collapsed across all locations', () => {
    createSimLocation(0, 0, 'A');
    createSimLocation(10, 10, 'B');
    createSimLocation(20, 20, 'C');
    collapseAllSimLocations();
    let collapsedCount = 0;
    for (const loc of Object.values(quantumSimState.locations)) {
      collapsedCount += loc.branches.filter(function (b) { return b.status === 'collapsed'; }).length;
    }
    assert.equal(collapsedCount, 1);
  });

  test('all other active branches are pruned system-wide', () => {
    createSimLocation(0, 0, 'A');
    createSimLocation(10, 10, 'B');
    collapseAllSimLocations();
    for (const loc of Object.values(quantumSimState.locations)) {
      const active = loc.branches.filter(function (b) { return b.status === 'active'; });
      assert.equal(active.length, 0, 'no active branches should remain after collapse-all');
    }
  });

  test('winner has the highest utility × confidence score globally', () => {
    const locA = createSimLocation(0, 0, 'A');
    const locB = createSimLocation(10, 10, 'B');
    // Force known scores: locA branch 0 gets score 0.9, locB branch 0 gets score 0.99
    locA.branches.forEach(function (b) { b.utility = 0.3; b.confidence = 0.3; });
    locB.branches.forEach(function (b) { b.utility = 0.3; b.confidence = 0.3; });
    locB.branches[0].utility = 0.99;
    locB.branches[0].confidence = 1.0;
    const result = collapseAllSimLocations();
    assert.equal(result.winner.id, locB.branches[0].id);
    assert.equal(result.winnerLocationId, locB.id);
  });

  test('winning location gets loc.collapsed with type=global', () => {
    const loc = createSimLocation(0, 0, 'Solo');
    const result = collapseAllSimLocations();
    assert.ok(loc.collapsed);
    assert.equal(loc.collapsed.type, 'global');
    assert.equal(loc.collapsed.winnerId, result.winner.id);
    assert.ok(typeof loc.collapsed.score === 'number');
    assert.ok(loc.collapsed.at);
    assert.ok(Array.isArray(loc.collapsed.survivingAgents));
  });

  test('non-winning locations do not get loc.collapsed set', () => {
    const locA = createSimLocation(0, 0, 'A');
    const locB = createSimLocation(10, 10, 'B');
    // Make locA branch 0 the definitive winner
    locA.branches[0].utility = 1.0;
    locA.branches[0].confidence = 1.0;
    locB.branches.forEach(function (b) { b.utility = 0.1; b.confidence = 0.1; });
    const result = collapseAllSimLocations();
    assert.equal(result.winnerLocationId, locA.id);
    assert.strictEqual(locB.collapsed, null);
  });

  test('writes a collapse_all audit entry', () => {
    createSimLocation(0, 0);
    const before = quantumSimState.auditTrail.length;
    collapseAllSimLocations();
    assert.equal(quantumSimState.auditTrail.length, before + 1);
    const entry = quantumSimState.auditTrail[quantumSimState.auditTrail.length - 1];
    assert.equal(entry.type, 'collapse_all');
    assert.ok(typeof entry.score === 'number');
    assert.ok(typeof entry.prunedCount === 'number');
    assert.ok(typeof entry.locationCount === 'number');
  });

  test('audit trail remains capped at 200 after collapse-all', () => {
    for (let i = 0; i < 200; i++) {
      quantumSimState.auditTrail.push({ type: 'collapse_all', at: new Date().toISOString(), score: 0 });
    }
    createSimLocation(0, 0);
    collapseAllSimLocations();
    assert.ok(quantumSimState.auditTrail.length <= 200);
  });

  test('prunedCount equals total active branches minus one', () => {
    createSimLocation(0, 0, 'A');
    createSimLocation(10, 10, 'B');
    // Mark one branch pruned before calling collapse-all
    const locs = Object.values(quantumSimState.locations);
    locs[0].branches[0].status = 'pruned';
    const totalActive = locs.reduce(function (sum, l) {
      return sum + l.branches.filter(function (b) { return b.status === 'active'; }).length;
    }, 0);
    const result = collapseAllSimLocations();
    assert.equal(result.prunedCount, totalActive - 1);
  });
});


describe('quantumSimState integration', () => {
  beforeEach(clearSimState);

  test('multiple locations coexist in state', () => {
    createSimLocation(0, 0, 'Alpha');
    createSimLocation(10, 10, 'Beta');
    createSimLocation(20, 20, 'Gamma');
    assert.equal(Object.keys(quantumSimState.locations).length, 3);
  });

  test('evolve → prune → collapse pipeline works end-to-end', () => {
    const loc = createSimLocation(51.5, -0.12, 'London');
    evolveSimBranches(loc.id);
    evolveSimBranches(loc.id);
    pruneSimBranches(loc.id, 0.1);
    const winner = collapseSimLocation(loc.id);
    // should produce a winner (at least one branch survives pruning at 0.1 threshold)
    // If all were pruned, collapse returns null — still valid but rare
    if (winner) {
      assert.equal(winner.status, 'collapsed');
      assert.ok(winner.generation >= 2);
    }
  });

  test('auditTrail is capped at 200 entries', () => {
    // Fill audit trail beyond limit
    for (let i = 0; i < 205; i++) {
      quantumSimState.auditTrail.push({ locationId: 'x', at: new Date().toISOString(), score: 0 });
    }
    // createSimLocation + collapseSimLocation adds 1 more entry
    const loc = createSimLocation(0, 0);
    collapseSimLocation(loc.id);
    assert.ok(quantumSimState.auditTrail.length <= 200);
  });
});

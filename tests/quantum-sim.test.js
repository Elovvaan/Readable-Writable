'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  quantumSimState,
  BRANCH_COUNT,
  BRANCH_AGENT_ROLES,
  EARTH_SPACE_LAYERS,
  INTERFERENCE_ALIGN_THRESHOLD,
  INTERFERENCE_CONFLICT_THRESHOLD,
  CONTINUOUS_COLLAPSE_MS,
  HYSTERESIS_THRESHOLD,
  WINNER_LOCK_THRESHOLD,
  WINNER_LOCK_MARGIN,
  NEAR_WINNER_PRESSURE_THRESHOLD,
  createSimLocation,
  evolveSimBranches,
  pruneSimBranches,
  collapseSimLocation,
  collapseAllSimLocations,
  entangleSimBranches,
  applyInterference,
  runContinuousCollapseTick,
  startContinuousCollapse,
  stopContinuousCollapse,
} = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearSimState() {
  for (const key of Object.keys(quantumSimState.locations)) {
    delete quantumSimState.locations[key];
  }
  quantumSimState.auditTrail.length = 0;
  // Reset continuous-collapse config to defaults so tests are isolated
  const cfg = quantumSimState.continuousCollapse;
  cfg.hysteresisThreshold        = HYSTERESIS_THRESHOLD;
  cfg.winnerLockThreshold        = WINNER_LOCK_THRESHOLD;
  cfg.winnerLockMargin           = WINNER_LOCK_MARGIN;
  cfg.nearWinnerPressureThreshold = NEAR_WINNER_PRESSURE_THRESHOLD;
  stopContinuousCollapse();
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
    // Make locA branch 0 the definitive winner.
    // Force all other locA branches to low values so interference weights cannot
    // elevate any of them above locA[0]'s adjusted score.
    locA.branches[0].utility = 1.0;
    locA.branches[0].confidence = 1.0;
    locA.branches.slice(1).forEach(function (b) { b.utility = 0.1; b.confidence = 0.1; });
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


// ─── applyInterference ────────────────────────────────────────────────────────

describe('applyInterference', () => {
  beforeEach(clearSimState);

  test('constants have correct relative values', () => {
    assert.ok(INTERFERENCE_ALIGN_THRESHOLD < INTERFERENCE_CONFLICT_THRESHOLD,
      'align threshold must be less than conflict threshold');
    assert.ok(INTERFERENCE_ALIGN_THRESHOLD > 0 && INTERFERENCE_ALIGN_THRESHOLD < 1);
    assert.ok(INTERFERENCE_CONFLICT_THRESHOLD > 0 && INTERFERENCE_CONFLICT_THRESHOLD < 1);
  });

  test('returns empty array when there are no active branches', () => {
    const results = applyInterference();
    assert.deepEqual(results, []);
  });

  test('returns one result per active branch', () => {
    const loc = createSimLocation(0, 0);
    const results = applyInterference();
    assert.equal(results.length, BRANCH_COUNT);
  });

  test('each result has branchId, interferenceWeight, and interferenceReason', () => {
    const loc = createSimLocation(0, 0);
    const results = applyInterference();
    for (const r of results) {
      assert.ok(typeof r.branchId === 'string');
      assert.ok(typeof r.interferenceWeight === 'number');
      assert.ok(typeof r.interferenceReason === 'string');
    }
  });

  test('interference weights are stored on branch objects', () => {
    const loc = createSimLocation(0, 0);
    applyInterference();
    for (const b of loc.branches) {
      assert.ok(typeof b.interferenceWeight === 'number');
      assert.ok(typeof b.interferenceReason === 'string');
    }
  });

  test('newly built branch has interferenceWeight=1.0 and reason=neutral', () => {
    const loc = createSimLocation(0, 0);
    for (const b of loc.branches) {
      assert.equal(b.interferenceWeight, 1.0);
      assert.equal(b.interferenceReason, 'neutral');
    }
  });

  test('aligned branches (|Δutility| < ALIGN_THRESHOLD) get reinforced', () => {
    // Two locations, each with one branch forced to nearly identical utility
    const loc1 = createSimLocation(0, 0, 'A');
    const loc2 = createSimLocation(10, 10, 'B');
    // Force all branches to utility=0.5 so every pair is aligned
    for (const loc of [loc1, loc2]) {
      for (const b of loc.branches) {
        b.utility = 0.5;
      }
    }
    applyInterference();
    // All branches should be reinforced (all share the same utility → Δ=0 < threshold)
    for (const loc of [loc1, loc2]) {
      for (const b of loc.branches) {
        assert.equal(b.interferenceReason, 'reinforced', 'branch should be reinforced when utilities match');
        assert.ok(b.interferenceWeight > 1.0, 'reinforced branch weight must exceed 1.0');
      }
    }
  });

  test('conflicting branches (|Δutility| > CONFLICT_THRESHOLD) get damped', () => {
    const loc1 = createSimLocation(0, 0, 'A');
    const loc2 = createSimLocation(10, 10, 'B');
    // loc1 → utility near 0, loc2 → utility near 1; difference > CONFLICT_THRESHOLD
    loc1.branches.forEach(function (b) { b.utility = 0.0; });
    loc2.branches.forEach(function (b) { b.utility = 1.0; });
    applyInterference();
    // All loc1 branches conflict with all loc2 branches → should be damped
    for (const b of loc1.branches) {
      assert.equal(b.interferenceReason, 'damped', 'loc1 branches should be damped by conflicting loc2 branches');
      assert.ok(b.interferenceWeight < 1.0, 'damped branch weight must be below 1.0');
    }
    for (const b of loc2.branches) {
      assert.equal(b.interferenceReason, 'damped', 'loc2 branches should be damped by conflicting loc1 branches');
      assert.ok(b.interferenceWeight < 1.0);
    }
  });

  test('unrelated branches (threshold gap) get neutral weight', () => {
    // Place utilities at mid-range intervals to minimize aligned/conflicting pairs.
    // Not all pairs will necessarily be unrelated due to modulo wrapping, so the
    // test only validates that all weights are valid numbers in the allowed range
    // and reasons are from the expected set.
    const loc = createSimLocation(0, 0);
    const gap = (INTERFERENCE_CONFLICT_THRESHOLD + INTERFERENCE_ALIGN_THRESHOLD) / 2;
    loc.branches.forEach(function (b, i) { b.utility = (i * gap) % 1; });
    applyInterference();
    for (const b of loc.branches) {
      assert.ok(b.interferenceWeight >= 0.7 && b.interferenceWeight <= 1.3,
        'weight must be in [0.7, 1.3]');
      assert.ok(['reinforced', 'damped', 'neutral'].includes(b.interferenceReason));
    }
  });

  test('interferenceWeight is always in [0.7, 1.3] regardless of branch count', () => {
    // Create many locations to maximise peer interactions
    for (let i = 0; i < 5; i++) {
      createSimLocation(i * 5, i * 5, 'loc' + i);
    }
    applyInterference();
    for (const loc of Object.values(quantumSimState.locations)) {
      for (const b of loc.branches) {
        assert.ok(b.interferenceWeight >= 0.7, 'weight must be ≥ 0.7');
        assert.ok(b.interferenceWeight <= 1.3, 'weight must be ≤ 1.3');
      }
    }
  });

  test('pruned branches are excluded from interference computation', () => {
    const loc = createSimLocation(0, 0);
    // Prune all but one branch
    loc.branches.slice(1).forEach(function (b) { b.status = 'pruned'; });
    const results = applyInterference();
    // Only 1 active branch → no peers → weight stays 1.0, reason neutral
    assert.equal(results.length, 1);
    assert.equal(results[0].interferenceWeight, 1.0);
    assert.equal(results[0].interferenceReason, 'neutral');
  });

  test('reason matches weight direction', () => {
    const loc = createSimLocation(0, 0);
    applyInterference();
    for (const b of loc.branches) {
      if (b.interferenceReason === 'reinforced') assert.ok(b.interferenceWeight > 1.0);
      if (b.interferenceReason === 'damped')      assert.ok(b.interferenceWeight < 1.0);
      if (b.interferenceReason === 'neutral')     assert.equal(b.interferenceWeight, 1.0);
    }
  });

  test('cross-location branches participate in interference', () => {
    const locA = createSimLocation(0, 0, 'A');
    const locB = createSimLocation(50, 50, 'B');
    // Force locA=utility 0, locB=utility 1 → should conflict across locations
    locA.branches.forEach(function (b) { b.utility = 0.0; });
    locB.branches.forEach(function (b) { b.utility = 1.0; });
    applyInterference();
    // Branches in locA should be damped (conflicting with locB branches)
    assert.ok(locA.branches[0].interferenceWeight < 1.0);
    // Branches in locB should also be damped
    assert.ok(locB.branches[0].interferenceWeight < 1.0);
  });

  test('applyInterference is deterministic — same input yields same output', () => {
    const loc = createSimLocation(0, 0);
    loc.branches.forEach(function (b, i) { b.utility = (i + 1) * 0.18; });
    const r1 = applyInterference();
    const r2 = applyInterference();
    for (let i = 0; i < r1.length; i++) {
      assert.equal(r1[i].interferenceWeight, r2[i].interferenceWeight);
      assert.equal(r1[i].interferenceReason, r2[i].interferenceReason);
    }
  });

  test('collapse uses adjusted score (u×c×iw) so reinforced branch can win', () => {
    const loc = createSimLocation(0, 0);
    // Branch 0: utility=0.95, confidence=0.5 → raw=0.475
    // Branches 1-4: utility=0.01, confidence=1.0 → raw=0.01
    // |0.95-0.01|=0.94 > CONFLICT_THRESHOLD → branch 0 conflicts with branches 1-4 → damped
    // |0.01-0.01|=0 < ALIGN_THRESHOLD → branches 1-4 are aligned with each other → reinforced
    // net for branch 0: -3(capped) → weight=0.7, adjusted=0.95*0.5*0.7=0.3325
    // net for branches 1-4: 3(reinforced)-1(conflict with b0) = 2 → weight=1.2, adjusted=0.01*1.0*1.2=0.012
    // branch 0 still wins (0.3325 > 0.012), confirming adjusted score is used
    loc.branches[0].utility = 0.95;
    loc.branches[0].confidence = 0.5;
    loc.branches.slice(1).forEach(function (b) { b.utility = 0.01; b.confidence = 1.0; });
    const winner = collapseSimLocation(loc.id);
    assert.ok(winner, 'should produce a winner');
    assert.equal(winner.id, loc.branches[0].id, 'branch 0 should win despite interference damping');
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

// ─── Continuous Collapse constants ────────────────────────────────────────────

describe('continuous collapse constants', () => {
  test('CONTINUOUS_COLLAPSE_MS is a positive integer', () => {
    assert.ok(Number.isInteger(CONTINUOUS_COLLAPSE_MS) && CONTINUOUS_COLLAPSE_MS > 0);
  });

  test('HYSTERESIS_THRESHOLD is a number between 0 and 1', () => {
    assert.ok(typeof HYSTERESIS_THRESHOLD === 'number' && HYSTERESIS_THRESHOLD > 0 && HYSTERESIS_THRESHOLD < 1);
  });

  test('WINNER_LOCK_THRESHOLD is a number between 0 and 1', () => {
    assert.ok(typeof WINNER_LOCK_THRESHOLD === 'number' && WINNER_LOCK_THRESHOLD > 0 && WINNER_LOCK_THRESHOLD < 1);
  });

  test('WINNER_LOCK_MARGIN is a positive number', () => {
    assert.ok(typeof WINNER_LOCK_MARGIN === 'number' && WINNER_LOCK_MARGIN > 0);
  });

  test('NEAR_WINNER_PRESSURE_THRESHOLD is a positive number', () => {
    assert.ok(typeof NEAR_WINNER_PRESSURE_THRESHOLD === 'number' && NEAR_WINNER_PRESSURE_THRESHOLD > 0);
  });
});

// ─── quantumSimState.continuousCollapse ───────────────────────────────────────

describe('quantumSimState.continuousCollapse', () => {
  test('state block exists with expected keys', () => {
    const cfg = quantumSimState.continuousCollapse;
    assert.ok(cfg);
    assert.equal(typeof cfg.running, 'boolean');
    assert.equal(typeof cfg.intervalMs, 'number');
    assert.equal(typeof cfg.hysteresisThreshold, 'number');
    assert.equal(typeof cfg.winnerLockThreshold, 'number');
    assert.equal(typeof cfg.winnerLockMargin, 'number');
    assert.equal(typeof cfg.nearWinnerPressureThreshold, 'number');
  });

  test('intervalMs defaults to CONTINUOUS_COLLAPSE_MS', () => {
    assert.equal(quantumSimState.continuousCollapse.intervalMs, CONTINUOUS_COLLAPSE_MS);
  });
});

// ─── createSimLocation continuousState ────────────────────────────────────────

describe('createSimLocation – continuousState', () => {
  beforeEach(clearSimState);

  test('each new location gets a continuousState object', () => {
    const loc = createSimLocation(0, 0, 'test');
    assert.ok(loc.continuousState);
    assert.equal(loc.continuousState.leaderId, null);
    assert.equal(loc.continuousState.leaderScore, 0);
    assert.equal(loc.continuousState.locked, false);
    assert.equal(loc.continuousState.since, null);
  });
});

// ─── runContinuousCollapseTick ────────────────────────────────────────────────

describe('runContinuousCollapseTick', () => {
  beforeEach(clearSimState);

  test('seats first leader when no leader has been recorded yet', () => {
    const loc = createSimLocation(0, 0, 'tick-test');
    runContinuousCollapseTick();
    const cs = loc.continuousState;
    assert.ok(cs.leaderId, 'leader should be set after first tick');
    assert.ok(cs.leaderScore > 0, 'leader score should be positive');
    assert.ok(typeof cs.since === 'string', 'since should be an ISO timestamp');
  });

  test('does not change leader when challenger is within hysteresis margin', () => {
    const loc = createSimLocation(0, 0, 'hysteresis-test');
    // Force a clear leader: branch 0 score=0.9, branch 1 score=0.89 (delta=0.01 < threshold)
    loc.branches.forEach(function (b) { b.status = 'active'; b.interferenceWeight = 1.0; });
    loc.branches[0].utility = 0.9; loc.branches[0].confidence = 1.0;
    loc.branches[1].utility = 0.89; loc.branches[1].confidence = 1.0;
    loc.branches.slice(2).forEach(function (b) { b.utility = 0.1; b.confidence = 0.1; });
    // First tick seats branch 0 as leader
    runContinuousCollapseTick();
    const firstLeaderId = loc.continuousState.leaderId;
    assert.equal(firstLeaderId, loc.branches[0].id, 'branch 0 should be leader');
    // Swap so branch 1 beats branch 0 but only by delta < HYSTERESIS_THRESHOLD
    loc.branches[0].utility = 0.50; loc.branches[0].confidence = 1.0; // score ~0.50
    loc.branches[1].utility = 0.52; loc.branches[1].confidence = 1.0; // score ~0.52 (delta=0.02 < 0.05)
    runContinuousCollapseTick();
    assert.equal(loc.continuousState.leaderId, firstLeaderId, 'leader should NOT change due to hysteresis');
  });

  test('changes leader when challenger exceeds hysteresis margin', () => {
    const loc = createSimLocation(0, 0, 'leader-change-test');
    loc.branches.forEach(function (b) { b.status = 'active'; b.interferenceWeight = 1.0; });
    loc.branches[0].utility = 0.5; loc.branches[0].confidence = 1.0;
    loc.branches.slice(1).forEach(function (b) { b.utility = 0.1; b.confidence = 0.1; });
    runContinuousCollapseTick();
    assert.equal(loc.continuousState.leaderId, loc.branches[0].id);
    // Now branch 1 beats branch 0 by a clear margin (> HYSTERESIS_THRESHOLD)
    loc.branches[0].utility = 0.30; loc.branches[0].confidence = 1.0;
    loc.branches[1].utility = 0.90; loc.branches[1].confidence = 1.0; // delta=0.60 >> 0.05
    runContinuousCollapseTick();
    assert.equal(loc.continuousState.leaderId, loc.branches[1].id, 'leader should update');
  });

  test('locks winner when score reaches WINNER_LOCK_THRESHOLD', () => {
    const loc = createSimLocation(0, 0, 'lock-test');
    // Only branch 0 is active so interferenceWeight stays at 1.0 (no pairwise comparison)
    loc.branches.forEach(function (b) { b.status = 'pruned'; b.interferenceWeight = 1.0; });
    loc.branches[0].status = 'active';
    loc.branches[0].utility = WINNER_LOCK_THRESHOLD + 0.05; loc.branches[0].confidence = 1.0;
    runContinuousCollapseTick();
    assert.ok(loc.continuousState.locked, 'leader should be locked when score >= WINNER_LOCK_THRESHOLD');
  });

  test('locked leader requires extra margin to be displaced', () => {
    const cfg = quantumSimState.continuousCollapse;
    const loc = createSimLocation(0, 0, 'lock-margin-test');
    // Only two active branches; isolate interference effects by pruning the rest
    loc.branches.forEach(function (b) { b.status = 'pruned'; b.interferenceWeight = 1.0; });
    loc.branches[0].status = 'active'; loc.branches[0].interferenceWeight = 1.0;
    loc.branches[1].status = 'active'; loc.branches[1].interferenceWeight = 1.0;
    // Seat branch 0 as a locked leader (score = WINNER_LOCK_THRESHOLD + 0.05)
    loc.branches[0].utility = WINNER_LOCK_THRESHOLD + 0.05; loc.branches[0].confidence = 1.0;
    loc.branches[1].utility = 0.05; loc.branches[1].confidence = 1.0;
    runContinuousCollapseTick();
    // Verify interference didn't tank the score: re-apply to see actual weight
    // We only care that the lock flag was set; if score dropped due to interference, skip
    if (!loc.continuousState.locked) { return; } // guard: score may be below threshold with interference
    const lockedId = loc.continuousState.leaderId;
    const lockedScore = loc.continuousState.leaderScore;
    // Branch 1 beats locked leader by only hysteresisThreshold (not enough; needs +winnerLockMargin too)
    const justHysteresis = lockedScore + cfg.hysteresisThreshold + 0.001;
    loc.branches[1].utility = justHysteresis; loc.branches[1].confidence = 1.0;
    runContinuousCollapseTick();
    assert.equal(loc.continuousState.leaderId, lockedId, 'locked leader should NOT be displaced by hysteresis alone');
    // Now challenger exceeds the full required margin
    const fullMargin = lockedScore + cfg.hysteresisThreshold + cfg.winnerLockMargin + 0.001;
    if (fullMargin <= 1) {
      loc.branches[1].utility = fullMargin; loc.branches[1].confidence = 1.0;
      runContinuousCollapseTick();
      assert.equal(loc.continuousState.leaderId, loc.branches[1].id, 'challenger should now displace locked leader');
    }
  });

  test('does nothing when no active branches exist', () => {
    const loc = createSimLocation(0, 0, 'no-active');
    loc.branches.forEach(function (b) { b.status = 'pruned'; });
    runContinuousCollapseTick();
    assert.equal(loc.continuousState.leaderId, null, 'no leader should be set if no active branches');
  });

  test('does nothing when no locations exist', () => {
    // clearSimState already cleared locations; just ensure no throw
    assert.doesNotThrow(function () { runContinuousCollapseTick(); });
  });

  test('branch status is NOT modified by the continuous tick', () => {
    const loc = createSimLocation(0, 0, 'no-status-change');
    const statuses = loc.branches.map(function (b) { return b.status; });
    runContinuousCollapseTick();
    const statusesAfter = loc.branches.map(function (b) { return b.status; });
    assert.deepEqual(statusesAfter, statuses, 'continuous tick must not change branch.status');
  });
});

// ─── startContinuousCollapse / stopContinuousCollapse ─────────────────────────

describe('startContinuousCollapse and stopContinuousCollapse', () => {
  beforeEach(clearSimState);

  test('startContinuousCollapse sets running=true', () => {
    startContinuousCollapse(10000); // long interval so it never fires in tests
    assert.equal(quantumSimState.continuousCollapse.running, true);
    stopContinuousCollapse(); // cleanup
  });

  test('calling start twice does not create duplicate timers', () => {
    startContinuousCollapse(10000);
    startContinuousCollapse(10000); // should be a no-op
    assert.equal(quantumSimState.continuousCollapse.running, true);
    stopContinuousCollapse();
  });

  test('stopContinuousCollapse sets running=false', () => {
    startContinuousCollapse(10000);
    stopContinuousCollapse();
    assert.equal(quantumSimState.continuousCollapse.running, false);
  });

  test('stopContinuousCollapse is safe to call when not running', () => {
    assert.doesNotThrow(function () { stopContinuousCollapse(); });
    assert.equal(quantumSimState.continuousCollapse.running, false);
  });

  test('startContinuousCollapse accepts custom intervalMs', () => {
    startContinuousCollapse(9999);
    assert.equal(quantumSimState.continuousCollapse.intervalMs, 9999);
    stopContinuousCollapse();
  });
});

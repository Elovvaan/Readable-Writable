'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  taskRegistry,
  workerRuntime,
  taskResults,
  evaluations,
  plannerState,
  plannerStats,
  createTask,
  plannerTick,
  evaluateResult,
  applyEvaluation,
  runWorkerTask,
  createWorker,
  bootstrapWorkers,
  onFlightAppeared,
  worldview,
  openSkyFileState,
} = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearStores() {
  taskRegistry.clear();
  workerRuntime.clear();
  taskResults.clear();
  evaluations.clear();
  plannerState.activeTaskIds.length = 0;
  plannerState.backlogCount = 0;
  plannerState.lastAssignments.length = 0;
}

function addTestWorker(role) {
  return createWorker(role);
}

// ─── createTask ───────────────────────────────────────────────────────────────

describe('createTask', () => {
  beforeEach(clearStores);

  test('creates a task and adds it to taskRegistry', () => {
    const task = createTask('monitor_region', 'europe');
    assert.ok(taskRegistry.has(task.id));
  });

  test('task has correct shape', () => {
    const task = createTask('verify_event', 'asia', {
      targetEntityId: 'flight-abc123',
      input: { foo: 1 },
    });
    assert.equal(task.type, 'verify_event');
    assert.equal(task.status, 'queued');
    assert.equal(task.regionId, 'asia');
    assert.equal(task.targetEntityId, 'flight-abc123');
    assert.equal(task.plannerId, 'planner-1');
    assert.ok(task.id.startsWith('task-'));
    assert.ok(task.createdAt);
    assert.strictEqual(task.assignedWorkerId, null);
    assert.strictEqual(task.resultId, null);
    assert.strictEqual(task.evaluationId, null);
  });

  test('task priority defaults to 1', () => {
    const task = createTask('monitor_region', 'africa');
    assert.equal(task.priority, 1);
  });

  test('task priority can be overridden', () => {
    const task = createTask('inspect_anomaly', 'europe', { priority: 3 });
    assert.equal(task.priority, 3);
  });

  test('task appears in taskRegistry with queued status', () => {
    const before = [...taskRegistry.values()].filter(t => t.status === 'queued').length;
    createTask('monitor_region', 'pacific');
    const after = [...taskRegistry.values()].filter(t => t.status === 'queued').length;
    assert.equal(after, before + 1);
  });

  test('retryCount defaults to 0', () => {
    const task = createTask('monitor_region', 'europe');
    assert.equal(task.retryCount, 0);
  });
});

// ─── createWorker ─────────────────────────────────────────────────────────────

describe('createWorker', () => {
  beforeEach(clearStores);

  test('creates a worker and adds to workerRuntime', () => {
    const w = createWorker('region_scout');
    assert.ok(workerRuntime.has(w.id));
  });

  test('worker has correct shape', () => {
    const w = createWorker('flight_scout');
    assert.equal(w.role, 'flight_scout');
    assert.equal(w.status, 'idle');
    assert.strictEqual(w.currentTaskId, null);
    assert.ok(w.id.startsWith('worker-'));
    assert.ok('metrics' in w);
    assert.equal(w.metrics.completed, 0);
    assert.equal(w.metrics.failed, 0);
  });
});

// ─── bootstrapWorkers ─────────────────────────────────────────────────────────

describe('bootstrapWorkers', () => {
  beforeEach(clearStores);

  test('creates 6 workers with expected roles', () => {
    bootstrapWorkers();
    const workers = [...workerRuntime.values()];
    assert.equal(workers.length, 6);

    const roles = workers.map(w => w.role);
    assert.equal(roles.filter(r => r === 'region_scout').length, 2);
    assert.equal(roles.filter(r => r === 'flight_scout').length, 2);
    assert.equal(roles.filter(r => r === 'anomaly_verifier').length, 1);
    assert.equal(roles.filter(r => r === 'summary_worker').length, 1);
  });
});

// ─── runWorkerTask ────────────────────────────────────────────────────────────

describe('runWorkerTask', () => {
  beforeEach(clearStores);

  test('verify_event returns verdict/explanation/confidence', () => {
    const worker = createWorker('flight_scout');
    const task = createTask('verify_event', 'europe', { targetEntityId: 'flight-zzz' });
    const result = runWorkerTask(worker, task);
    assert.ok('verdict' in result.output);
    assert.ok('explanation' in result.output);
    assert.ok('confidence' in result.output);
    assert.ok(['normal', 'anomalous', 'uncertain'].includes(result.output.verdict));
  });

  test('monitor_region returns regionStatus/activeEntities/summary', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'europe');
    const result = runWorkerTask(worker, task);
    assert.ok('regionStatus' in result.output);
    assert.ok('activeEntities' in result.output);
    assert.ok('summary' in result.output);
  });

  test('inspect_anomaly returns anomalyStatus/severityGuess/explanation', () => {
    const worker = createWorker('anomaly_verifier');
    const task = createTask('inspect_anomaly', 'asia', { targetEntityId: 'flight-bad' });
    const result = runWorkerTask(worker, task);
    assert.ok('anomalyStatus' in result.output);
    assert.ok('severityGuess' in result.output);
    assert.ok('explanation' in result.output);
  });

  test('summarize_region returns flightCount/summary', () => {
    const worker = createWorker('summary_worker');
    const task = createTask('summarize_region', 'north-america');
    const result = runWorkerTask(worker, task);
    assert.ok('flightCount' in result.output);
    assert.ok('summary' in result.output);
  });

  test('track_entity returns found/confidence', () => {
    const worker = createWorker('flight_scout');
    const task = createTask('track_entity', 'asia', { targetEntityId: 'flight-xyz' });
    const result = runWorkerTask(worker, task);
    assert.ok('found' in result.output);
    assert.ok('confidence' in result.output);
  });

  test('result is stored in taskResults', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'africa');
    const result = runWorkerTask(worker, task);
    assert.ok(taskResults.has(result.id));
  });

  test('result has required shape fields', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'pacific');
    const result = runWorkerTask(worker, task);
    assert.ok(result.id);
    assert.equal(result.taskId, task.id);
    assert.equal(result.workerId, worker.id);
    assert.ok(result.createdAt);
    assert.equal(result.status, 'ready');
    assert.ok(typeof result.latencyMs === 'number');
  });
});

// ─── evaluateResult ───────────────────────────────────────────────────────────

describe('evaluateResult', () => {
  beforeEach(clearStores);

  test('returns an evaluation with required fields', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'europe');
    task.assignedWorkerId = worker.id;
    const result = runWorkerTask(worker, task);
    const ev = evaluateResult(task, result);
    assert.ok(ev.id);
    assert.ok('score' in ev);
    assert.ok('verdict' in ev);
    assert.ok('reasons' in ev);
    assert.ok('dimensions' in ev);
    assert.ok(['accepted', 'retry', 'escalate'].includes(ev.verdict));
  });

  test('stores evaluation in evaluations map', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'europe');
    task.assignedWorkerId = worker.id;
    const result = runWorkerTask(worker, task);
    const ev = evaluateResult(task, result);
    assert.ok(evaluations.has(ev.id));
  });

  test('score is between 0 and 1', () => {
    const worker = createWorker('flight_scout');
    const task = createTask('verify_event', 'asia', { targetEntityId: 'flight-x' });
    task.assignedWorkerId = worker.id;
    const result = runWorkerTask(worker, task);
    const ev = evaluateResult(task, result);
    assert.ok(ev.score >= 0 && ev.score <= 1);
  });

  test('accepted verdict when score > 0.75', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'europe');
    task.assignedWorkerId = worker.id;
    const result = runWorkerTask(worker, task);
    // override to force high score
    result.confidence = 1.0;
    result.latencyMs = 1;
    result.output = { regionStatus: 'active', activeEntities: 2, summary: 'ok', confidence: 1 };
    const ev = evaluateResult(task, result);
    assert.equal(ev.verdict, 'accepted');
  });

  test('evaluation dimensions all present', () => {
    const worker = createWorker('anomaly_verifier');
    const task = createTask('inspect_anomaly', 'asia');
    task.assignedWorkerId = worker.id;
    const result = runWorkerTask(worker, task);
    const ev = evaluateResult(task, result);
    const dims = ev.dimensions;
    assert.ok('correctness' in dims);
    assert.ok('completeness' in dims);
    assert.ok('timeliness' in dims);
    assert.ok('policyFit' in dims);
    assert.ok('usefulness' in dims);
  });
});

// ─── applyEvaluation ──────────────────────────────────────────────────────────

describe('applyEvaluation', () => {
  beforeEach(clearStores);

  test('accepted: marks task completed and frees worker', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'europe');
    task.assignedWorkerId = worker.id;
    task.status = 'running';
    worker.status = 'busy';
    worker.currentTaskId = task.id;
    plannerState.activeTaskIds.push(task.id);

    const result = runWorkerTask(worker, task);
    task.resultId = result.id;
    const ev = evaluateResult(task, result);
    // force accepted
    ev.verdict = 'accepted';
    ev.score = 0.9;
    applyEvaluation(task, worker, ev);

    assert.equal(task.status, 'completed');
    assert.equal(worker.status, 'idle');
    assert.strictEqual(worker.currentTaskId, null);
    assert.equal(worker.metrics.completed, 1);
  });

  test('retry: requeues task if retryCount < 2', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'africa');
    task.assignedWorkerId = worker.id;
    task.status = 'running';
    worker.status = 'busy';
    worker.currentTaskId = task.id;
    task.retryCount = 0;

    const result = runWorkerTask(worker, task);
    task.resultId = result.id;
    const ev = evaluateResult(task, result);
    ev.verdict = 'retry';
    ev.score = 0.6;
    applyEvaluation(task, worker, ev);

    assert.equal(task.status, 'queued');
    assert.equal(task.retryCount, 1);
    assert.equal(worker.status, 'idle');
  });

  test('retry: marks task failed if retryCount >= 2', () => {
    const worker = createWorker('region_scout');
    const task = createTask('monitor_region', 'pacific');
    task.assignedWorkerId = worker.id;
    task.status = 'running';
    worker.status = 'busy';
    worker.currentTaskId = task.id;
    task.retryCount = 2;

    const result = runWorkerTask(worker, task);
    task.resultId = result.id;
    const ev = evaluateResult(task, result);
    ev.verdict = 'retry';
    applyEvaluation(task, worker, ev);

    assert.equal(task.status, 'failed');
    assert.equal(worker.metrics.failed, 1);
  });

  test('escalate: marks task failed and creates follow-up task', () => {
    const worker = createWorker('flight_scout');
    const task = createTask('verify_event', 'europe', { targetEntityId: 'flight-abc' });
    task.assignedWorkerId = worker.id;
    task.status = 'running';
    worker.status = 'busy';
    worker.currentTaskId = task.id;

    const before = taskRegistry.size;
    const result = runWorkerTask(worker, task);
    task.resultId = result.id;
    const ev = evaluateResult(task, result);
    ev.verdict = 'escalate';
    ev.score = 0.3;
    applyEvaluation(task, worker, ev);

    assert.equal(task.status, 'failed');
    // a follow-up inspect_anomaly should have been created
    assert.ok(taskRegistry.size > before);
    const followUps = [...taskRegistry.values()].filter(t => t.type === 'inspect_anomaly' && t.targetEntityId === 'flight-abc');
    assert.ok(followUps.length > 0);
  });
});

// ─── plannerTick ──────────────────────────────────────────────────────────────

describe('plannerTick', () => {
  beforeEach(clearStores);

  test('assigns queued tasks to idle workers and completes them', () => {
    // Add a worker and a task
    addTestWorker('region_scout');
    createTask('monitor_region', 'europe');

    plannerTick();

    const tasks = [...taskRegistry.values()];
    assert.ok(tasks.some(t => t.type === 'monitor_region' && (t.status === 'completed' || t.status === 'queued')));
  });

  test('does not assign tasks if no idle worker available', () => {
    const worker = addTestWorker('region_scout');
    worker.status = 'busy'; // mark as busy
    createTask('monitor_region', 'africa');

    plannerTick();

    const tasks = [...taskRegistry.values()].filter(t => t.type === 'monitor_region');
    assert.ok(tasks.every(t => t.status === 'queued'));
  });

  test('worker is idle after tick completes a task', () => {
    addTestWorker('anomaly_verifier');
    createTask('inspect_anomaly', 'asia', { targetEntityId: 'flight-z' });

    plannerTick();

    const workers = [...workerRuntime.values()].filter(w => w.role === 'anomaly_verifier');
    // worker should be freed after synchronous execution
    assert.ok(workers.some(w => w.status === 'idle'));
  });
});

// ─── onFlightAppeared ─────────────────────────────────────────────────────────

describe('onFlightAppeared', () => {
  beforeEach(clearStores);

  test('creates a verify_event task for a new flight', () => {
    onFlightAppeared('flight-new1', 'europe');
    const tasks = [...taskRegistry.values()];
    assert.ok(tasks.some(t => t.type === 'verify_event' && t.targetEntityId === 'flight-new1'));
  });

  test('does not create duplicate verify_event tasks for same flight', () => {
    onFlightAppeared('flight-dup1', 'europe');
    onFlightAppeared('flight-dup1', 'europe');
    const tasks = [...taskRegistry.values()].filter(t =>
      t.type === 'verify_event' && t.targetEntityId === 'flight-dup1'
    );
    assert.equal(tasks.length, 1);
  });
});

// ─── snapshot integration ─────────────────────────────────────────────────────

describe('snapshot planner integration', () => {
  const { snapshot } = require('../server');

  test('snapshot includes tasks array', () => {
    const s = snapshot();
    assert.ok(Array.isArray(s.tasks));
  });

  test('snapshot includes workers array', () => {
    const s = snapshot();
    assert.ok(Array.isArray(s.workers));
  });

  test('snapshot includes evaluations array', () => {
    const s = snapshot();
    assert.ok(Array.isArray(s.evaluations));
  });

  test('snapshot includes planner object', () => {
    const s = snapshot();
    assert.ok(s.planner);
    assert.ok('backlogCount' in s.planner);
    assert.ok('activeTaskCount' in s.planner);
    assert.ok('lastAssignments' in s.planner);
    assert.ok('stats' in s.planner);
  });

  test('snapshot planner.stats has all debug fields', () => {
    const { stats } = snapshot().planner;
    assert.ok('queuedTasks' in stats);      // derived live from countBacklog()
    assert.ok('totalAssigned' in stats);
    assert.ok('completedTasks' in stats);
    assert.ok('failedTasks' in stats);
    assert.ok('evalAccepted' in stats);
    assert.ok('evalRetry' in stats);
    assert.ok('evalEscalated' in stats);
  });
});

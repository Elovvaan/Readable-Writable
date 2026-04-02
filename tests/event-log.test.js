'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { emit, eventLog } = require('../server');

describe('emit / event log', () => {
  beforeEach(() => {
    // Reset the shared event log before every test.
    eventLog.length = 0;
  });

  test('adds an event to the log', () => {
    emit('system', 'hello', null);
    assert.equal(eventLog.length, 1);
  });

  test('event contains the expected fields', () => {
    emit('agent', 'agent moved', { id: 'a1' }, 'agent');
    const ev = eventLog[0];
    assert.equal(ev.kind, 'agent');
    assert.equal(ev.msg, 'agent moved');
    assert.deepEqual(ev.patch, { id: 'a1' });
    assert.equal(ev.entityType, 'agent');
    assert.ok('ts' in ev);
  });

  test('entityType defaults to null when omitted', () => {
    emit('system', 'tick', { tick: 1 });
    assert.equal(eventLog[0].entityType, null);
  });

  test('ts is a valid ISO 8601 timestamp', () => {
    emit('region', 'entered europe', null);
    const ts = eventLog[0].ts;
    assert.ok(!isNaN(new Date(ts).getTime()), `invalid timestamp: ${ts}`);
  });

  test('patch is stored as-is (including null)', () => {
    emit('system', 'no patch', null);
    assert.equal(eventLog[0].patch, null);
  });

  test('multiple events are appended in order', () => {
    emit('system', 'first', null);
    emit('system', 'second', null);
    emit('system', 'third', null);
    assert.equal(eventLog.length, 3);
    assert.equal(eventLog[0].msg, 'first');
    assert.equal(eventLog[2].msg, 'third');
  });

  test('log is capped at 100 entries', () => {
    for (let i = 0; i < 110; i++) emit('system', `event ${i}`, null);
    assert.equal(eventLog.length, 100);
  });

  test('oldest entries are dropped when the cap is exceeded', () => {
    for (let i = 0; i < 105; i++) emit('system', `event ${i}`, null);
    // events 0-4 should have been removed; 5 is now the oldest
    assert.equal(eventLog[0].msg, 'event 5');
    assert.equal(eventLog[99].msg, 'event 104');
  });

  test('adding exactly 100 events does not drop any', () => {
    for (let i = 0; i < 100; i++) emit('system', `event ${i}`, null);
    assert.equal(eventLog.length, 100);
    assert.equal(eventLog[0].msg, 'event 0');
    assert.equal(eventLog[99].msg, 'event 99');
  });

  test('supports all three kind values', () => {
    emit('agent', 'a', null);
    emit('region', 'r', null);
    emit('system', 's', null);
    const kinds = eventLog.map(e => e.kind);
    assert.deepEqual(kinds, ['agent', 'region', 'system']);
  });
});

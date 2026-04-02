'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { wsSend, wsParse } = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSocket() {
  const writes = [];
  const socket = new EventEmitter();
  socket.write = (buf) => { writes.push(Buffer.from(buf)); return true; };
  socket.destroy = () => { socket.destroyed = true; };
  socket.destroyed = false;
  socket.writable = true;
  socket._writes = writes;
  socket._written = () => Buffer.concat(writes);
  return socket;
}

// Decode the payload from a wsSend-produced text frame (opcode 0x1, unmasked).
function decodeTextFrame(buf) {
  const byte1 = buf[1] & 0x7f;
  let offset, payloadLen;
  if (byte1 <= 125) {
    payloadLen = byte1;
    offset = 2;
  } else if (byte1 === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  return buf.slice(offset, offset + payloadLen).toString('utf8');
}

// Build a masked client-to-server WebSocket text frame (opcode 0x1).
// Assumes payload < 126 bytes (fine for test JSON).
function buildMaskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  const header = Buffer.alloc(6); // 2-byte header + 4-byte mask
  header[0] = 0x81;               // FIN + text opcode
  header[1] = 0x80 | payload.length; // MASK bit + payload length
  mask.copy(header, 2);
  return Buffer.concat([header, masked]);
}

// ─── wsSend ───────────────────────────────────────────────────────────────────

describe('wsSend', () => {
  test('short message (≤125 bytes) uses 2-byte header', () => {
    const socket = makeMockSocket();
    wsSend(socket, 'hello');
    const frame = socket._written();
    assert.equal(frame[0], 0x81);  // FIN + text opcode
    assert.equal(frame[1], 5);     // payload length = 5
    assert.equal(decodeTextFrame(frame), 'hello');
  });

  test('medium message (126–65535 bytes) uses 4-byte header with UInt16BE length', () => {
    const socket = makeMockSocket();
    const text = 'x'.repeat(200);
    wsSend(socket, text);
    const frame = socket._written();
    assert.equal(frame[0], 0x81);
    assert.equal(frame[1], 126);
    assert.equal(frame.readUInt16BE(2), 200);
    assert.equal(decodeTextFrame(frame), text);
  });

  test('large message (>65535 bytes) uses 10-byte header with BigUInt64BE length', () => {
    const socket = makeMockSocket();
    const text = 'y'.repeat(70000);
    wsSend(socket, text);
    const frame = socket._written();
    assert.equal(frame[0], 0x81);
    assert.equal(frame[1], 127);
    assert.equal(Number(frame.readBigUInt64BE(2)), 70000);
    assert.equal(decodeTextFrame(frame), text);
  });

  test('round-trip: encoded payload decodes back to original string', () => {
    const socket = makeMockSocket();
    const original = JSON.stringify({ type: 'snapshot', data: { tick: 99, agents: {} } });
    wsSend(socket, original);
    assert.equal(decodeTextFrame(socket._written()), original);
  });

  test('exactly 125-byte payload uses 2-byte header', () => {
    const socket = makeMockSocket();
    const text = 'a'.repeat(125);
    wsSend(socket, text);
    const frame = socket._written();
    assert.equal(frame[1], 125); // not 126, because 125 fits in the 7-bit field
  });

  test('exactly 126-byte payload uses 4-byte header', () => {
    const socket = makeMockSocket();
    const text = 'a'.repeat(126);
    wsSend(socket, text);
    const frame = socket._written();
    assert.equal(frame[1], 126);
    assert.equal(frame.readUInt16BE(2), 126);
  });
});

// ─── wsParse ──────────────────────────────────────────────────────────────────

describe('wsParse', () => {
  test('ignores buffer shorter than 2 bytes without throwing', () => {
    const socket = makeMockSocket();
    assert.doesNotThrow(() => wsParse(socket, Buffer.from([0x81])));
    assert.doesNotThrow(() => wsParse(socket, Buffer.alloc(0)));
  });

  test('close frame (opcode 0x8) destroys socket', () => {
    const socket = makeMockSocket();
    const closeFrame = Buffer.from([0x88, 0x00]); // FIN + close, zero-length payload
    wsParse(socket, closeFrame);
    assert.equal(socket.destroyed, true);
  });

  test('unmasked ping (opcode 0x9) replies with pong (opcode 0x8a) mirroring payload', () => {
    const socket = makeMockSocket();
    const pingPayload = Buffer.from('ping');
    const pingFrame = Buffer.concat([
      Buffer.from([0x89, pingPayload.length]), // FIN + ping, length
      pingPayload,
    ]);
    wsParse(socket, pingFrame);
    const pong = socket._written();
    assert.ok(pong.length > 0, 'should have written a pong');
    assert.equal(pong[0], 0x8a, 'first byte should be pong opcode');
    assert.equal(pong.slice(2).toString(), 'ping', 'pong payload should mirror ping');
  });

  test('masked ping replies with unmasked pong with correctly unmasked payload', () => {
    const socket = makeMockSocket();
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const mask = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    const maskedPayload = Buffer.from(payload);
    for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i % 4];

    const frame = Buffer.concat([
      Buffer.from([0x89, 0x80 | payload.length]), // FIN + ping + MASK bit
      mask,
      maskedPayload,
    ]);
    wsParse(socket, frame);
    const pong = socket._written();
    assert.equal(pong[0], 0x8a);
    assert.deepEqual(pong.slice(2), payload, 'pong payload should be unmasked original');
  });

  test('masked text frame with get_snapshot triggers a snapshot response', () => {
    const socket = makeMockSocket();
    const frame = buildMaskedTextFrame(JSON.stringify({ type: 'get_snapshot' }));
    wsParse(socket, frame);
    const written = socket._written();
    assert.ok(written.length > 0, 'should have written a snapshot response');
    const decoded = decodeTextFrame(written);
    const msg = JSON.parse(decoded);
    assert.equal(msg.type, 'snapshot');
    assert.ok('data' in msg, 'response should contain data field');
  });

  test('masked text frame with unknown type does not throw and writes nothing', () => {
    const socket = makeMockSocket();
    const frame = buildMaskedTextFrame(JSON.stringify({ type: 'unknown_cmd' }));
    assert.doesNotThrow(() => wsParse(socket, frame));
    assert.equal(socket._written().length, 0);
  });

  test('malformed JSON text frame is silently ignored', () => {
    const socket = makeMockSocket();
    // build a masked frame with invalid JSON
    const badText = '{ not valid json :::';
    const frame = buildMaskedTextFrame(badText);
    assert.doesNotThrow(() => wsParse(socket, frame));
  });
});

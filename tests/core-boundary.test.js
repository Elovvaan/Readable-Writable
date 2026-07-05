'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/core');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');

const TARGETS = [
  'safeNumber',
  'hasLatLng',
  'latLngToGrid',
  'getGlobeUnitVectorFromLatLng',
  'normalizeEntityGridPosition',
  'uid',
];

describe('core module boundary readiness', () => {
  test('src/core exports every helper targeted by the server rewire', () => {
    for (const name of TARGETS) {
      assert.equal(typeof core[name], 'function', name + ' must be exported from src/core');
    }
  });

  test('server.js is either ready for the codemod or already rewired', () => {
    const source = fs.readFileSync(SERVER_PATH, 'utf8');
    const declarations = TARGETS.filter(name => source.includes('function ' + name + '('));
    const aliases = TARGETS.filter(name => source.includes('const ' + name + ' = core.' + name + ';'));
    const hasCoreImport = source.includes("require('./src/core')") || source.includes('require("./src/core")');

    const readyForCodemod = declarations.length === TARGETS.length && aliases.length === 0;
    const alreadyRewired = hasCoreImport && declarations.length === 0 && aliases.length === TARGETS.length;

    assert.equal(readyForCodemod || alreadyRewired, true, JSON.stringify({ declarations, aliases, hasCoreImport }));
  });
});

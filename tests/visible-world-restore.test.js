'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'restore-visible-world.js');
const PACKAGE_PATH = path.join(ROOT, 'package.json');

describe('visible world restore startup patch', () => {
  test('restore script exists and targets the renderer constants', () => {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(source, /const USE_CESIUM = true;/);
    assert.match(source, /const USE_CESIUM = false;/);
    assert.match(source, /const LEGACY_CANVAS_RENDERER = false;/);
    assert.match(source, /const LEGACY_CANVAS_RENDERER = true;/);
    assert.match(source, /RW_VISIBLE_WORLD_RESTORE_APPLIED/);
  });

  test('npm start applies restore before launching server', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
    assert.equal(pkg.scripts.start, 'node scripts/restore-visible-world.js && node server.js');
  });
});

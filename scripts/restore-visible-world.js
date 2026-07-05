'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const marker = '// RW_VISIBLE_WORLD_RESTORE_APPLIED';

function replaceOnce(source, from, to, label) {
  if (source.includes(to)) return source;
  const occurrences = source.split(from).length - 1;
  if (occurrences === 0) throw new Error('Missing expected server.js fragment: ' + label);
  if (occurrences > 1) throw new Error('Multiple matches for server.js fragment: ' + label);
  return source.replace(from, to);
}

function main() {
  let source = fs.readFileSync(serverPath, 'utf8');

  if (source.includes(marker)) {
    console.log('Visible world patch marker found; verifying patch state.');
  }

  source = replaceOnce(
    source,
    'const USE_CESIUM = true;',
    'const USE_CESIUM = BOOTSTRAP.useCesium === true; ' + marker,
    'frontend USE_CESIUM constant'
  );

  source = replaceOnce(
    source,
    'const LEGACY_CANVAS_RENDERER = false;',
    'const LEGACY_CANVAS_RENDERER = !USE_CESIUM;',
    'frontend LEGACY_CANVAS_RENDERER constant'
  );

  source = replaceOnce(
    source,
    'const RW_USE_CESIUM = true;',
    "const RW_USE_CESIUM = process.env.RW_USE_CESIUM === 'true';",
    'server RW_USE_CESIUM constant'
  );

  fs.writeFileSync(serverPath, source);
  console.log('Visible world patch applied: canvas renderer restored and Cesium disabled by default.');
}

main();

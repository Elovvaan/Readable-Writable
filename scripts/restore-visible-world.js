'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const marker = '// RW_VISIBLE_WORLD_RESTORE_APPLIED';

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) {
    if (source.includes(to)) return source;
    throw new Error('Missing expected server.js fragment: ' + label);
  }
  return source.replace(from, to);
}

function main() {
  let source = fs.readFileSync(serverPath, 'utf8');

  if (source.includes(marker)) {
    console.log('Visible world patch already applied.');
    return;
  }

  source = replaceOnce(
    source,
    'const USE_CESIUM = true;',
    'const USE_CESIUM = false; ' + marker,
    'frontend USE_CESIUM constant'
  );

  source = replaceOnce(
    source,
    'const LEGACY_CANVAS_RENDERER = false;',
    'const LEGACY_CANVAS_RENDERER = true;',
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

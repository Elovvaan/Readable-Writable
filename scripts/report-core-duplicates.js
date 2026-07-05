'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const corePath = path.join(root, 'src', 'core');

const serverSource = fs.readFileSync(serverPath, 'utf8');
const core = require(corePath);

const TARGETS = [
  'safeNumber',
  'hasLatLng',
  'latLngToGrid',
  'getGlobeUnitVectorFromLatLng',
  'normalizeEntityGridPosition',
  'uid',
];

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function findFunctionDeclaration(source, name) {
  const needle = 'function ' + name + '(';
  const start = source.indexOf(needle);
  if (start === -1) return null;

  const bodyStart = source.indexOf('{', start);
  if (bodyStart === -1) return null;

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      return {
        name,
        start,
        end: i + 1,
        startLine: lineNumberAt(source, start),
        endLine: lineNumberAt(source, i + 1),
        source: source.slice(start, i + 1),
      };
    }
  }
  return null;
}

function main() {
  const report = [];
  for (const name of TARGETS) {
    const localFn = findFunctionDeclaration(serverSource, name);
    report.push({
      name,
      exportedFromCore: typeof core[name] === 'function',
      foundInServer: !!localFn,
      startLine: localFn ? localFn.startLine : null,
      endLine: localFn ? localFn.endLine : null,
      replacement: localFn ? 'const ' + name + ' = core.' + name + ';' : null,
    });
  }

  const missingCore = report.filter(row => !row.exportedFromCore).map(row => row.name);
  const missingServer = report.filter(row => !row.foundInServer).map(row => row.name);

  console.log(JSON.stringify({
    serverPath: path.relative(root, serverPath),
    corePath: path.relative(root, corePath),
    targets: report,
    readyForImportRewire: missingCore.length === 0 && missingServer.length === 0,
    missingCore,
    missingServer,
  }, null, 2));

  if (missingCore.length || missingServer.length) {
    process.exitCode = 1;
  }
}

main();

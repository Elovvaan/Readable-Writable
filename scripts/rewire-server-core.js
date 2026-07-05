'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const corePath = path.join(root, 'src', 'core');

const TARGETS = [
  'safeNumber',
  'hasLatLng',
  'latLngToGrid',
  'getGlobeUnitVectorFromLatLng',
  'normalizeEntityGridPosition',
  'uid',
];

const IMPORT_BLOCK = "const core = require('./src/core');\n";
const CORE_ALIAS_BLOCK = TARGETS.map(name => 'const ' + name + ' = core.' + name + ';').join('\n') + '\n';

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
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }

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

function insertCoreImport(source) {
  if (source.includes(IMPORT_BLOCK.trim())) return source;
  const anchor = "const path = require('path');\n";
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error('Unable to find require anchor for core import.');
  return source.slice(0, idx + anchor.length) + IMPORT_BLOCK + source.slice(idx + anchor.length);
}

function replaceServerHelpersWithCoreAliases(source) {
  const found = [];
  for (const name of TARGETS) {
    const match = findFunctionDeclaration(source, name);
    if (match) {
      found.push(match);
      continue;
    }

    // Allow re-running after helpers have already been rewired.
    const aliasNeedle = 'const ' + name + ' = core.' + name + ';';
    if (!source.includes(aliasNeedle)) {
      throw new Error('Missing server helper declaration or core alias: ' + name);
    }
  }

  found.sort((a, b) => b.start - a.start);
  let next = source;
  for (const match of found) {
    next = next.slice(0, match.start) + next.slice(match.end);
  }

  const insertionAnchor = '// ─── Config';
  const anchorIndex = next.indexOf(insertionAnchor);
  if (anchorIndex === -1) throw new Error('Unable to find config section anchor.');

  const missingAliasLines = TARGETS
    .filter(name => !next.includes('const ' + name + ' = core.' + name + ';'))
    .map(name => 'const ' + name + ' = core.' + name + ';');

  if (missingAliasLines.length) {
    next = next.slice(0, anchorIndex) + missingAliasLines.join('\n') + '\n' + next.slice(anchorIndex);
  }

  return { source: next, found };
}

function assertCoreExportsExist() {
  const core = require(corePath);
  const missing = TARGETS.filter(name => typeof core[name] !== 'function');
  if (missing.length) {
    throw new Error('Missing src/core exports: ' + missing.join(', '));
  }
}

function assertNoFunctionDeclarations(source) {
  const remaining = TARGETS.filter(name => source.includes('function ' + name + '('));
  if (remaining.length) {
    throw new Error('Core helper declarations still remain in server.js: ' + remaining.join(', '));
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  assertCoreExportsExist();

  const original = fs.readFileSync(serverPath, 'utf8');
  let next = insertCoreImport(original);
  const result = replaceServerHelpersWithCoreAliases(next);
  next = result.source;
  assertNoFunctionDeclarations(next);

  const changed = next !== original;
  const report = {
    checkOnly,
    changed,
    helpers: result.found.map(match => ({
      name: match.name,
      startLine: match.startLine,
      endLine: match.endLine,
    })),
  };

  console.log(JSON.stringify(report, null, 2));

  if (checkOnly) {
    process.exitCode = changed ? 1 : 0;
    return;
  }

  if (changed) {
    fs.writeFileSync(serverPath, next);
  }
}

main();

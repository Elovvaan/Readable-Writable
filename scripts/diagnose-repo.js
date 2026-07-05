'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const PACKAGE_PATH = path.join(ROOT, 'package.json');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function diagnoseServer() {
  const text = readText(SERVER_PATH);
  const lines = text ? text.split(/\r?\n/) : [];
  return {
    exists: Boolean(text),
    lines: lines.length,
    bytes: Buffer.byteLength(text || '', 'utf8'),
    functions: countMatches(text, /\bfunction\s+[A-Za-z0-9_$]+\s*\(/g),
    intervals: countMatches(text, /\bsetInterval\s*\(/g),
    timeouts: countMatches(text, /\bsetTimeout\s*\(/g),
    exports: countMatches(text, /module\.exports\s*=\s*{/g),
    inlineHtml: text.includes('const FRONTEND_HTML = `<!DOCTYPE html>'),
    cesiumReferences: countMatches(text, /\bCesium\b/g),
    websocketReferences: countMatches(text, /websocket|WebSocket|wsHandshake|wsUpgrade/g),
    routeChecks: countMatches(text, /req\.method|url ===|url\.startsWith/g),
  };
}

function diagnoseTests() {
  const testDir = path.join(ROOT, 'tests');
  const testFiles = listFiles(testDir).filter(file => file.endsWith('.js'));
  return testFiles.map(file => {
    const text = readText(file);
    return {
      file: relative(file),
      lines: text.split(/\r?\n/).length,
      importsServer: text.includes("require('../server')") || text.includes('require("../server")'),
      tests: countMatches(text, /\btest\s*\(/g),
      describes: countMatches(text, /\bdescribe\s*\(/g),
    };
  });
}

function diagnosePackage() {
  const pkgText = readText(PACKAGE_PATH);
  if (!pkgText) return { exists: false };
  try {
    const pkg = JSON.parse(pkgText);
    return {
      exists: true,
      name: pkg.name,
      scripts: pkg.scripts || {},
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
    };
  } catch (err) {
    return { exists: true, parseError: err.message };
  }
}

function main() {
  const packageInfo = diagnosePackage();
  const server = diagnoseServer();
  const tests = diagnoseTests();
  const importsServer = tests.filter(t => t.importsServer).map(t => t.file);

  const report = {
    generatedAt: new Date().toISOString(),
    package: packageInfo,
    server,
    tests: {
      files: tests.length,
      totalTests: tests.reduce((sum, t) => sum + t.tests, 0),
      importingServer: importsServer,
    },
    recommendedNextSlice: [
      'Keep server.js as compatibility shell.',
      'Extract pure utility functions first because they have the least runtime coupling.',
      'Add module-level tests before moving stateful provider loops.',
      'Move frontend HTML/CSS/JS last because it is the highest-risk surface.',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
}

main();

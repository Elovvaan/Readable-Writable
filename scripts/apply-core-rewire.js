'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args) {
  console.log('\n$ ' + [command].concat(args).join(' '));
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ROOT,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run(NPM, ['run', 'report:core-duplicates']);
run(NPM, ['run', 'rewire:server-core']);
run(NPM, ['test']);

console.log('\nCore rewire completed and tests passed.');

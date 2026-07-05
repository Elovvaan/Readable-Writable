'use strict';

const { spawnSync } = require('child_process');

function run(command, args) {
  console.log('\n$ ' + [command].concat(args).join(' '));
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run('npm', ['run', 'report:core-duplicates']);
run('npm', ['run', 'rewire:server-core']);
run('npm', ['test']);

console.log('\nCore rewire completed and tests passed.');

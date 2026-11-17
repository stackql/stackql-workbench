// Runs the webview tests.
//
// On Windows, Vitest loads its own modules twice when the working directory
// is spelled with a lower-case drive letter, which an editor's terminal can
// do. Every suite then fails before running a single test with "Cannot read
// properties of undefined (reading 'config')". This launcher starts Vitest
// from the same directory spelled with an upper-case drive letter.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

let cwd = process.cwd();
if (process.platform === 'win32' && /^[a-z]:/.test(cwd)) {
  cwd = cwd.charAt(0).toUpperCase() + cwd.slice(1);
}

const require = createRequire(path.join(cwd, 'package.json'));
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const result = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
  cwd,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}
`);
  process.exit(1);
}
process.exit(result.status ?? 1);

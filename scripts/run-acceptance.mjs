#!/usr/bin/env node

/**
 * Release-scope acceptance runner.
 * No external Provider calls are made; real traffic is a separate approval gate.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedTests = Number(process.env.SMART_ROUTER_EXPECTED_TESTS || 628);
const checks = [];

function run(name, command, args) {
  try {
    const output = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pass = true;
    let detail = output.trim().slice(-500);
    if (name === 'full test suite') {
      const tests = Number(output.match(/ℹ tests (\d+)/)?.[1] || 0);
      const failures = Number(output.match(/ℹ fail (\d+)/)?.[1] || 0);
      pass = tests === expectedTests && failures === 0;
      detail = `tests=${tests}; failures=${failures}`;
    }
    checks.push({ name, pass, output: detail });
  } catch (error) {
    checks.push({
      name,
      pass: false,
      code: error.status ?? 1,
      output: `${error.stdout || ''}${error.stderr || ''}`.trim().slice(-1000),
    });
  }
}

run('full test suite', 'npm', ['test']);
run('syntax', process.execPath, [
  '--check', 'src/server.js',
]);
run('frontend syntax', process.execPath, ['--check', 'web/app.js']);
run('diff whitespace', 'git', ['diff', 'HEAD', '--check']);
run('release evidence', process.execPath, ['scripts/release-evidence-check.mjs', `--tests=${expectedTests}`]);

const failed = checks.filter((check) => !check.pass);
const result = {
  status: failed.length === 0 ? 'PASS' : 'FAIL',
  expectedTests,
  checks: checks.map(({ name, pass }) => ({ name, pass })),
  failed: failed.map(({ name, code, output }) => ({ name, code, output })),
  external_provider_traffic: 'NOT_RUN',
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;

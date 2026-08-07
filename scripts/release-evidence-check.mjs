#!/usr/bin/env node

/**
 * Verify that RELEASE_MANIFEST.json describes the exact checked-out source.
 * This is intentionally a fail-closed check: a dirty worktree or stale hash
 * is a release blocker, not something to paper over in the evidence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'RELEASE_MANIFEST.json');
const packagePath = resolve(root, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const checks = [];
function check(name, pass, expected, actual) {
  checks.push({ name, pass: Boolean(pass), expected, actual });
}

const branch = git(['branch', '--show-current']);
const commit = git(['rev-parse', 'HEAD']);
const parentCommit = git(['rev-parse', 'HEAD^']);
const dirty = git(['status', '--porcelain', '--untracked-files=all']);

function statusPath(line) {
  return line.slice(3).trim().replace(/^"|"$/g, '');
}

function isLocalExcluded(path) {
  return path.startsWith('deliver/') ||
    path === 'evidence/real-claude-pilot-evidence.json' ||
    path === 'evidence/real-provider-pilot-evidence.json' ||
    path === 'evidence/real-provider-postfix-evidence.json' ||
    path.includes('.bak-');
}

const dirtyEntries = dirty ? dirty.split('\n').filter(Boolean) : [];
const blockingDirtyEntries = dirtyEntries.filter((line) => !isLocalExcluded(statusPath(line)));
const excludedDirtyEntries = dirtyEntries.filter((line) => isLocalExcluded(statusPath(line)));

check('package name', manifest.package === pkg.name, pkg.name, manifest.package);
check('package version', manifest.version === pkg.version, pkg.version, manifest.version);
check('branch', manifest.branch === branch, branch, manifest.branch);
const commitMatchesSource = manifest.commit === commit || manifest.commit === parentCommit;
check('commit', commitMatchesSource, `${commit} or ${parentCommit}`, manifest.commit);
check(
  'release scope clean',
  blockingDirtyEntries.length === 0,
  'no changes outside release scope',
  blockingDirtyEntries.length === 0 ? '' : blockingDirtyEntries.join('\n'),
);

for (const [relativePath, expectedHash] of Object.entries(manifest.source_files || {})) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    check(`source exists: ${relativePath}`, false, 'present', 'missing');
    continue;
  }
  const actualHash = sha256(path);
  check(`source hash: ${relativePath}`, actualHash === expectedHash, expectedHash, actualHash);
}

const requestedTests = process.argv.find((arg) => arg.startsWith('--tests='));
if (requestedTests) {
  const expectedTests = Number(requestedTests.slice('--tests='.length));
  const actualTests = manifest.test_summary?.total?.tests;
  check('test count', actualTests === expectedTests, expectedTests, actualTests);
}

const failed = checks.filter((item) => !item.pass);
const result = {
  status: failed.length === 0 ? 'pass' : 'blocked',
  root,
  branch,
  commit,
  excluded_local_entries: excludedDirtyEntries.map(statusPath),
  checks,
  blockers: failed.map((item) => item.name),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const passed = checks.length - failed.length;
  console.log(`release evidence: ${result.status}; checks=${checks.length}; passed=${passed}; blockers=${failed.length}; excluded_local=${excludedDirtyEntries.length}`);
  if (failed.length > 0) console.log(failed.map((item) => `- ${item.name}`).join('\n'));
}
process.exitCode = failed.length === 0 ? 0 : 1;

// test/audit/release-gate.test.js
// Smart Router Mainline - Phase 1
// Release Gate Audit Tests
//
// These tests verify release-readiness by performing static analysis on the
// source tree. They check for secrets, prompt injection, user prompt rewriting,
// file hygiene, module completeness, and critical safety mechanisms.
//
// Uses only Node.js built-in modules (node:test, node:assert, node:fs, node:path).
// No third-party dependencies.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const TEST_DIR = join(ROOT, 'test');

// The 24 core modules across 8 layers
const CORE_MODULES = [
  // Layer 1: entry
  'src/server.js',
  'src/index.js',
  // Layer 2: config
  'src/config/loader.js',
  'src/config/validator.js',
  // Layer 3: protocols
  'src/protocols/chat.js',
  'src/protocols/chat-stream.js',
  'src/protocols/responses.js',
  'src/protocols/responses-stream.js',
  'src/protocols/anthropic.js',
  'src/protocols/anthropic-stream.js',
  // Layer 4: provider
  'src/provider/client.js',
  'src/provider/key-pool.js',
  'src/provider/health.js',
  'src/provider/errors.js',
  // Layer 5: router
  'src/router/candidates.js',
  'src/router/fallback.js',
  'src/router/execution.js',
  // Layer 6: agent
  'src/agent/identity.js',
  'src/agent/compatibility.js',
  // Layer 7: runtime
  'src/runtime/cancellation.js',
  'src/runtime/finalization.js',
  'src/runtime/attempts.js',
  'src/runtime/outcomes.js',
  // Layer 8: cost
  'src/cost/tracker.js',
];

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * Recursively walk a directory and return all files matching the given extension.
 * @param {string} dir - Directory to walk
 * @param {string} ext - File extension to match (e.g. '.js')
 * @returns {string[]} Array of absolute file paths
 */
function walkDir(dir, ext = '.js') {
  if (!existsSync(dir)) return [];
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath, ext));
    } else if (entry.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Read all .js source files under src/ and return { path, content } pairs.
 * @returns {{ path: string, content: string }[]}
 */
function readSrcFiles() {
  return walkDir(SRC_DIR, '.js').map((p) => ({
    path: p,
    content: readFileSync(p, 'utf-8'),
  }));
}

/**
 * Check if a line is a comment line (// or * or /*).
 * @param {string} line
 * @returns {boolean}
 */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/**
 * Get the relative path from the project root for readable error messages.
 * @param {string} absPath
 * @returns {string}
 */
function relPath(absPath) {
  return absPath.replace(ROOT, '');
}

// ============================================================================
// Release Gate Tests
// ============================================================================

describe('Release Gate Audit', () => {

  // --------------------------------------------------------------------------
  // 1. No API keys in source
  // --------------------------------------------------------------------------

  describe('1. No API keys in source', () => {
    test('src/ .js files do not contain hardcoded API key patterns', () => {
      const files = readSrcFiles();
      const violations = [];

      // OpenAI-style keys: sk- followed by 20+ alphanumeric chars
      const skPattern = /sk-[a-zA-Z0-9_-]{20,}/;

      // Bearer token with actual key value: "Bearer " followed by 20+ chars
      // This will NOT match 'Bearer ' (just the prefix) or 'Bearer ${...}' or 'Bearer <key>'
      // because $ { < > are not in [a-zA-Z0-9_-]
      const bearerPattern = /Bearer\s+[a-zA-Z0-9_-]{20,}/;

      // api_key / apiKey / api_keys assigned to a hardcoded string literal (20+ chars)
      // Excludes placeholders like REPLACE_WITH_*, YOUR_*, changeme, test-key, <...>
      const apiKeyAssignPattern = /api[_-]?key[s]?\s*[:=]\s*['"]([^'"]{20,})['"]/i;

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (skPattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: contains sk- key pattern`);
          }

          if (bearerPattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: contains Bearer token with key value`);
          }

          const apiKeyMatch = line.match(apiKeyAssignPattern);
          if (apiKeyMatch) {
            const keyVal = apiKeyMatch[1];
            // Exclude known placeholder patterns
            const isPlaceholder =
              /REPLACE_WITH/i.test(keyVal) ||
              /YOUR.*KEY/i.test(keyVal) ||
              /^changeme$/i.test(keyVal) ||
              /^<.*>$/i.test(keyVal) ||
              /test|placeholder|example|dummy/i.test(keyVal);
            if (!isPlaceholder) {
              violations.push(`${relPath(path)}:${i + 1}: hardcoded api_key value`);
            }
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `API key patterns found in source:\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. No database files in source
  // --------------------------------------------------------------------------

  describe('2. No database files in source', () => {
    test('no .db, .sqlite, .sqlite3 files exist in src/ or test/', () => {
      const dbExts = ['.db', '.sqlite', '.sqlite3'];
      const violations = [];

      for (const dir of [SRC_DIR, TEST_DIR]) {
        for (const ext of dbExts) {
          const files = walkDir(dir, ext);
          for (const f of files) {
            violations.push(relPath(f));
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Database files found in src/ or test/:\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. No log files in source
  // --------------------------------------------------------------------------

  describe('3. No log files in source', () => {
    test('no .log files exist in src/ or test/', () => {
      const violations = [
        ...walkDir(SRC_DIR, '.log'),
        ...walkDir(TEST_DIR, '.log'),
      ].map(relPath);

      assert.deepEqual(
        violations,
        [],
        `Log files found in src/ or test/:\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 4. No .git references in source
  // --------------------------------------------------------------------------

  describe('4. No .git references in source', () => {
    test('src/ files do not contain .git references (except .gitignore)', () => {
      const files = readSrcFiles();
      const violations = [];

      // Match .git but NOT .gitignore (negative lookahead)
      const gitPattern = /\.git(?!ignore)/;

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (gitPattern.test(lines[i])) {
            violations.push(`${relPath(path)}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `.git references found in source (excluding .gitignore):\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 5. package.json and package-lock.json consistency
  // --------------------------------------------------------------------------

  describe('5. package.json and package-lock.json consistency', () => {
    test('package name and version match between package.json and package-lock.json', () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
      const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf-8'));

      // Top-level name and version
      assert.equal(
        lock.name,
        pkg.name,
        `package name mismatch: package.json="${pkg.name}" vs package-lock.json="${lock.name}"`
      );
      assert.equal(
        lock.version,
        pkg.version,
        `package version mismatch: package.json="${pkg.version}" vs package-lock.json="${lock.version}"`
      );

      // Root entry in lockfile packages
      const rootPkg = lock.packages && lock.packages[''];
      assert.ok(rootPkg, 'package-lock.json must have a root packages[""] entry');
      assert.equal(
        rootPkg.name,
        pkg.name,
        `root package name mismatch: package.json="${pkg.name}" vs lockfile="${rootPkg.name}"`
      );
      assert.equal(
        rootPkg.version,
        pkg.version,
        `root package version mismatch: package.json="${pkg.version}" vs lockfile="${rootPkg.version}"`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 6. All 24 core modules exist
  // --------------------------------------------------------------------------

  describe('6. All 24 core modules exist', () => {
    test('exactly 24 modules are defined', () => {
      assert.equal(
        CORE_MODULES.length,
        24,
        `Expected 24 core modules, got ${CORE_MODULES.length}`
      );
    });

    test('all 24 required module files exist on disk', () => {
      const missing = CORE_MODULES.filter((m) => !existsSync(join(ROOT, m)));
      assert.deepEqual(
        missing,
        [],
        `Missing core modules:\n${missing.join('\n')}`
      );
    });

    test('all core modules are non-empty .js files', () => {
      const empty = [];
      for (const mod of CORE_MODULES) {
        const fullPath = join(ROOT, mod);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf-8');
          if (content.trim().length === 0) {
            empty.push(mod);
          }
        }
      }
      assert.deepEqual(
        empty,
        [],
        `Empty core modules:\n${empty.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 7. No prompt injection
  // --------------------------------------------------------------------------

  describe('7. No prompt injection in source', () => {
    test('no "You are" role-injection strings in source code', () => {
      const files = readSrcFiles();
      const violations = [];

      // Match "You are" or "you are" followed by a role description in string literals
      const youArePattern = /['"`]\s*(?:You are|you are)\s+(?:a |an |the |going|now|not)/i;

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (youArePattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `"You are" role-injection patterns found:\n${violations.join('\n')}`
      );
    });

    test('no "你是" role-injection strings in source code', () => {
      const files = readSrcFiles();
      const violations = [];

      // Match "你是" in string literals (not comments)
      const niShiPattern = /['"`]\s*你是/;

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (niShiPattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `"你是" role-injection patterns found:\n${violations.join('\n')}`
      );
    });

    test('no "think step by step" or "请逐步思考" injection', () => {
      const files = readSrcFiles();
      const violations = [];

      const patterns = [
        /think\s+step\s+by\s+step/i,
        /请逐步思考/,
      ];

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          for (const pattern of patterns) {
            if (pattern.test(line)) {
              violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
            }
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Step-by-step injection patterns found:\n${violations.join('\n')}`
      );
    });

    test('no code that adds system messages with hardcoded content to user requests', () => {
      const files = readSrcFiles();
      const violations = [];

      // Check for system messages created with hardcoded string content
      // This matches: role: 'system', content: '...' (string literal, not variable)
      // Protocol conversion like { role: 'system', content: body.instructions } is OK
      // because body.instructions is a variable, not a string literal
      const hardcodedSystemPattern = /role\s*:\s*['"]system['"]\s*,\s*content\s*:\s*['"`]/;

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;
          if (hardcodedSystemPattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Hardcoded system message content found:\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 8. No user prompt rewriting
  // --------------------------------------------------------------------------

  describe('8. No user prompt rewriting', () => {
    test('no src/ file modifies user message content with string manipulation', () => {
      const files = readSrcFiles();
      const violations = [];

      // Patterns that indicate direct content modification (not transfer or function call)
      // - .content = something.replace(...)
      // - .content += ...
      // - .content = 'prefix' + ...
      // - .content = ... + 'suffix'
      const contentModPatterns = [
        /\.content\s*=\s*[^;\n]*\.replace\(/,
        /\.content\s*\+=/,
        /\.content\s*=\s*['"`]\s*\+/,
        /\.content\s*=\s*[^;\n]*\+\s*['"`]/,
      ];

      // Known safe patterns (response-side cleaning, protocol conversion)
      // These are legitimate operations that modify content on the response side
      const safePatterns = [
        /cleanThinkingProcessLeak/,
        /cleanThinkingFromContent/,
        /cleanThinkingBlocks/,
        /cleanReasoningContent/,
        /convertContentPartsToChat/,
      ];

      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          for (const pattern of contentModPatterns) {
            if (pattern.test(line)) {
              // Check if this is a known safe pattern
              const isSafe = safePatterns.some((sp) => sp.test(line));
              if (!isSafe) {
                violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
              }
            }
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `User message content modification found:\n${violations.join('\n')}`
      );
    });

    test('no code explicitly targets user role messages for content modification', () => {
      const files = readSrcFiles();
      const violations = [];

      // Look for patterns where role === 'user' is checked and content is modified
      // This would indicate explicit user prompt rewriting
      for (const { path, content } of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;

          // Check for patterns like: if (msg.role === 'user') { msg.content = ... }
          // or: role === 'user' ... content =
          const userContentModPattern =
            /role\s*(?:===|==)\s*['"]user['"]\s*.*\.content\s*=/;
          if (userContentModPattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
          }

          // Also check the reverse: content = ... role === 'user'
          const reversePattern = /\.content\s*=.*role\s*(?:===|==)\s*['"]user['"]/;
          if (reversePattern.test(line)) {
            violations.push(`${relPath(path)}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Explicit user message content modification found:\n${violations.join('\n')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 9. No model switching after first byte
  // --------------------------------------------------------------------------

  describe('9. No model switching after first byte', () => {
    test('execution.js contains firstByteReceived / firstByteSentToClient logic', () => {
      const execPath = join(SRC_DIR, 'router', 'execution.js');
      assert.ok(existsSync(execPath), 'src/router/execution.js must exist');
      const content = readFileSync(execPath, 'utf-8');

      // Must reference firstByteReceived or firstByteSentToClient
      assert.ok(
        /firstByteReceived|firstByteSentToClient/.test(content),
        'execution.js must reference firstByteReceived or firstByteSentToClient'
      );
    });

    test('execution.js prevents fallback after first byte is received', () => {
      const execPath = join(SRC_DIR, 'router', 'execution.js');
      const content = readFileSync(execPath, 'utf-8');

      // Must contain a check that prevents fallback when firstByteReceived is true
      // Look for patterns like: if (chain.firstByteReceived) { return ... }
      // or: if (firstByteReceived) { ... no fallback ... }
      const hasFirstByteCheck = /firstByteReceived/.test(content);
      assert.ok(hasFirstByteCheck, 'execution.js must check firstByteReceived');

      // Must contain logic that returns or breaks when firstByteReceived is true
      // (preventing further fallback / model switching)
      // Use [\s\S] to match across newlines, since the if-check and return
      // span multiple lines in the source.
      const hasPreventionLogic =
        /firstByteReceived[\s\S]{0,500}(?:return|incomplete|no.?fallback)/i.test(content);
      assert.ok(
        hasPreventionLogic,
        'execution.js must contain logic to prevent model switching after first byte'
      );
    });

    test('fallback.js respects firstByteReceived to prevent candidate advancement', () => {
      const fallbackPath = join(SRC_DIR, 'router', 'fallback.js');
      assert.ok(existsSync(fallbackPath), 'src/router/fallback.js must exist');
      const content = readFileSync(fallbackPath, 'utf-8');

      assert.ok(
        /firstByteReceived/.test(content),
        'fallback.js must reference firstByteReceived'
      );

      // Must return a "no fallback" decision when firstByteReceived is true
      assert.ok(
        /first_byte_received/.test(content) ||
          /firstByteReceived.*(?:shouldFallback|false)/.test(content),
        'fallback.js must return a no-fallback decision when firstByteReceived is true'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 10. No budget violations
  // --------------------------------------------------------------------------

  describe('10. No budget violations', () => {
    test('cost/tracker.js contains checkBudget method', () => {
      const trackerPath = join(SRC_DIR, 'cost', 'tracker.js');
      assert.ok(existsSync(trackerPath), 'src/cost/tracker.js must exist');
      const content = readFileSync(trackerPath, 'utf-8');

      // Must define a checkBudget method
      assert.ok(
        /checkBudget\s*\(/.test(content),
        'cost/tracker.js must contain a checkBudget method'
      );
    });

    test('checkBudget returns an allowed/blocked decision', () => {
      const trackerPath = join(SRC_DIR, 'cost', 'tracker.js');
      const content = readFileSync(trackerPath, 'utf-8');

      // Must return an object with an "allowed" boolean field
      assert.ok(
        /allowed/.test(content),
        'checkBudget must return a result with an "allowed" field'
      );

      // Must have budget reason enumeration
      assert.ok(
        /BudgetReason|paid_blocked|model_not_allowed|strict_model_mismatch/i.test(content),
        'checkBudget must define budget rejection reasons'
      );
    });

    test('execution.js calls checkBudget before each attempt', () => {
      const execPath = join(SRC_DIR, 'router', 'execution.js');
      const content = readFileSync(execPath, 'utf-8');

      assert.ok(
        /checkBudget/.test(content),
        'execution.js must call checkBudget before each upstream attempt'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 11. No duplicate finalize
  // --------------------------------------------------------------------------

  describe('11. No duplicate finalize', () => {
    test('finalization.js contains idempotency protection', () => {
      const finPath = join(SRC_DIR, 'runtime', 'finalization.js');
      assert.ok(existsSync(finPath), 'src/runtime/finalization.js must exist');
      const content = readFileSync(finPath, 'utf-8');

      // Must track finalized request IDs (idempotency Set/Map)
      assert.ok(
        /_finalizedIds|finalizedIds|_finalized/.test(content),
        'finalization.js must track finalized request IDs for idempotency'
      );
    });

    test('finalize returns early if requestId was already finalized', () => {
      const finPath = join(SRC_DIR, 'runtime', 'finalization.js');
      const content = readFileSync(finPath, 'utf-8');

      // Must check if requestId is already in the finalized set and return early
      assert.ok(
        /already_finalized/.test(content),
        'finalization.js must return "already_finalized" for duplicate finalize calls'
      );

      // Must have a has() check followed by early return
      assert.ok(
        /\.has\(requestId\)/.test(content),
        'finalization.js must check requestId membership before finalizing'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 12. No duplicate cost
  // --------------------------------------------------------------------------

  describe('12. No duplicate cost', () => {
    test('cost/tracker.js contains cost deduplication by requestId', () => {
      const trackerPath = join(SRC_DIR, 'cost', 'tracker.js');
      const content = readFileSync(trackerPath, 'utf-8');

      // Must have a records Map keyed by requestId
      assert.ok(
        /records\s*(?:=|:)\s*new\s+Map/.test(content) ||
          /records\s*(?:=|:)\s*new\s+Map/.test(content),
        'cost/tracker.js must maintain a records Map for deduplication'
      );
    });

    test('recordCost skips duplicate requestId', () => {
      const trackerPath = join(SRC_DIR, 'cost', 'tracker.js');
      const content = readFileSync(trackerPath, 'utf-8');

      // Must check if requestId already exists before recording
      assert.ok(
        /records\.has\(requestId\)/.test(content),
        'recordCost must check records.has(requestId) for deduplication'
      );

      // Must return recorded=false for duplicates
      assert.ok(
        /recorded\s*:\s*false/.test(content),
        'recordCost must return recorded=false for duplicate requestId'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 13. Test directories are not empty
  // --------------------------------------------------------------------------

  describe('13. Test directories are not empty', () => {
    test('test/unit/ contains at least one .test.js file', () => {
      const unitTests = walkDir(join(TEST_DIR, 'unit'), '.test.js');
      assert.ok(
        unitTests.length > 0,
        'test/unit/ must contain at least one .test.js file'
      );
    });

    test('test/integration/ contains at least one .test.js file', () => {
      const integrationTests = walkDir(join(TEST_DIR, 'integration'), '.test.js');
      assert.ok(
        integrationTests.length > 0,
        'test/integration/ must contain at least one .test.js file'
      );
    });

    test('test/audit/ contains at least one .test.js file', () => {
      const auditTests = walkDir(join(TEST_DIR, 'audit'), '.test.js');
      assert.ok(
        auditTests.length > 0,
        'test/audit/ must contain at least one .test.js file'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 14. Payload Preservation
  // --------------------------------------------------------------------------

  describe('14. Payload Preservation (compatibility module)', () => {
    const compatPath = join(SRC_DIR, 'agent', 'compatibility.js');

    test('compatibility.js exists', () => {
      assert.ok(existsSync(compatPath), 'src/agent/compatibility.js must exist');
    });

    test('compatibility.js does NOT modify user message content', () => {
      const content = readFileSync(compatPath, 'utf-8');
      const lines = content.split('\n');
      const violations = [];

      // The compatibility module should NOT modify the content field of user messages.
      // It may clean response-side content (cleanThinkingBlocks, cleanThinkingProcessLeak,
      // cleanReasoningContent) but must not touch user message content.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;

        // Check for patterns that modify user message content
        const userContentModPattern =
          /role\s*(?:===|==)\s*['"]user['"]\s*.*\.content\s*=/;
        if (userContentModPattern.test(line)) {
          violations.push(`${i + 1}: ${line.trim()}`);
        }

        const reversePattern = /\.content\s*=.*role\s*(?:===|==)\s*['"]user['"]/;
        if (reversePattern.test(line)) {
          violations.push(`${i + 1}: ${line.trim()}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `compatibility.js must not modify user message content:\n${violations.join('\n')}`
      );
    });

    test('compatibility.js does NOT modify system prompt or developer messages', () => {
      const content = readFileSync(compatPath, 'utf-8');
      const lines = content.split('\n');
      const violations = [];

      // The compatibility module should NOT modify the "system" field or
      // "instructions" / "developer" fields. These are payload that must be preserved.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;

        // Check for assignments that modify system/instructions/developer fields
        // (excluding reads and comment references)
        const systemModPattern =
          /(?:body|outBody|cleanedBody|newBody)\s*\.\s*(?:system|instructions|developer)\s*=/;
        if (systemModPattern.test(line)) {
          violations.push(`${i + 1}: ${line.trim()}`);
        }

        // Check for delete operations on system/instructions/developer
        const systemDelPattern =
          /delete\s+(?:body|outBody|cleanedBody|newBody)\s*\.\s*(?:system|instructions|developer)\b/;
        if (systemDelPattern.test(line)) {
          violations.push(`${i + 1}: ${line.trim()}`);
        }
      }

      assert.deepEqual(
        violations,
        [],
        `compatibility.js must not modify system prompt or developer messages:\n${violations.join('\n')}`
      );
    });

    test('compatibility.js uses deepClone to avoid mutating input', () => {
      const content = readFileSync(compatPath, 'utf-8');

      // Must define and use a deep clone function
      assert.ok(
        /deepClone/.test(content),
        'compatibility.js must use deepClone to avoid mutating input parameters'
      );

      // applyClaudeCodePatches must deep-clone the body before modifying
      assert.ok(
        /deepClone\s*\(\s*body\s*\)/.test(content),
        'applyClaudeCodePatches must deep-clone the body before applying patches'
      );
    });

    test('compatibility.js only cleans incompatible fields and converts protocol structure', () => {
      const content = readFileSync(compatPath, 'utf-8');

      // Must clean Anthropic-specific fields (thinking, anthropic_beta, anthropic_version)
      assert.ok(
        /thinking/.test(content) && /anthropic_beta/.test(content),
        'compatibility.js must clean Anthropic-specific fields (thinking, anthropic_beta)'
      );

      // Must handle context_management and output_config (Claude Code new fields)
      assert.ok(
        /context_management/.test(content),
        'compatibility.js must handle context_management field'
      );

      // Must convert thinking param to reasoning_effort (protocol conversion)
      assert.ok(
        /reasoning_effort/.test(content),
        'compatibility.js must convert thinking to reasoning_effort (protocol structure conversion)'
      );

      // Must NOT add system messages or modify user content
      // (verify no hardcoded system prompt injection)
      assert.ok(
        !/role\s*:\s*['"]system['"]\s*,\s*content\s*:\s*['"`]/.test(content),
        'compatibility.js must not create system messages with hardcoded content'
      );
    });

    test('compatibility.js response-side cleaning only targets response content, not user content', () => {
      const content = readFileSync(compatPath, 'utf-8');

      // Response-side cleaning functions must exist
      assert.ok(
        /cleanThinkingBlocks/.test(content),
        'compatibility.js must have cleanThinkingBlocks for response-side cleaning'
      );
      assert.ok(
        /cleanReasoningContent/.test(content),
        'compatibility.js must have cleanReasoningContent for response-side cleaning'
      );
      assert.ok(
        /cleanThinkingProcessLeak/.test(content),
        'compatibility.js must have cleanThinkingProcessLeak for response-side cleaning'
      );

      // These functions must operate on response content (choices, delta, message)
      // not on user message content
      // Verify cleanThinkingProcessLeak takes a content string (response-side)
      assert.ok(
        /cleanThinkingProcessLeak\s*\(\s*content\s*\)/.test(content) ||
          /function cleanThinkingProcessLeak\s*\(\s*content\s*\)/.test(content),
        'cleanThinkingProcessLeak must operate on a content string parameter (response-side)'
      );
    });
  });

});

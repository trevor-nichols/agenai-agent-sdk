import assert from 'node:assert/strict';
import test from 'node:test';

import type { ValidationIssue } from '../src/foundation/types.js';
import { normalizeAgentStructuredOutputIssues } from '../src/structuredOutput/index.js';

test('structured diagnostic normalization preserves business rules as owned frozen data without evaluating accessors', () => {
  const source = { code: 'business_rule', message: 'This title is reserved.', path: ['title'] };
  Object.defineProperty(source, 'diagnostic', { get() { throw new Error('Diagnostic fields are not portable issues.'); } });
  const accessorIssue: ValidationIssue = {
    get code(): string { throw new Error('Issue accessors must not execute.'); },
    message: 'Unavailable', path: [],
  };
  const normalized = normalizeAgentStructuredOutputIssues([source, accessorIssue]);
  assert.deepEqual(normalized, [{ code: 'business_rule', message: 'This title is reserved.', path: ['title'] }]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[0]), true);
  assert.equal(Object.isFrozen(normalized[0]?.path), true);
  source.code = 'replaced'; source.message = 'Changed'; source.path[0] = 'other';
  assert.deepEqual(normalized, [{ code: 'business_rule', message: 'This title is reserved.', path: ['title'] }]);
});

test('structured diagnostics inspect at most eight issues and sixteen path segments while bounding oversized text and paths', () => {
  const sourcePath = Array.from({ length: 16 }, (_, index) => index);
  Object.defineProperty(sourcePath, 16, { get() { throw new Error('The seventeenth path segment must not be inspected.'); } });
  const sources: ValidationIssue[] = Array.from({ length: 8 }, (_, index) => ({ code: 'business_rule', message: `Rule ${index}`, path: ['title'] }));
  sources[0] = { code: 'c'.repeat(65), message: 'm'.repeat(257), path: sourcePath };
  sources[1] = { code: 'business_rule', message: 'Oversized path', path: ['title', 'x'.repeat(1_000_000), 'ignored'] };
  Object.defineProperty(sources, 8, { get() { throw new Error('The ninth issue must not be inspected.'); } });
  assert.deepEqual(normalizeAgentStructuredOutputIssues(sources), [
    { code: 'c'.repeat(64), message: 'm'.repeat(256), path: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
    { code: 'business_rule', message: 'Oversized path', path: ['title'] },
    ...Array.from({ length: 6 }, (_, index) => ({ code: 'business_rule', message: `Rule ${index + 2}`, path: ['title'] })),
  ]);
});

test('structured diagnostics enforce serialized UTF-8 path and aggregate issue capacity', () => {
  const tooLargePath = normalizeAgentStructuredOutputIssues([{ code: 'business_rule', message: 'Invalid path', path: ['🦊'.repeat(256)] }]);
  assert.deepEqual(tooLargePath, [{ code: 'business_rule', message: 'Invalid path', path: [] }]);
  const issue = { code: '🦊'.repeat(65), message: '🦊'.repeat(257), path: ['🦊'.repeat(255)] };
  const normalized = normalizeAgentStructuredOutputIssues(Array.from({ length: 8 }, () => issue));
  assert.deepEqual(normalized, [{ code: '🦊'.repeat(64), message: '🦊'.repeat(256), path: ['🦊'.repeat(255)] }]);
  assert.equal(Buffer.byteLength(JSON.stringify(normalized[0]?.path)), 1_024);
  assert.equal(Buffer.byteLength(JSON.stringify(normalized)) <= 4_096, true);
});

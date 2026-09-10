import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAgentTurnInputContent,
  safeParseAgentTurnInputContent,
} from '../src/turns/index.js';

function reference(contentId = 'content:a') {
  return {
    type: 'content_reference',
    environmentId: 'environment:a',
    environmentRevision: 2,
    contentCatalogRevision: 3,
    contentId,
    contentRevision: 4,
  } as const;
}

test('content references preserve opaque generation and revision identity with native arguments', () => {
  const input = { parts: [{ type: 'text', text: 'Review this change.' }, { ...reference(), arguments: 'focused review' }] };
  assert.deepEqual(parseAgentTurnInputContent(input), input);
});

test('references reject native payloads, duplicate identities and invalid revisions', () => {
  for (const part of [
    { ...reference(), path: '/private/skill/SKILL.md' },
    { ...reference(), nativeName: 'review' },
    { ...reference(), environmentRevision: 0 },
    { ...reference(), contentRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...reference(), contentCatalogRevision: 1.5 },
  ]) assert.equal(safeParseAgentTurnInputContent({ parts: [part] }).success, false);
  assert.equal(safeParseAgentTurnInputContent({ parts: [reference(), { ...reference(), contentRevision: 5 }] }).success, false);
});

test('reference count and UTF-8 argument limits apply independently', () => {
  const parts = Array.from({ length: 16 }, (_, index) => reference(`content:${index}`));
  assert.equal(safeParseAgentTurnInputContent({ parts }).success, true);
  assert.equal(safeParseAgentTurnInputContent({ parts: [...parts, reference('content:overflow')] }).success, false);
  assert.equal(safeParseAgentTurnInputContent({ parts: [{ ...reference(), arguments: 'é'.repeat(2048) }] }).success, true);
  assert.equal(safeParseAgentTurnInputContent({ parts: [{ ...reference(), arguments: 'é'.repeat(2049) }] }).success, false);
});

test('references remain subject to the complete existing input envelope', () => {
  const parts = Array.from({ length: 16 }, (_, index) => ({ ...reference(`content:${index}`), arguments: 'x'.repeat(4096) }));
  const textParts = Array.from({ length: 16 }, () => ({ type: 'text', text: 'x'.repeat(64000) }));
  assert.equal(safeParseAgentTurnInputContent({ parts: [...parts, ...textParts] }).success, false);
});

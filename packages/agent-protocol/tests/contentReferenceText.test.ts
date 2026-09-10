import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CONTENT_REFERENCE_TEXT_FORMATS,
  findAgentContentReferenceTextIssue,
  isAgentContentReferenceTextAllowed,
  meetAgentContentReferenceTextFormat,
} from '../src/capabilities/index.js';
import { AgentContentReferenceInputCapabilitySchema } from '../src/zod/capabilities.js';

test('skill text formats preserve Unicode prose and reject the declared syntax only', () => {
  for (const format of AGENT_CONTENT_REFERENCE_TEXT_FORMATS) {
    for (const text of ['', 'Review src/auth.ts --focus security', 'Résumé 日本語 🙂']) {
      assert.equal(isAgentContentReferenceTextAllowed(text, format), true, `${format}: ${text}`);
    }
  }
  for (const character of ['\n', '\r', '\t', '\0', '\u0085', '\u200b', '\u200d', '\u2028', '\u2029']) {
    const text = `before${character}after`;
    assert.equal(isAgentContentReferenceTextAllowed(text, 'unrestricted'), true);
    assert.equal(isAgentContentReferenceTextAllowed(text, 'single_line'), false);
    assert.equal(isAgentContentReferenceTextAllowed(text, 'literal_single_line'), false);
  }
  for (const text of ['Explain @agenai imports.', 'Explain $HOME.', 'Review `file.ts`.', '/command', '  /command']) {
    assert.equal(isAgentContentReferenceTextAllowed(text, 'unrestricted'), true);
    assert.equal(isAgentContentReferenceTextAllowed(text, 'single_line'), true);
    assert.equal(isAgentContentReferenceTextAllowed(text, 'literal_single_line'), false);
  }
});

test('format composition never widens either input policy', () => {
  const samples = ['plain', 'line\nnext', '@package', '/command'];
  for (const left of AGENT_CONTENT_REFERENCE_TEXT_FORMATS) {
    for (const right of AGENT_CONTENT_REFERENCE_TEXT_FORMATS) {
      const result = meetAgentContentReferenceTextFormat(left, right);
      assert.equal(result, meetAgentContentReferenceTextFormat(right, left));
      for (const text of samples) {
        assert.equal(isAgentContentReferenceTextAllowed(text, result),
          isAgentContentReferenceTextAllowed(text, left) && isAgentContentReferenceTextAllowed(text, right));
      }
    }
  }
});

test('prompt and argument policies are independent and issues contain no submitted text', () => {
  const input = { prompt: 'Review:\n@package', arguments: ['safe'],
    textFormats: { prompt: 'unrestricted', arguments: 'single_line' } } as const;
  assert.equal(findAgentContentReferenceTextIssue(input), null);
  assert.deepEqual(findAgentContentReferenceTextIssue({ ...input, arguments: ['safe', 'private\nargument'] }),
    { target: 'arguments', format: 'single_line' });
  assert.deepEqual(findAgentContentReferenceTextIssue({ ...input,
    textFormats: { ...input.textFormats, prompt: 'literal_single_line' } }),
  { target: 'prompt', format: 'literal_single_line' });
});

test('supported references require explicit canonical text formats without fallback', () => {
  const capability = { kind: 'supported', maxReferences: 1, arguments: true };
  assert.equal(AgentContentReferenceInputCapabilitySchema.safeParse(capability).success, false);
  for (const textFormats of [{}, { prompt: 'unrestricted' },
    { prompt: 'unknown', arguments: 'single_line' },
    { prompt: 'unrestricted', arguments: 'single_line', nativeRegex: '.*' }]) {
    assert.equal(AgentContentReferenceInputCapabilitySchema.safeParse({ ...capability, textFormats }).success, false);
  }
  const valid = { ...capability, textFormats: { prompt: 'unrestricted', arguments: 'single_line' } };
  assert.deepEqual(AgentContentReferenceInputCapabilitySchema.parse(valid), valid);
});

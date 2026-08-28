// ------------------------------------------------------------------------------------------------
//                turnsRequests.test.ts - Turn inputs and exact interaction resolution coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAgentRequest,
  parseAgentRequestResolutionFor,
  parseAgentTurnInputContent,
  parseAgentTurnRunInput,
  safeParseAgentRequest,
  safeParseAgentRequestResolution,
  safeParseAgentRequestResolutionFor,
  safeParseAgentTurnInputContent,
  safeParseAgentTurnRunInput,
} from '../src/public/index.js';

const elicitationRequest = {
  requestKind: 'elicitation',
  requestId: 'request:settings',
  prompt: 'Choose execution settings.',
  fields: [
    {
      fieldId: 'field:mode',
      kind: 'choice',
      label: 'Mode',
      required: true,
      multiple: false,
      allowOther: false,
      options: [
        { value: 'plan', label: 'Plan' },
        { value: 'build', label: 'Build' },
      ],
    },
    {
      fieldId: 'field:notes',
      kind: 'text',
      label: 'Notes',
      required: false,
      multiline: true,
    },
  ],
} as const;

test('turn input accepts bounded text, URL, inline, and local-file images', () => {
  assert.deepEqual(
    parseAgentTurnInputContent({
      parts: [{ type: 'text', text: 'Steer the running turn.' }],
      summary: 'Steering instruction',
    }),
    {
      parts: [{ type: 'text', text: 'Steer the running turn.' }],
      summary: 'Steering instruction',
    },
  );
  assert.equal(
    safeParseAgentTurnInputContent({
      parts: [{ type: 'text', text: 'No runtime identifiers here.' }],
      turnId: 'turn:not-content',
    }).success,
    false,
  );

  const parsed = parseAgentTurnRunInput({
    turnId: 'turn:1',
    interactionMode: 'default',
    summary: 'Inspect the image.',
    parts: [
      { type: 'text', text: 'Describe the reference.' },
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://example.com/reference.png',
          mediaType: 'image/png',
          byteSize: 256,
          widthPixels: 16,
          heightPixels: 16,
        },
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          byteSize: 5,
          widthPixels: 1,
          heightPixels: 1,
        },
      },
      {
        type: 'image',
        source: {
          type: 'local_file',
          path: '/run/agenai/images/reference.webp',
          mediaType: 'image/webp',
          byteSize: 64,
          widthPixels: 8,
          heightPixels: 8,
          sha256: 'a'.repeat(64),
        },
      },
    ],
  });
  assert.equal(parsed.parts.length, 4);
  assert.equal(parsed.interactionMode, 'default');
  for (const invalidModeInput of [
    {
      turnId: 'turn:missing-mode',
      parts: [{ type: 'text', text: 'Mode is required.' }],
    },
    {
      turnId: 'turn:unknown-mode',
      interactionMode: 'build',
      parts: [{ type: 'text', text: 'Mode must be canonical.' }],
    },
  ]) {
    assert.equal(safeParseAgentTurnRunInput(invalidModeInput).success, false);
  }

  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:1',
      interactionMode: 'default',
      parts: [
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: 'aGVsbG8=',
            byteSize: 5,
            widthPixels: 1,
            heightPixels: 1,
          },
          mediaType: 'image/jpeg',
        },
      ],
    }).success,
    false,
  );
  for (const path of [
    'relative/image.png',
    '/../etc/passwd',
    '/..',
    '/run/agenai/../secrets/image.png',
  ]) {
    assert.equal(
      safeParseAgentTurnRunInput({
        turnId: 'turn:local-file-invalid-path',
        interactionMode: 'default',
        parts: [{
          type: 'image',
          source: {
            type: 'local_file',
            path,
            mediaType: 'image/png',
            byteSize: 1,
            widthPixels: 1,
            heightPixels: 1,
            sha256: 'a'.repeat(64),
          },
        }],
      }).success,
      false,
      path,
    );
  }

  for (const source of [
    {
      type: 'local_file',
      path: '/run/agenai/image.png',
      mediaType: 'image/png',
      byteSize: 0,
      widthPixels: 1,
      heightPixels: 1,
      sha256: 'a'.repeat(64),
    },
    {
      type: 'local_file',
      path: '/run/agenai/image.png',
      mediaType: 'image/png',
      byteSize: 1,
      widthPixels: 1,
      heightPixels: 1,
      sha256: 'A'.repeat(64),
    },
  ]) {
    assert.equal(
      safeParseAgentTurnRunInput({
        turnId: 'turn:local-file-invalid',
        interactionMode: 'default',
        parts: [{ type: 'image', source }],
      }).success,
      false,
    );
  }

  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:1',
      interactionMode: 'default',
      parts: [],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:1',
      interactionMode: 'default',
      parts: [{
        type: 'image',
        source: {
          type: 'base64',
          mediaType: 'text/plain',
          data: '$',
          byteSize: 1,
          widthPixels: 1,
          heightPixels: 1,
        },
      }],
    }).success,
    false,
  );
  for (const data of ['A', 'AA=', 'aGVsbG8', 'aGVsbG8===']) {
    assert.equal(
      safeParseAgentTurnRunInput({
        turnId: 'turn:1',
        interactionMode: 'default',
        parts: [{
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data,
            byteSize: 1,
            widthPixels: 1,
            heightPixels: 1,
          },
        }],
      }).success,
      false,
      data,
    );
  }
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:1',
      interactionMode: 'default',
      parts: [{ type: 'text', text: 'ok', extra: true }],
    }).success,
    false,
  );
});

test('turn input enforces canonical collection, summary, and aggregate content bounds', () => {
  const maximumParts = Array.from({ length: 100 }, (_value, index) => ({
    type: 'text' as const,
    text: `part ${index}`,
  }));
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:bounded',
      interactionMode: 'plan',
      parts: maximumParts,
      summary: 's'.repeat(2_000),
    }).success,
    true,
  );
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:too-many-parts',
      interactionMode: 'default',
      parts: [...maximumParts, { type: 'text', text: 'part 100' }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:summary-too-long',
      interactionMode: 'default',
      parts: [{ type: 'text', text: 'bounded' }],
      summary: 's'.repeat(2_001),
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentTurnRunInput({
      turnId: 'turn:content-too-large',
      interactionMode: 'default',
      parts: Array.from({ length: 17 }, () => ({
        type: 'text',
        text: 'x'.repeat(64_000),
      })),
    }).success,
    false,
  );
});

test('approval and structured elicitation requests are strict discriminated values', () => {
  assert.equal(
    parseAgentRequest({
      requestKind: 'approval',
      requestId: 'request:approval',
      prompt: 'Run the command?',
      subject: { kind: 'command', title: 'Run tests' },
    }).requestKind,
    'approval',
  );
  assert.equal(parseAgentRequest(elicitationRequest).requestKind, 'elicitation');

  const duplicateField = {
    ...elicitationRequest,
    fields: [elicitationRequest.fields[0], elicitationRequest.fields[0]],
  };
  assert.equal(safeParseAgentRequest(duplicateField).success, false);

  const duplicateChoice = {
    ...elicitationRequest,
    fields: [{
      ...elicitationRequest.fields[0],
      options: [
        elicitationRequest.fields[0].options[0],
        elicitationRequest.fields[0].options[0],
      ],
    }],
  };
  assert.equal(safeParseAgentRequest(duplicateChoice).success, false);

  const noncanonicalChoice = {
    ...elicitationRequest,
    fields: [{
      ...elicitationRequest.fields[0],
      options: [{ value: ' plan ', label: 'Plan' }],
    }],
  };
  assert.equal(safeParseAgentRequest(noncanonicalChoice).success, false);
});

test('request resolutions must match request identity, kind, fields, and choices', () => {
  const acceptedResolution = {
    requestKind: 'elicitation',
    requestId: 'request:settings',
    disposition: 'answered',
    answers: [
      { fieldId: 'field:mode', kind: 'choice', values: ['build'] },
      { fieldId: 'field:notes', kind: 'text', value: '  Keep the diff focused.  ' },
    ],
  } as const;
  const accepted = parseAgentRequestResolutionFor(
    elicitationRequest,
    acceptedResolution,
  );
  assert.equal(accepted.requestKind, 'elicitation');
  assert.deepEqual(accepted, acceptedResolution);

  const customChoiceRequest = {
    ...elicitationRequest,
    fields: [{
      ...elicitationRequest.fields[0],
      allowOther: true,
    }],
  } as const;
  const customChoiceResolution = {
    requestKind: 'elicitation',
    requestId: 'request:settings',
    disposition: 'answered',
    answers: [{
      fieldId: 'field:mode',
      kind: 'choice',
      values: [],
      other: '  custom  ',
    }],
  } as const;
  assert.deepEqual(
    parseAgentRequestResolutionFor(customChoiceRequest, customChoiceResolution),
    customChoiceResolution,
  );
  assert.equal(
    safeParseAgentRequestResolutionFor(customChoiceRequest, {
      requestKind: 'elicitation',
      requestId: 'request:settings',
      disposition: 'answered',
      answers: [{
        fieldId: 'field:mode',
        kind: 'choice',
        values: ['plan'],
        other: 'custom',
      }],
    }).success,
    false,
  );

  const multipleChoiceRequest = {
    ...elicitationRequest,
    fields: [{
      ...elicitationRequest.fields[0],
      multiple: true,
    }],
  } as const;
  const duplicateChoiceResolution = {
    requestKind: 'elicitation',
    requestId: 'request:settings',
    disposition: 'answered',
    answers: [{
      fieldId: 'field:mode',
      kind: 'choice',
      values: ['plan', 'plan'],
    }],
  } as const;
  assert.equal(
    safeParseAgentRequestResolutionFor(
      multipleChoiceRequest,
      duplicateChoiceResolution,
    ).success,
    false,
  );
  assert.equal(
    safeParseAgentRequestResolution(duplicateChoiceResolution).success,
    false,
  );
  assert.equal(
    safeParseAgentRequestResolution({
      requestKind: 'elicitation',
      requestId: 'request:settings',
      disposition: 'answered',
      answers: [{
        fieldId: 'field:mode',
        kind: 'choice',
        values: [' build '],
      }],
    }).success,
    false,
  );
  for (const answer of [
    { fieldId: 'field:notes', kind: 'text', value: '   ' },
    { fieldId: 'field:mode', kind: 'choice', values: [], other: '\t\n' },
  ]) {
    assert.equal(
      safeParseAgentRequestResolution({
        requestKind: 'elicitation',
        requestId: 'request:settings',
        disposition: 'answered',
        answers: [answer],
      }).success,
      false,
    );
  }

  for (const invalid of [
    {
      requestKind: 'elicitation',
      requestId: 'request:other',
      disposition: 'canceled',
    },
    {
      requestKind: 'approval',
      requestId: 'request:settings',
      decision: 'approved',
    },
    {
      requestKind: 'elicitation',
      requestId: 'request:settings',
      disposition: 'answered',
      answers: [],
    },
    {
      requestKind: 'elicitation',
      requestId: 'request:settings',
      disposition: 'answered',
      answers: [{ fieldId: 'field:mode', kind: 'choice', values: ['unknown'] }],
    },
    {
      requestKind: 'elicitation',
      requestId: 'request:settings',
      disposition: 'answered',
      answers: [{ fieldId: 'field:mode', kind: 'text', value: 'build' }],
    },
  ]) {
    assert.equal(
      safeParseAgentRequestResolutionFor(elicitationRequest, invalid).success,
      false,
    );
  }
});

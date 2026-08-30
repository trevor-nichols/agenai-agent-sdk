// ------------------------------------------------------------------------------------------------
//                capabilitiesArtifacts.test.ts - Provider matrix and artifact portability coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ARTIFACT_BYTE_SIZE_MAX,
  parseAgentArtifactDescriptor,
  parseAgentCapabilities,
  safeParseAgentArtifactDescriptor,
  safeParseAgentCapabilities,
} from '../src/public/index.js';
import { providerCapabilityFixtures } from './fixtures.js';

test('all accepted provider capability fixtures preserve truthful differences', () => {
  const parsed = Object.fromEntries(
    Object.entries(providerCapabilityFixtures).map(([key, value]) => [
      key,
      parseAgentCapabilities(value),
    ]),
  );

  assert.equal(parsed.codex.sessions.branch.kind, 'through_turn');
  assert.equal(parsed.claudeCode.sessions.branch.kind, 'through_turn');
  assert.equal(parsed.opencode.sessions.branch.kind, 'through_turn');
  assert.equal(parsed.cursor.sessions.branch.kind, 'unsupported');
  assert.equal(parsed.grokBuild.sessions.branch.kind, 'unsupported');
  assert.equal(parsed.grokBuild.requests.approval.kind, 'supported');
  assert.deepEqual(parsed.grokBuild.context.usage, {
    kind: 'supported',
    measurementScopes: ['materialization'],
    cumulativeFields: [
      'inputTokens',
      'outputTokens',
      'cachedReadTokens',
      'reasoningTokens',
      'modelCalls',
      'turns',
    ],
  });
  assert.equal(parsed.grokBuild.requests.elicitation.kind, 'unsupported');
  assert.equal(parsed.codex.turns.steer.kind, 'supported');
  assert.equal(parsed.opencode.turns.steer.kind, 'unsupported');
  for (const capabilities of Object.values(parsed)) {
    assert.deepEqual(capabilities.turns.interactionModes, ['default']);
  }
});

test('capabilities reject noncanonical collections and product-shaped additions', () => {
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.fixture,
      configuration: {
        kind: 'selectable',
        fields: [
          { key: 'model', optionIds: ['fixture-model'] },
          { key: 'model', optionIds: ['other-model'] },
        ],
      },
    }).success,
    false,
  );
  for (const interactionModes of [
    [],
    ['plan', 'default'],
    ['default', 'default'],
  ]) {
    assert.equal(
      safeParseAgentCapabilities({
        ...providerCapabilityFixtures.fixture,
        turns: {
          ...providerCapabilityFixtures.fixture.turns,
          interactionModes,
        },
      }).success,
      false,
    );
  }
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.cursor,
      output: {
        ...providerCapabilityFixtures.cursor.output,
        artifactKinds: ['diff', 'plan'],
      },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.fixture,
      authentication: {
        kind: 'supported',
        flows: ['terminal', 'device_code'],
      },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.codex,
      teamId: 1,
      visibility: 'member',
    }).success,
    false,
  );
});

test('capabilities reject older versions and removed active-input declarations', () => {
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.codex,
      protocolVersion: 3,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.fixture,
      turns: {
        interrupt: true,
        activeInput: { kind: 'supported', modes: ['steer'] },
      },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.fixture,
      authentication: { kind: 'supported', flows: [] },
    }).success,
    false,
  );
});

test('image capabilities enforce canonical bounded cross-field invariants', () => {
  const supported = providerCapabilityFixtures.fixture.input.images;
  const invalidImages = [
    { ...supported, sourceKinds: ['local_file', 'url'] },
    { ...supported, mediaTypes: ['image/webp', 'image/png'] },
    { ...supported, maxImages: 0 },
    { ...supported, maxBytesPerImage: 10, maxTotalBytes: 9 },
    { ...supported, maxImages: 2, maxBytesPerImage: 10, maxTotalBytes: 21 },
    {
      ...supported,
      maxWidthPixels: 10,
      maxHeightPixels: 10,
      maxPixelsPerImage: 101,
    },
  ] as const;

  for (const images of invalidImages) {
    assert.equal(
      safeParseAgentCapabilities({
        ...providerCapabilityFixtures.fixture,
        input: { text: true, images },
      }).success,
      false,
    );
  }

  assert.equal(
    safeParseAgentCapabilities({
      ...providerCapabilityFixtures.fixture,
      turns: { interrupt: true, steer: true },
    }).success,
    false,
  );
});

test('artifact descriptors carry portable identity and integrity only', () => {
  const artifact = parseAgentArtifactDescriptor({
    artifactId: 'artifact:diff-1',
    kind: 'diff',
    displayName: 'working-tree.diff',
    mediaType: 'text/x-diff',
    byteSize: 120,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
    summary: 'One file changed.',
  });
  assert.equal(artifact.kind, 'diff');

  assert.equal(
    safeParseAgentArtifactDescriptor({
      ...artifact,
      storageBackend: 'gcs',
      objectLocator: 'bucket/object',
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentArtifactDescriptor({
      ...artifact,
      byteSize: Number.POSITIVE_INFINITY,
    }).success,
    false,
  );
  assert.equal(
    parseAgentArtifactDescriptor({
      ...artifact,
      byteSize: AGENT_ARTIFACT_BYTE_SIZE_MAX,
    }).byteSize,
    AGENT_ARTIFACT_BYTE_SIZE_MAX,
  );
  assert.equal(
    safeParseAgentArtifactDescriptor({
      ...artifact,
      byteSize: AGENT_ARTIFACT_BYTE_SIZE_MAX + 1,
    }).success,
    false,
  );
  for (const displayName of [' ', ' padded', 'padded ']) {
    assert.equal(
      safeParseAgentArtifactDescriptor({ ...artifact, displayName }).success,
      false,
    );
  }
});

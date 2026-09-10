import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH,
  parseAgentEffectiveContentCatalog,
  parseAgentEffectiveContentDescriptor,
  safeParseAgentEffectiveContentCatalog,
  safeParseAgentEffectiveContentDescriptor,
} from '../src/effectiveContent/index.js';

const observedAt = '2026-09-08T12:00:00.000Z';

const descriptorA = {
  contentId: 'content:a',
  revision: 1,
  kind: 'skill',
  name: 'Workspace skill A',
  summary: 'A bounded native skill observation.',
  source: { scope: 'workspace', origin: 'workspace' },
  registration: { kind: 'known', value: true },
  enablement: { kind: 'known', value: true },
  invocation: 'user_and_model',
  modelCallability: { kind: 'known', value: true },
  extension: { extensionId: 'extension:one', revision: 2, catalogRevision: 3 },
} as const;

const descriptorB = {
  contentId: 'content:b',
  revision: 1,
  kind: 'agent_definition',
  name: 'Workspace agent B',
  source: { scope: 'project', origin: 'plugin' },
  registration: { kind: 'unknown' },
  enablement: { kind: 'known', value: false },
  invocation: 'unknown',
  modelCallability: { kind: 'unknown' },
} as const;

const catalog = {
  revision: 4,
  observedAt,
  content: [descriptorA, descriptorB],
} as const;

test('effective content preserves sparse native facts and qualified extension identity', () => {
  const parsedDescriptor = parseAgentEffectiveContentDescriptor(descriptorA);
  const parsedCatalog = parseAgentEffectiveContentCatalog(catalog);

  assert.deepEqual(parsedDescriptor, descriptorA);
  assert.deepEqual(parsedCatalog, catalog);
  assert.equal(parsedCatalog.content[0]?.contentId, 'content:a');
  assert.ok(Object.isFrozen(parsedDescriptor));
  assert.ok(Object.isFrozen(parsedCatalog));
  assert.ok(Object.isFrozen(parsedCatalog.content));
  assert.ok(Object.isFrozen(parsedCatalog.content[0]));
});

test('effective content requires strict facts and rejects native metadata', () => {
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({
      ...descriptorA,
      registration: { kind: 'unknown', value: false },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({
      ...descriptorA,
      source: { scope: 'workspace', origin: 'native-config' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({
      ...descriptorA,
      native: { path: '/private/provider-state' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({
      ...descriptorA,
      extension: {
        extensionId: 'extension:one',
        revision: 2,
        catalogRevision: 3,
        path: '/private/provider-state',
      },
    }).success,
    false,
  );
});

test('effective content keeps denied entries from advertising invocation authority', () => {
  for (const input of [
    { ...descriptorA, invocation: 'model_only', modelCallability: { kind: 'known', value: false } },
    { ...descriptorA, invocation: 'user_only', modelCallability: { kind: 'known', value: true } },
    { ...descriptorA, invocation: 'unavailable', modelCallability: { kind: 'known', value: true } },
    { ...descriptorA, registration: { kind: 'known', value: false }, invocation: 'user_only', modelCallability: { kind: 'known', value: false } },
    { ...descriptorA, enablement: { kind: 'known', value: false }, invocation: 'unknown', modelCallability: { kind: 'known', value: true } },
  ]) {
    assert.equal(safeParseAgentEffectiveContentDescriptor(input).success, false);
  }

  // Registration, enablement and callability remain separate facts when they are not denied.
  const independent = parseAgentEffectiveContentDescriptor({
    ...descriptorA,
    registration: { kind: 'known', value: true },
    enablement: { kind: 'unknown' },
    invocation: 'user_only',
    modelCallability: { kind: 'known', value: false },
  });
  assert.equal(independent.registration.kind, 'known');
  assert.equal(independent.enablement.kind, 'unknown');
  assert.equal(independent.invocation, 'user_only');
});

test('agent mode and hidden state remain independent of enablement and callability', () => {
  const agent = parseAgentEffectiveContentDescriptor({
    ...descriptorB,
    enablement: { kind: 'known', value: true },
    agentDefinition: { mode: 'subagent', hidden: { kind: 'known', value: true } },
  });
  assert.deepEqual(agent.agentDefinition, {
    mode: 'subagent', hidden: { kind: 'known', value: true },
  });
  assert.deepEqual(agent.enablement, { kind: 'known', value: true });
  assert.equal(agent.invocation, 'unknown');
  assert.deepEqual(agent.modelCallability, { kind: 'unknown' });
  assert.ok(Object.isFrozen(agent.agentDefinition));

  for (const invalid of [
    { ...descriptorA, agentDefinition: agent.agentDefinition },
    { ...descriptorB, agentDefinition: { mode: 'custom-native-mode', hidden: { kind: 'unknown' } } },
    { ...descriptorB, agentDefinition: { mode: 'primary', hidden: true } },
    { ...descriptorB, agentDefinition: { mode: 'all', hidden: { kind: 'unknown' }, system: 'private prompt' } },
  ]) {
    assert.equal(safeParseAgentEffectiveContentDescriptor(invalid).success, false);
    assert.equal(safeParseAgentEffectiveContentCatalog({ ...catalog, content: [invalid] }).success, false);
  }
});

test('effective content retains denied entries as unavailable or unknown', () => {
  for (const invocation of ['unavailable', 'unknown'] as const) {
    const parsed = parseAgentEffectiveContentDescriptor({
      ...descriptorA,
      registration: { kind: 'known', value: false },
      enablement: { kind: 'known', value: false },
      invocation,
      modelCallability: { kind: 'known', value: false },
    });
    assert.equal(parsed.invocation, invocation);
  }
});

test('effective content catalogs require canonical unique IDs', () => {
  assert.equal(
    safeParseAgentEffectiveContentCatalog({
      ...catalog,
      content: [descriptorB, descriptorA],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentCatalog({
      ...catalog,
      content: [descriptorA, { ...descriptorA, revision: 2 }],
    }).success,
    false,
  );
});

test('effective content catalogs enforce UTF-8 bytes, entry count, depth and accessors before parsing', () => {
  const oversizedByUtf8 = Array.from({ length: 100 }, (_, index) => ({
    ...descriptorA,
    contentId: `content:${String(index).padStart(3, '0')}`,
    summary: '界'.repeat(2_000),
  }));
  assert.equal(
    safeParseAgentEffectiveContentCatalog({
      ...catalog,
      content: oversizedByUtf8,
    }).success,
    false,
  );

  const tooManyEntries = Array.from(
    { length: AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH + 1 },
    (_, index) => ({
      ...descriptorA,
      contentId: `content:${String(index).padStart(4, '0')}`,
    }),
  );
  assert.equal(
    safeParseAgentEffectiveContentCatalog({ ...catalog, content: tooManyEntries }).success,
    false,
  );

  const cyclic: Record<string, unknown> = { ...catalog };
  cyclic.content = [cyclic];
  assert.equal(safeParseAgentEffectiveContentCatalog(cyclic).success, false);

  let getterCalls = 0;
  const accessor = {
    ...catalog,
    get revision() {
      getterCalls += 1;
      return 4;
    },
  };
  assert.equal(safeParseAgentEffectiveContentCatalog(accessor).success, false);
  assert.equal(getterCalls, 0);
});

test('effective content bounds names, summaries and revisions', () => {
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({ ...descriptorA, name: 'x'.repeat(201) }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({ ...descriptorA, summary: 'x'.repeat(2_001) }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({ ...descriptorA, revision: 0 }).success,
    false,
  );
  assert.equal(
    safeParseAgentEffectiveContentDescriptor({
      ...descriptorA,
      extension: { extensionId: 'extension:one', revision: Number.MAX_SAFE_INTEGER + 1, catalogRevision: 1 },
    }).success,
    false,
  );
});

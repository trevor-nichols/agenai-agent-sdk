import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_EXTENSION_CATALOG_MAX_LENGTH,
  AGENT_EXTENSION_COMPONENTS_MAX_LENGTH,
  parseAgentExtensionCatalog,
  parseAgentExtensionDescriptor,
  safeParseAgentExtensionCatalog,
  safeParseAgentExtensionDescriptor,
} from '../src/extensions/index.js';

const descriptor = {
  extensionId: 'extension:workspace-tools',
  revision: 4,
  name: 'Workspace tools',
  summary: 'Native package metadata with bounded contribution facts.',
  version: '1.2.3',
  installation: { kind: 'known', value: true },
  enablement: { kind: 'known', value: true },
  source: { scope: 'workspace', origin: 'plugin' },
  components: [
    {
      kind: 'skill',
      name: 'Review skill',
      target: {
        domain: 'content',
        id: 'content:review',
        revision: 2,
        catalogRevision: 8,
      },
    },
    {
      kind: 'command',
      name: 'Review command',
      target: {
        domain: 'commands',
        id: 'command:review',
        revision: 3,
        catalogRevision: 9,
      },
    },
    {
      kind: 'mcp_server',
      name: 'Review MCP server',
      target: {
        domain: 'integrations',
        id: 'integration:review',
        revision: 1,
        catalogRevision: 10,
      },
    },
    { kind: 'hook', name: 'Descriptive hook contribution' },
  ],
} as const;

const catalog = {
  revision: 11,
  observedAt: '2026-09-08T12:00:00.000Z',
  extensions: [descriptor],
} as const;

test('extension descriptors preserve qualified contribution identity and freeze output', () => {
  const parsedDescriptor = parseAgentExtensionDescriptor(descriptor);
  const parsedCatalog = parseAgentExtensionCatalog(catalog);

  assert.deepEqual(parsedDescriptor, descriptor);
  assert.deepEqual(parsedCatalog, catalog);
  assert.equal(parsedDescriptor.components[0]?.target?.domain, 'content');
  assert.equal(parsedDescriptor.components[1]?.target?.domain, 'commands');
  assert.equal(parsedDescriptor.components[2]?.target?.domain, 'integrations');
  assert.ok(Object.isFrozen(parsedDescriptor));
  assert.ok(Object.isFrozen(parsedDescriptor.components));
  assert.ok(Object.isFrozen(parsedDescriptor.components[0]));
  assert.ok(Object.isFrozen(parsedCatalog));
  assert.ok(Object.isFrozen(parsedCatalog.extensions));
});

test('extension component kinds require their matching target domain', () => {
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      components: [{
        kind: 'skill',
        name: 'Wrong target domain',
        target: {
          domain: 'commands',
          id: 'command:review',
          revision: 1,
          catalogRevision: 1,
        },
      }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      components: [{
        kind: 'command',
        name: 'Wrong target domain',
        target: {
          domain: 'content',
          id: 'content:review',
          revision: 1,
          catalogRevision: 1,
        },
      }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      components: [{
        kind: 'mcp_server',
        name: 'Wrong target domain',
        target: {
          domain: 'content',
          id: 'content:review',
          revision: 1,
          catalogRevision: 1,
        },
      }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      components: [{
        kind: 'hook',
        name: 'Descriptive only hook',
        target: {
          domain: 'integrations',
          id: 'integration:review',
          revision: 1,
          catalogRevision: 1,
        },
      }],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      components: [{ kind: 'future_component', name: 'Closed vocabulary' }],
    }).success,
    false,
  );
});

test('extension catalogs require canonical unique package IDs', () => {
  const second = { ...descriptor, extensionId: 'extension:workspace-z' };
  assert.equal(
    safeParseAgentExtensionCatalog({
      ...catalog,
      extensions: [descriptor, second],
    }).success,
    true,
  );
  assert.equal(
    safeParseAgentExtensionCatalog({
      ...catalog,
      extensions: [second, descriptor],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionCatalog({
      ...catalog,
      extensions: [descriptor, { ...descriptor, revision: 5 }],
    }).success,
    false,
  );
});

test('extension catalogs enforce package, contribution and UTF-8 byte bounds', () => {
  const tooManyPackages = Array.from(
    { length: AGENT_EXTENSION_CATALOG_MAX_LENGTH + 1 },
    (_, index) => ({
      ...descriptor,
      extensionId: `extension:${String(index).padStart(4, '0')}`,
      components: [],
    }),
  );
  assert.equal(
    safeParseAgentExtensionCatalog({ ...catalog, extensions: tooManyPackages }).success,
    false,
  );

  const contribution = { kind: 'other', name: 'Contribution' } as const;
  const tooManyComponents = [
    {
      ...descriptor,
      extensionId: 'extension:components-a',
      components: Array.from(
        { length: AGENT_EXTENSION_COMPONENTS_MAX_LENGTH / 2 + 1 },
        () => contribution,
      ),
    },
    {
      ...descriptor,
      extensionId: 'extension:components-b',
      components: Array.from(
        { length: AGENT_EXTENSION_COMPONENTS_MAX_LENGTH / 2 + 1 },
        () => contribution,
      ),
    },
  ];
  assert.equal(
    safeParseAgentExtensionCatalog({ ...catalog, extensions: tooManyComponents }).success,
    false,
  );

  const oversized = Array.from({ length: AGENT_EXTENSION_CATALOG_MAX_LENGTH }, (_, index) => ({
    ...descriptor,
    extensionId: `extension:bytes-${String(index).padStart(3, '0')}`,
    summary: '界'.repeat(2_000),
    components: [],
  }));
  assert.equal(
    safeParseAgentExtensionCatalog({ ...catalog, extensions: oversized }).success,
    false,
  );
});

test('extension refined parsers reject cycles and accessor-backed values before reading them', () => {
  const cyclic: Record<string, unknown> = { ...descriptor };
  cyclic.components = [cyclic];
  assert.equal(safeParseAgentExtensionDescriptor(cyclic).success, false);

  let getterCalls = 0;
  const accessor = {
    ...descriptor,
    get extensionId() {
      getterCalls += 1;
      return descriptor.extensionId;
    },
  };
  assert.equal(safeParseAgentExtensionDescriptor(accessor).success, false);
  assert.equal(getterCalls, 0);

  const cyclicCatalog: Record<string, unknown> = { ...catalog };
  cyclicCatalog.extensions = [cyclicCatalog];
  assert.equal(safeParseAgentExtensionCatalog(cyclicCatalog).success, false);
});

test('extension metadata remains descriptive and strict', () => {
  assert.equal(
    safeParseAgentExtensionDescriptor({
      ...descriptor,
      installation: { kind: 'known', value: true, path: '/provider/private' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({ ...descriptor, name: 'x'.repeat(201) }).success,
    false,
  );
  assert.equal(
    safeParseAgentExtensionDescriptor({ ...descriptor, version: '' }).success,
    false,
  );
});

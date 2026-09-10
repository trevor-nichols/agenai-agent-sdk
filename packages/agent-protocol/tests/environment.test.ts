import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ENVIRONMENT_DOMAINS,
  AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH,
  parseAgentEnvironmentCapability,
  parseAgentEnvironmentContentResult,
  parseAgentEnvironmentInvalidation,
  parseAgentEnvironmentSnapshot,
  safeParseAgentEnvironmentCapability,
  safeParseAgentEnvironmentContentResult,
  safeParseAgentEnvironmentInvalidation,
  safeParseAgentEnvironmentSnapshot,
} from '../src/environment/index.js';

const observedAt = '2026-09-08T12:00:00.000Z';

const contentDescriptor = {
  contentId: 'content:review',
  revision: 2,
  kind: 'skill',
  name: 'Review skill',
  summary: 'A native skill observation.',
  source: { scope: 'workspace', origin: 'workspace' },
  registration: { kind: 'known', value: true },
  enablement: { kind: 'known', value: true },
  invocation: 'user_and_model',
  modelCallability: { kind: 'known', value: true },
  extension: {
    extensionId: 'extension:workspace-tools',
    revision: 4,
    catalogRevision: 3,
  },
} as const;

const contentCatalog = {
  revision: 2,
  observedAt,
  content: [contentDescriptor],
} as const;

const commandCatalog = {
  revision: 4,
  observedAt,
  commands: [{
    commandId: 'command:review',
    revision: 1,
    name: 'Review command',
    source: { scope: 'workspace', origin: 'bundled' },
    availability: { kind: 'known', value: true },
  }],
} as const;

const integrationCatalog = {
  revision: 5,
  observedAt,
  integrations: [{
    integrationId: 'integration:review',
    revision: 1,
    kind: 'mcp',
    name: 'Review MCP',
    status: 'ready',
    servers: [{
      serverId: 'server:review',
      name: 'Review server',
      status: 'ready',
      tools: [],
      resources: [],
    }],
  }],
} as const;

const extensionCatalog = {
  revision: 3,
  observedAt,
  extensions: [{
    extensionId: 'extension:workspace-tools',
    revision: 4,
    name: 'Workspace tools',
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
          catalogRevision: 2,
        },
      },
      {
        kind: 'command',
        name: 'Review command',
        target: {
          domain: 'commands',
          id: 'command:review',
          revision: 1,
          catalogRevision: 4,
        },
      },
      {
        kind: 'mcp_server',
        name: 'Review MCP',
        target: {
          domain: 'integrations',
          id: 'integration:review',
          revision: 1,
          catalogRevision: 5,
        },
      },
      { kind: 'hook', name: 'Descriptive hook' },
    ],
  }],
} as const;

const availableContent = {
  kind: 'available',
  catalog: contentCatalog,
  extent: 'workspace_discovery',
  completeness: 'complete',
  reasons: [],
} as const;
const availableCommands = {
  kind: 'available',
  catalog: commandCatalog,
  extent: 'workspace_discovery',
  completeness: 'complete',
  reasons: [],
} as const;
const availableExtensions = {
  kind: 'available',
  catalog: extensionCatalog,
  extent: 'workspace_discovery',
  completeness: 'complete',
  reasons: [],
} as const;
const availableIntegrations = {
  kind: 'available',
  catalog: integrationCatalog,
  extent: 'session',
  completeness: 'complete',
  reasons: [],
} as const;

const snapshot = {
  schemaVersion: 1,
  environmentId: 'environment:workspace-tools',
  revision: 6,
  content: availableContent,
  commands: availableCommands,
  extensions: availableExtensions,
  integrations: availableIntegrations,
} as const;

test('environment snapshots compose frozen domain catalogs and exact references', () => {
  const parsed = parseAgentEnvironmentSnapshot(snapshot);

  assert.deepEqual(parsed, snapshot);
  assert.equal(parsed.content.kind, 'available');
  assert.equal(parsed.content.catalog.revision, 2);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.content));
  assert.ok(Object.isFrozen(parsed.content.catalog));
  assert.ok(Object.isFrozen(parsed.extensions.catalog.extensions[0]));
});

test('available and unavailable domain states keep completeness reasons explicit', () => {
  assert.deepEqual(parseAgentEnvironmentContentResult(availableContent), availableContent);
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      ...availableContent,
      reasons: ['transient_failure'],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      ...availableContent,
      completeness: 'partial',
      reasons: [],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      ...availableContent,
      completeness: 'partial',
      reasons: ['missing_metadata'],
    }).success,
    true,
  );
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      kind: 'unsupported',
      reasons: [],
    }).success,
    true,
  );
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      kind: 'not_initialized',
      reasons: [],
      catalog: contentCatalog,
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentContentResult({
      kind: 'unavailable',
      reasons: [],
    }).success,
    false,
  );
});

test('snapshot references require exact catalog revisions and matching kinds', () => {
  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      extensions: {
        ...availableExtensions,
        catalog: {
          ...extensionCatalog,
          extensions: [{
            ...extensionCatalog.extensions[0],
            components: [{
              ...extensionCatalog.extensions[0]!.components[0]!,
              target: {
                ...extensionCatalog.extensions[0]!.components[0]!.target!,
                catalogRevision: 99,
              },
            }],
          }],
        },
      },
    }).success,
    false,
  );

  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      extensions: {
        ...availableExtensions,
        catalog: {
          ...extensionCatalog,
          extensions: [{
            ...extensionCatalog.extensions[0],
            components: [{
              ...extensionCatalog.extensions[0]!.components[0]!,
              target: {
                ...extensionCatalog.extensions[0]!.components[0]!.target!,
                id: 'content:missing',
              },
            }],
          }],
        },
      },
    }).success,
    false,
  );

  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      extensions: {
        ...availableExtensions,
        catalog: {
          ...extensionCatalog,
          extensions: [{
            ...extensionCatalog.extensions[0],
            components: [{
              ...extensionCatalog.extensions[0]!.components[0]!,
              kind: 'rule',
            }],
          }],
        },
      },
    }).success,
    false,
  );

  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      extensions: {
        ...availableExtensions,
        catalog: {
          ...extensionCatalog,
          extensions: [{
            ...extensionCatalog.extensions[0],
            components: [{
              ...extensionCatalog.extensions[0]!.components[2]!,
              kind: 'connector',
            }],
          }],
        },
      },
    }).success,
    false,
  );
});

test('content extension relationships also require an exact extension generation', () => {
  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      content: {
        ...availableContent,
        catalog: {
          ...contentCatalog,
          content: [{
            ...contentDescriptor,
            extension: {
              ...contentDescriptor.extension,
              catalogRevision: 99,
            },
          }],
        },
      },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentSnapshot({
      ...snapshot,
      content: {
        ...availableContent,
        catalog: {
          ...contentCatalog,
          content: [{
            ...contentDescriptor,
            extension: {
              ...contentDescriptor.extension,
              extensionId: 'extension:missing',
            },
          }],
        },
      },
    }).success,
    false,
  );
});

test('environment capabilities and invalidations require unique non-empty domains', () => {
  const capability = {
    instance: { kind: 'read', domains: ['content', 'extensions'] },
    session: { kind: 'unsupported' },
  } as const;
  const parsedCapability = parseAgentEnvironmentCapability(capability);
  assert.deepEqual(parsedCapability, capability);
  assert.ok(Object.isFrozen(parsedCapability));
  assert.equal(
    safeParseAgentEnvironmentCapability({
      instance: { kind: 'read', domains: ['content', 'content'] },
      session: { kind: 'unsupported' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentCapability({
      instance: { kind: 'read', domains: [] },
      session: { kind: 'unsupported' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentCapability({
      instance: { kind: 'read', domains: ['future'] },
      session: { kind: 'unsupported' },
    }).success,
    false,
  );

  const invalidation = {
    environmentId: snapshot.environmentId,
    domains: ['integrations', 'content'],
  } as const;
  assert.deepEqual(parseAgentEnvironmentInvalidation(invalidation), invalidation);
  assert.equal(
    safeParseAgentEnvironmentInvalidation({
      ...invalidation,
      domains: ['content', 'content'],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentInvalidation({ ...invalidation, domains: [] }).success,
    false,
  );
  assert.equal(
    safeParseAgentEnvironmentInvalidation({
      ...invalidation,
      domains: [...AGENT_ENVIRONMENT_DOMAINS, 'content'],
    }).success,
    false,
  );
});

test('snapshot bounds aggregate effective entries and rejects cycles/accessors before parsing', () => {
  const contentEntries = Array.from({ length: 512 }, (_, index) => ({
    ...contentDescriptor,
    contentId: `content:${String(index).padStart(4, '0')}`,
    extension: undefined,
  }));
  const commandEntries = Array.from({ length: 513 }, (_, index) => ({
    ...commandCatalog.commands[0],
    commandId: `command:${String(index).padStart(4, '0')}`,
  }));
  const overAggregate = {
    ...snapshot,
    content: {
      ...availableContent,
      catalog: { ...contentCatalog, content: contentEntries },
    },
    commands: {
      ...availableCommands,
      catalog: { ...commandCatalog, commands: commandEntries },
    },
    extensions: {
      ...availableExtensions,
      catalog: { ...extensionCatalog, extensions: [] },
    },
  };
  assert.equal(
    safeParseAgentEnvironmentSnapshot(overAggregate).success,
    false,
  );
  assert.equal(
    contentEntries.length + commandEntries.length,
    AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH + 1,
  );

  const cyclic: Record<string, unknown> = { ...snapshot };
  cyclic.content = cyclic;
  assert.equal(safeParseAgentEnvironmentSnapshot(cyclic).success, false);

  let getterCalls = 0;
  const accessor = {
    ...snapshot,
    get revision() {
      getterCalls += 1;
      return snapshot.revision;
    },
  };
  assert.equal(safeParseAgentEnvironmentSnapshot(accessor).success, false);
  assert.equal(getterCalls, 0);
});

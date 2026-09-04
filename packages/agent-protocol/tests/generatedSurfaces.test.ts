// ------------------------------------------------------------------------------------------------
//                generatedSurfaces.test.ts - Export and JSON Schema parity coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  AGENT_PROTOCOL_JSON_SCHEMA_DIALECT,
  AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY,
} from '../src/jsonSchema/index.js';
import {
  safeParseAgentArtifactDescriptor,
  safeParseAgentCapabilities,
  safeParseAgentCollaborationControlInput,
  safeParseAgentCollaborationNode,
  safeParseAgentCollaborationSpawnInput,
  safeParseAgentConfigurationCatalog,
  safeParseAgentConfigurationSelectionInput,
  safeParseAgentEvent,
  safeParseAgentGeneratedResourceDescriptor,
  safeParseAgentIntegrationCatalog,
  safeParseAgentManagedContentCatalog,
  safeParseAgentOperationCatalog,
  safeParseAgentOperationInvocation,
  safeParseAgentOperationResult,
  safeParseAgentRequest,
  safeParseAgentRequestResolution,
  safeParseAgentSessionBinding,
  safeParseAgentSessionConfiguration,
  safeParseAgentSessionOpenInput,
  safeParseAgentTurnInputContent,
  safeParseAgentTurnRunInput,
} from '../src/public/index.js';
import { AGENT_PROTOCOL_TEXT_MAX_LENGTH } from '../src/foundation/types.js';
import {
  eventFixtureCorpus,
  protocolTimestamp,
  providerCapabilityFixtures,
} from './fixtures.js';

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly exports: Readonly<Record<string, unknown>> };

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  }
  return value;
}

test('package exports are explicit and complete', () => {
  assert.deepEqual(Object.keys(packageManifest.exports).sort(), [
    '.',
    './artifacts',
    './capabilities',
    './collaboration',
    './configuration',
    './events',
    './integrations',
    './json-schema',
    './managed-content',
    './operations',
    './package.json',
    './requests',
    './resources',
    './sessions',
    './turns',
    './zod',
  ]);
  assert.equal(
    Object.keys(packageManifest.exports).some((key) => key.includes('*')),
    false,
  );
});

test('JSON Schema artifacts have stable identity, hashes, and draft 2020-12 shape', () => {
  assert.equal(AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.length, 21);
  const identities = new Set<string>();
  for (const artifact of AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY) {
    assert.equal(artifact.dialect, AGENT_PROTOCOL_JSON_SCHEMA_DIALECT);
    assert.equal(artifact.schema.$schema, AGENT_PROTOCOL_JSON_SCHEMA_DIALECT);
    assert.equal(artifact.protocolVersion, 8);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      artifact.sha256,
      createHash('sha256')
        .update(`${JSON.stringify(stableJson(artifact.schema))}\n`)
        .digest('hex'),
    );
    const identity = `${artifact.contractId}:${artifact.direction}`;
    assert.equal(identities.has(identity), false);
    identities.add(identity);
  }
});

test('JSON Schemas compile and agree with the ordinary parsers on shared fixtures', () => {
  const leadingTraversalImage = {
    type: 'image',
    source: {
      type: 'local_file',
      path: '/../etc/passwd',
      mediaType: 'image/png',
      byteSize: 1,
      widthPixels: 1,
      heightPixels: 1,
      sha256: 'a'.repeat(64),
    },
  } as const;
  const fixtures = [
    {
      contractId: 'agenai.agent-protocol.turn-input-content',
      parser: safeParseAgentTurnInputContent,
      accepted: { parts: [{ type: 'text', text: 'Steer this turn' }] },
      rejected: { parts: [leadingTraversalImage] },
    },
    {
      contractId: 'agenai.agent-protocol.session-binding',
      parser: safeParseAgentSessionBinding,
      accepted: { conversationId: 'native:1' },
      rejected: { conversationId: '' },
    },
    {
      contractId: 'agenai.agent-protocol.session-configuration',
      parser: safeParseAgentSessionConfiguration,
      accepted: {
        kind: 'selected',
        revision: 'config:1',
        catalogRevision: 1,
        selections: [{
          key: 'model',
          fieldRevision: 1,
          value: { fieldKind: 'single_select', optionId: 'native-model' },
        }],
      },
      rejected: { kind: 'managed', revision: '' },
    },
    {
      contractId: 'agenai.agent-protocol.session-open-input',
      parser: safeParseAgentSessionOpenInput,
      accepted: {
        operation: 'create',
        sessionId: 'session:1',
        configuration: { kind: 'managed', revision: 'config:1' },
      },
      rejected: { operation: 'create', sessionId: '' },
    },
    {
      contractId: 'agenai.agent-protocol.turn-run-input',
      parser: safeParseAgentTurnRunInput,
      accepted: {
        turnId: 'turn:1',
        interactionMode: 'default',
        parts: [{ type: 'text', text: 'Hello' }],
      },
      rejected: {
        turnId: 'turn:1',
        interactionMode: 'default',
        parts: [leadingTraversalImage],
      },
    },
    {
      contractId: 'agenai.agent-protocol.request',
      parser: safeParseAgentRequest,
      accepted: {
        requestKind: 'approval',
        requestId: 'request:1',
        prompt: 'p'.repeat(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
        subject: {
          kind: 'other',
          title: 'Proceed',
          itemId: 'item:1',
        },
        options: [{
          optionId: 'approval:allow-once',
          label: 'Allow once',
          decision: 'approved',
          persistence: 'once',
          scope: { kind: 'exact_action' },
        }],
      },
      rejected: { requestKind: 'unknown' },
    },
    {
      contractId: 'agenai.agent-protocol.request-resolution',
      parser: safeParseAgentRequestResolution,
      accepted: {
        requestKind: 'approval',
        requestId: 'request:1',
        disposition: 'selected',
        optionId: 'approval:allow-once',
      },
      rejected: { requestKind: 'approval', requestId: 'request:1' },
    },
    {
      contractId: 'agenai.agent-protocol.operation-catalog',
      parser: safeParseAgentOperationCatalog,
      accepted: {
        revision: 1,
        operations: [{
          operationId: 'operation:session-reset',
          revision: 1,
          kind: 'session_control',
          title: 'Reset session',
          context: 'session',
          timing: 'idle_session',
          executionMode: 'immediate',
          fields: [],
          confirmation: 'required',
          idempotency: 'required',
          resultKind: 'none',
        }],
      },
      rejected: { revision: 0, operations: [] },
    },
    {
      contractId: 'agenai.agent-protocol.operation-invocation',
      parser: safeParseAgentOperationInvocation,
      accepted: {
        invocationId: 'operation-invocation:1',
        operationId: 'operation:session-reset',
        expectedRevision: 1,
        values: [],
      },
      rejected: {
        invocationId: 'operation-invocation:1',
        operationId: 'operation:session-reset',
        expectedRevision: 0,
        values: [],
      },
    },
    {
      contractId: 'agenai.agent-protocol.operation-result',
      parser: safeParseAgentOperationResult,
      accepted: {
        invocationId: 'operation-invocation:1',
        status: 'completed',
      },
      rejected: {
        invocationId: 'operation-invocation:1',
        status: 'unknown',
      },
    },
    {
      contractId: 'agenai.agent-protocol.managed-content-catalog',
      parser: safeParseAgentManagedContentCatalog,
      accepted: { revision: 1, entries: [] },
      rejected: { revision: 0, entries: [] },
    },
    {
      contractId: 'agenai.agent-protocol.configuration-catalog',
      parser: safeParseAgentConfigurationCatalog,
      accepted: {
        revision: 1,
        fields: [{
          key: 'auto_compact',
          revision: 1,
          label: 'Automatic compaction',
          scope: 'session',
          applicationTiming: 'immediate',
          mutable: true,
          fieldKind: 'boolean',
          currentValue: true,
        }],
      },
      rejected: { revision: 0, fields: [] },
    },
    {
      contractId: 'agenai.agent-protocol.configuration-selection',
      parser: safeParseAgentConfigurationSelectionInput,
      accepted: {
        key: 'auto_compact',
        expectedCatalogRevision: 1,
        expectedFieldRevision: 1,
        value: { fieldKind: 'boolean', value: false },
      },
      rejected: {
        key: 'auto_compact',
        expectedCatalogRevision: 0,
        expectedFieldRevision: 1,
        value: { fieldKind: 'boolean', value: false },
      },
    },
    {
      contractId: 'agenai.agent-protocol.integration-catalog',
      parser: safeParseAgentIntegrationCatalog,
      accepted: {
        revision: 1,
        observedAt: protocolTimestamp,
        integrations: [],
      },
      rejected: {
        revision: 0,
        observedAt: protocolTimestamp,
        integrations: [],
      },
    },
    {
      contractId: 'agenai.agent-protocol.collaboration-node',
      parser: safeParseAgentCollaborationNode,
      accepted: {
        collaborationId: 'collaboration:1',
        rootCollaborationId: 'collaboration:1',
        role: 'delegate',
        title: 'Implementation inspection',
        status: 'queued',
        objective: 'Inspect the implementation.',
        usage: { kind: 'unavailable' },
        createdAt: protocolTimestamp,
        updatedAt: protocolTimestamp,
      },
      rejected: {
        collaborationId: 'collaboration:1',
        rootCollaborationId: 'collaboration:1',
        role: 'unknown',
        title: 'Implementation inspection',
        status: 'queued',
        objective: 'Inspect the implementation.',
        usage: { kind: 'unavailable' },
        createdAt: protocolTimestamp,
        updatedAt: protocolTimestamp,
      },
    },
    {
      contractId: 'agenai.agent-protocol.collaboration-spawn',
      parser: safeParseAgentCollaborationSpawnInput,
      accepted: {
        collaborationId: 'collaboration:2',
        role: 'reviewer',
        title: 'Implementation review',
        objective: 'Review the implementation.',
        createdAt: protocolTimestamp,
      },
      rejected: {
        collaborationId: 'collaboration:2',
        role: 'reviewer',
        title: 'Implementation review',
        objective: '',
        createdAt: protocolTimestamp,
      },
    },
    {
      contractId: 'agenai.agent-protocol.collaboration-control',
      parser: safeParseAgentCollaborationControlInput,
      accepted: { action: 'close', collaborationId: 'collaboration:2' },
      rejected: { action: 'delete', collaborationId: 'collaboration:2' },
    },
    {
      contractId: 'agenai.agent-protocol.generated-resource',
      parser: safeParseAgentGeneratedResourceDescriptor,
      accepted: {
        resourceId: 'resource:1',
        kind: 'image',
        status: 'pending',
        displayName: 'Generated preview',
        producer: { kind: 'session', sessionId: 'session:1' },
        createdAt: protocolTimestamp,
      },
      rejected: {
        resourceId: 'resource:1',
        kind: 'image',
        status: 'pending',
        displayName: '',
        producer: { kind: 'session', sessionId: 'session:1' },
        createdAt: protocolTimestamp,
      },
    },
    {
      contractId: 'agenai.agent-protocol.capabilities',
      parser: safeParseAgentCapabilities,
      accepted: providerCapabilityFixtures.codex,
      rejected: { ...providerCapabilityFixtures.codex, protocolVersion: 3 },
    },
    {
      contractId: 'agenai.agent-protocol.artifact-descriptor',
      parser: safeParseAgentArtifactDescriptor,
      accepted: {
        artifactId: 'artifact:1',
        kind: 'report',
        displayName: 'report.md',
      },
      rejected: { artifactId: '', kind: 'report', displayName: 'report.md' },
    },
    {
      contractId: 'agenai.agent-protocol.event',
      parser: safeParseAgentEvent,
      accepted: eventFixtureCorpus[6],
      rejected: {
        protocolVersion: 3,
        sessionId: 'session:1',
        turnId: 'turn:1',
        occurredAt: protocolTimestamp,
        type: 'progress.updated',
        payload: {
          progressId: ' progress:1 ',
          kind: 'task',
          phase: 'started',
        },
      },
    },
  ] as const;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });

  for (const fixture of fixtures) {
    const artifact = AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.find(
      (candidate) => candidate.contractId === fixture.contractId,
    );
    assert.ok(artifact, fixture.contractId);
    const validate = ajv.compile(artifact.schema);
    assert.equal(validate(fixture.accepted), true, fixture.contractId);
    assert.equal(
      fixture.parser(fixture.accepted).success,
      true,
      fixture.contractId,
    );
    assert.equal(validate(fixture.rejected), false, fixture.contractId);
    assert.equal(
      fixture.parser(fixture.rejected).success,
      false,
      fixture.contractId,
    );
  }
});

test('turn JSON Schemas declare decoded inline-image byte-size parity', () => {
  const inlineImage = {
    type: 'image',
    source: {
      type: 'base64',
      data: 'YQ==',
      mediaType: 'image/png',
      byteSize: 2,
      widthPixels: 1,
      heightPixels: 1,
    },
  } as const;
  const cases = [
    {
      contractId: 'agenai.agent-protocol.turn-input-content',
      value: { parts: [inlineImage] },
      parser: safeParseAgentTurnInputContent,
    },
    {
      contractId: 'agenai.agent-protocol.turn-run-input',
      value: {
        turnId: 'turn:inline-image',
        interactionMode: 'default',
        parts: [inlineImage],
      },
      parser: safeParseAgentTurnRunInput,
    },
  ] as const;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });

  for (const testCase of cases) {
    const artifact = AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.find(
      (candidate) => candidate.contractId === testCase.contractId,
    );
    assert.ok(artifact, testCase.contractId);
    assert.deepEqual(artifact.parserInvariants, [
      'inline_image_decoded_byte_size',
      'serialized_bytes',
    ]);
    assert.equal(ajv.compile(artifact.schema)(testCase.value), true);
    assert.equal(testCase.parser(testCase.value).success, false);
  }
});

test('capability JSON Schema publishes collection uniqueness and residual parser invariants', () => {
  const artifact = AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.find(
    (candidate) =>
      candidate.contractId === 'agenai.agent-protocol.capabilities',
  );
  assert.ok(artifact);
  assert.deepEqual(artifact.parserInvariants, [
    'canonical_artifact_kinds',
    'canonical_approval_modes',
    'canonical_approval_scope_kinds',
    'canonical_authentication_flows',
    'canonical_collaboration_control_actions',
    'canonical_collaboration_roles',
    'canonical_configuration_field_kinds',
    'canonical_elicitation_field_kinds',
    'canonical_generated_resource_kinds',
    'canonical_image_input_media_types',
    'canonical_image_input_source_kinds',
    'canonical_integration_kinds',
    'canonical_managed_content_kinds',
    'canonical_operation_execution_modes',
    'canonical_operation_field_kinds',
    'canonical_operation_kinds',
    'canonical_context_compaction_triggers',
    'canonical_context_cumulative_usage_fields',
    'canonical_context_measurement_scopes',
    'image_input_pixels_bounded_by_dimensions',
    'image_input_total_bytes_admits_max_image',
    'image_input_total_bytes_bounded_by_count',
  ]);
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  }).compile(artifact.schema);
  const fixture = providerCapabilityFixtures.fixture;
  const duplicateCollections: readonly Readonly<{
    name: string;
    value: unknown;
  }>[] = [
    {
      name: 'artifact kinds',
      value: {
        ...fixture,
        output: { ...fixture.output, artifactKinds: ['diff', 'diff'] },
      },
    },
    {
      name: 'configuration field kinds',
      value: {
        ...fixture,
        configuration: {
          kind: 'selectable',
          fieldKinds: ['boolean', 'boolean'],
          maxFields: fixture.configuration.maxFields,
        },
      },
    },
    {
      name: 'authentication flows',
      value: {
        ...fixture,
        authentication: {
          kind: 'supported',
          flows: ['device_code', 'device_code'],
        },
      },
    },
  ];
  for (const duplicate of duplicateCollections) {
    assert.equal(validate(duplicate.value), false, duplicate.name);
    assert.equal(
      safeParseAgentCapabilities(duplicate.value).success,
      false,
      duplicate.name,
    );
  }

  assert.equal(fixture.input.images.kind, 'supported');
  const parserOnlyCases = [
    {
      ...fixture,
      configuration: {
        kind: 'selectable',
        fieldKinds: ['single_select', 'boolean'],
        maxFields: fixture.configuration.maxFields,
      },
    },
    {
      ...fixture,
      input: {
        ...fixture.input,
        images: {
          ...fixture.input.images,
          sourceKinds: ['base64', 'url', 'local_file'],
        },
      },
    },
    {
      ...fixture,
      input: {
        ...fixture.input,
        images: {
          ...fixture.input.images,
          mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
        },
      },
    },
    {
      ...fixture,
      input: {
        ...fixture.input,
        images: {
          ...fixture.input.images,
          maxBytesPerImage: 10,
          maxTotalBytes: 9,
        },
      },
    },
    {
      ...fixture,
      input: {
        ...fixture.input,
        images: {
          ...fixture.input.images,
          maxImages: 2,
          maxBytesPerImage: 10,
          maxTotalBytes: 100,
        },
      },
    },
    {
      ...fixture,
      input: {
        ...fixture.input,
        images: {
          ...fixture.input.images,
          maxWidthPixels: 10,
          maxHeightPixels: 10,
          maxPixelsPerImage: 101,
        },
      },
    },
  ];
  for (const parserOnly of parserOnlyCases) {
    assert.equal(validate(parserOnly), true);
    assert.equal(safeParseAgentCapabilities(parserOnly).success, false);
  }
});

test('event JSON Schema declares residual V8 semantic parser invariants', () => {
  const artifact = AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.find(
    (candidate) => candidate.contractId === 'agenai.agent-protocol.event',
  );
  assert.ok(artifact);
  assert.deepEqual(artifact.parserInvariants, [
    'event_state_correlation',
    'context_usage_bounds',
    'file_change_path_ordering_and_uniqueness',
    'item_detail_identification',
    'non_empty_provider_refs',
    'request_semantics',
    'serialized_bytes',
    'terminal_error_consistency',
  ]);

  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  }).compile(artifact.schema);
  const eventWithPayload = (payload: unknown) => ({
    protocolVersion: 8,
    type: 'item.completed',
    sessionId: 'session:1',
    turnId: 'turn:1',
    occurredAt: protocolTimestamp,
    payload,
  });
  const validCommand = eventWithPayload({
    itemId: 'item:command',
    itemKind: 'command_execution',
    status: 'completed',
    details: { commandSummary: 'Run contract tests', exitCode: 0 },
  });
  assert.equal(validate(validCommand), true);
  assert.equal(safeParseAgentEvent(validCommand).success, true);

  for (const structurallyInvalid of [
    eventWithPayload({
      itemId: 'item:command',
      itemKind: 'command_execution',
      status: 'completed',
      attributes: { commandSummary: 'Retired V2 shape' },
    }),
    eventWithPayload({
      itemId: 'item:assistant',
      itemKind: 'assistant_message',
      status: 'completed',
      details: { actionSummary: 'Cross-kind details' },
    }),
    eventWithPayload({
      itemId: 'item:review',
      itemKind: 'review',
      status: 'completed',
    }),
  ]) {
    assert.equal(validate(structurallyInvalid), false);
    assert.equal(safeParseAgentEvent(structurallyInvalid).success, false);
  }

  for (const parserOnlyInvalid of [
    eventWithPayload({
      itemId: 'item:command',
      itemKind: 'command_execution',
      status: 'completed',
      details: { truncated: true },
    }),
    eventWithPayload({
      itemId: 'item:file',
      itemKind: 'file_change',
      status: 'completed',
      details: {
        changes: [
          { path: 'z.ts', changeKind: 'modified' },
          { path: 'a.ts', changeKind: 'modified' },
        ],
      },
    }),
  ]) {
    assert.equal(validate(parserOnlyInvalid), true);
    assert.equal(safeParseAgentEvent(parserOnlyInvalid).success, false);
  }
});

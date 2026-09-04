// ------------------------------------------------------------------------------------------------
//                generate-json-schemas.mjs - Deterministic protocol JSON Schema generator
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod/v4';

import { AgentArtifactDescriptorSchema } from '../src/zod/artifacts.ts';
import { AgentCapabilitiesPortableSchema } from '../src/zod/capabilities.ts';
import {
  AgentCollaborationControlInputSchema,
  AgentCollaborationNodePortableSchema,
  AgentCollaborationSpawnInputSchema,
} from '../src/zod/collaboration.ts';
import {
  AgentConfigurationCatalogPortableSchema,
  AgentConfigurationSelectionInputSchema,
} from '../src/zod/configuration.ts';
import { AgentEventPortableSchema } from '../src/zod/events.ts';
import { AgentIntegrationCatalogPortableSchema } from '../src/zod/integrations.ts';
import { AgentManagedContentCatalogPortableSchema } from '../src/zod/managedContent.ts';
import {
  AgentOperationCatalogPortableSchema,
  AgentOperationInvocationPortableSchema,
  AgentOperationResultPortableSchema,
} from '../src/zod/operations.ts';
import { AGENT_PROTOCOL_VERSION } from '../src/foundation/types.ts';
import {
  AgentRequestPortableSchema,
  AgentRequestResolutionPortableSchema,
} from '../src/zod/requests.ts';
import { AgentGeneratedResourceDescriptorPortableSchema } from '../src/zod/resources.ts';
import {
  AgentSessionBindingSchema,
  AgentSessionConfigurationPortableSchema,
  AgentSessionOpenInputPortableSchema,
} from '../src/zod/sessions.ts';
import {
  AgentTurnInputContentSchema,
  AgentTurnRunInputPortableSchema,
} from '../src/zod/turns.ts';

// ------------------------------------------------------------------------------------------------
//                Curated Protocol Contract Matrix
// ------------------------------------------------------------------------------------------------

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(packageRoot, 'src/jsonSchema/generated.ts');
const checkOnly = process.argv.includes('--check');
const dialect = 'https://json-schema.org/draft/2020-12/schema';

const definitions = [
  {
    exportName: 'AGENT_SESSION_BINDING_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.session-binding',
    direction: 'output',
    schema: AgentSessionBindingSchema,
  },
  {
    exportName: 'AGENT_SESSION_CONFIGURATION_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.session-configuration',
    direction: 'input',
    schema: AgentSessionConfigurationPortableSchema,
    parserInvariants: ['configuration_entry_count', 'serialized_bytes'],
  },
  {
    exportName: 'AGENT_SESSION_OPEN_INPUT_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.session-open-input',
    direction: 'input',
    schema: AgentSessionOpenInputPortableSchema,
    parserInvariants: [
      'configuration_entry_count',
      'distinct_branch_session_ids',
      'serialized_bytes',
    ],
  },
  {
    exportName: 'AGENT_TURN_INPUT_CONTENT_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.turn-input-content',
    direction: 'input',
    schema: AgentTurnInputContentSchema,
    parserInvariants: ['inline_image_decoded_byte_size', 'serialized_bytes'],
  },
  {
    exportName: 'AGENT_TURN_RUN_INPUT_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.turn-run-input',
    direction: 'input',
    schema: AgentTurnRunInputPortableSchema,
    parserInvariants: ['inline_image_decoded_byte_size', 'serialized_bytes'],
  },
  {
    exportName: 'AGENT_REQUEST_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.request',
    direction: 'output',
    schema: AgentRequestPortableSchema,
    parserInvariants: [
      'unique_approval_option_ids',
      'unique_field_ids',
      'unique_choice_values',
    ],
  },
  {
    exportName: 'AGENT_REQUEST_RESOLUTION_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.request-resolution',
    direction: 'input',
    schema: AgentRequestResolutionPortableSchema,
    parserInvariants: [
      'request_resolution_correlation',
      'unique_choice_selections',
    ],
  },
  {
    exportName: 'AGENT_OPERATION_CATALOG_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.operation-catalog',
    direction: 'output',
    schema: AgentOperationCatalogPortableSchema,
    parserInvariants: [
      'canonical_operation_order',
      'unique_operation_field_ids',
      'unique_operation_ids',
      'unique_operation_option_ids',
    ],
  },
  {
    exportName: 'AGENT_OPERATION_INVOCATION_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.operation-invocation',
    direction: 'input',
    schema: AgentOperationInvocationPortableSchema,
    parserInvariants: [
      'operation_descriptor_correlation',
      'operation_revision_correlation',
      'unique_operation_values',
    ],
  },
  {
    exportName: 'AGENT_OPERATION_RESULT_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.operation-result',
    direction: 'output',
    schema: AgentOperationResultPortableSchema,
    parserInvariants: [
      'operation_invocation_correlation',
      'operation_result_error_consistency',
      'operation_result_kind_consistency',
      'unique_operation_result_references',
    ],
  },
  {
    exportName: 'AGENT_MANAGED_CONTENT_CATALOG_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.managed-content-catalog',
    direction: 'output',
    schema: AgentManagedContentCatalogPortableSchema,
    parserInvariants: [
      'canonical_managed_content_order',
      'unique_managed_content_ids',
    ],
  },
  {
    exportName: 'AGENT_CONFIGURATION_CATALOG_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.configuration-catalog',
    direction: 'output',
    schema: AgentConfigurationCatalogPortableSchema,
    parserInvariants: [
      'canonical_configuration_field_order',
      'configuration_current_value_bounds',
      'unique_configuration_field_keys',
      'unique_configuration_option_ids',
    ],
  },
  {
    exportName: 'AGENT_CONFIGURATION_SELECTION_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.configuration-selection',
    direction: 'input',
    schema: AgentConfigurationSelectionInputSchema,
    parserInvariants: [
      'configuration_catalog_correlation',
      'configuration_field_correlation',
      'configuration_selection_bounds',
    ],
  },
  {
    exportName: 'AGENT_INTEGRATION_CATALOG_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.integration-catalog',
    direction: 'output',
    schema: AgentIntegrationCatalogPortableSchema,
    parserInvariants: [
      'canonical_integration_order',
      'unique_integration_ids',
      'unique_integration_server_ids',
      'unique_integration_tool_ids',
      'unique_integration_resource_ids',
    ],
  },
  {
    exportName: 'AGENT_COLLABORATION_NODE_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.collaboration-node',
    direction: 'output',
    schema: AgentCollaborationNodePortableSchema,
    parserInvariants: [
      'collaboration_parent_consistency',
      'collaboration_result_consistency',
      'collaboration_terminal_error_consistency',
      'collaboration_terminal_timestamp_consistency',
    ],
  },
  {
    exportName: 'AGENT_COLLABORATION_SPAWN_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.collaboration-spawn',
    direction: 'input',
    schema: AgentCollaborationSpawnInputSchema,
    parserInvariants: ['collaboration_parent_consistency'],
  },
  {
    exportName: 'AGENT_COLLABORATION_CONTROL_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.collaboration-control',
    direction: 'input',
    schema: AgentCollaborationControlInputSchema,
    parserInvariants: ['serialized_turn_input_bytes'],
  },
  {
    exportName: 'AGENT_GENERATED_RESOURCE_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.generated-resource',
    direction: 'output',
    schema: AgentGeneratedResourceDescriptorPortableSchema,
    parserInvariants: [
      'generated_resource_artifact_consistency',
      'generated_resource_digest_consistency',
      'generated_resource_error_consistency',
      'generated_resource_media_consistency',
    ],
  },
  {
    exportName: 'AGENT_CAPABILITIES_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.capabilities',
    direction: 'output',
    schema: AgentCapabilitiesPortableSchema,
    parserInvariants: [
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
    ],
  },
  {
    exportName: 'AGENT_ARTIFACT_DESCRIPTOR_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.artifact-descriptor',
    direction: 'output',
    schema: AgentArtifactDescriptorSchema,
  },
  {
    exportName: 'AGENT_EVENT_JSON_SCHEMA',
    contractId: 'agenai.agent-protocol.event',
    direction: 'output',
    schema: AgentEventPortableSchema,
    parserInvariants: [
      'event_state_correlation',
      'context_usage_bounds',
      'file_change_path_ordering_and_uniqueness',
      'item_detail_identification',
      'non_empty_provider_refs',
      'request_semantics',
      'serialized_bytes',
      'terminal_error_consistency',
    ],
  },
];

function stableJson(value) {
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

function artifact(definition) {
  const schema = stableJson({
    $id: `urn:${definition.contractId}:v${AGENT_PROTOCOL_VERSION}:${definition.direction}`,
    ...z.toJSONSchema(definition.schema, {
      target: 'draft-2020-12',
      io: definition.direction,
      unrepresentable: 'throw',
      cycles: 'ref',
      reused: 'ref',
    }),
  });
  const serialized = `${JSON.stringify(schema)}\n`;
  return {
    contractId: definition.contractId,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    direction: definition.direction,
    dialect,
    parserInvariants: definition.parserInvariants ?? [],
    sha256: createHash('sha256').update(serialized).digest('hex'),
    schema,
  };
}

const artifacts = definitions.map((definition) => ({
  exportName: definition.exportName,
  artifact: artifact(definition),
}));

const source = `// ------------------------------------------------------------------------------------------------
//                generated.ts - Curated deterministic agent protocol JSON Schemas
// ------------------------------------------------------------------------------------------------

// This file is generated by scripts/generate-json-schemas.mjs. Do not edit by hand.

export const AGENT_PROTOCOL_JSON_SCHEMA_DIALECT =
  '${dialect}' as const;

export type AgentProtocolJsonSchemaDirection = 'input' | 'output';

export interface AgentProtocolJsonSchemaArtifact {
  readonly contractId: string;
  readonly protocolVersion: ${AGENT_PROTOCOL_VERSION};
  readonly direction: AgentProtocolJsonSchemaDirection;
  readonly dialect: typeof AGENT_PROTOCOL_JSON_SCHEMA_DIALECT;
  readonly parserInvariants: readonly string[];
  readonly sha256: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

${artifacts
  .map(
    ({ artifact: value, exportName }) =>
      `export const ${exportName} = ${JSON.stringify(value, null, 2)} as const satisfies AgentProtocolJsonSchemaArtifact;`,
  )
  .join('\n\n')}

export const AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY = [
${artifacts.map(({ exportName }) => `  ${exportName},`).join('\n')}
] as const satisfies readonly AgentProtocolJsonSchemaArtifact[];
`;

let existing = null;
try {
  existing = readFileSync(outputPath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (existing !== source) {
  if (checkOnly)
    throw new Error('Generated agent protocol JSON Schemas are stale.');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, source);
}

process.stdout.write(
  `${checkOnly ? 'Checked' : 'Generated'} agent protocol JSON Schemas.\n`,
);

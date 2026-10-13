import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  parseAgentConfigurationCatalog, parseAgentConfigurationRevisionId, parseAgentConfigurationSelectionFor,
  type AgentConfigurationCatalog, type AgentConfigurationSelectionInput, type AgentInstanceId,
  type AgentProviderKey, type AgentSessionConfiguration, type AgentSingleSelectConfigurationField,
} from '@agen-ai/agent-protocol';
import { parseDelegationTargetCatalog, type DelegationTarget } from '@agen-ai/agent-orchestration';
import type { AgentProviderSession } from '@agen-ai/agent-runtime';
import { NativeQualificationError, type NativeGrokMapping } from './host-contracts.js';

/** These revisions and canonical choices are observations, never a native model-name translation. */
export interface GrokConfigurationSelection {
  readonly modelId: string;
  readonly reasoning: 'low';
  readonly initial: AgentConfigurationCatalog;
  readonly afterModel: AgentConfigurationCatalog;
  readonly afterReasoning: AgentConfigurationCatalog;
  readonly model: AgentConfigurationSelectionInput;
  readonly reasoningSelection: AgentConfigurationSelectionInput;
}

function selectable(session: AgentProviderSession) {
  if (session.configuration.kind !== 'selectable') throw new NativeQualificationError('configuration_unknown');
  return session.configuration;
}

function select(catalog: AgentConfigurationCatalog, label: string, optionLabel: string): AgentConfigurationSelectionInput {
  const fields = catalog.fields.filter((field) => field.label === label);
  const field = fields[0];
  if (fields.length !== 1 || !field || field.fieldKind !== 'single_select' || !field.mutable
    || field.scope !== 'session' || field.applicationTiming !== 'immediate') throw new NativeQualificationError('configuration_unknown');
  const options = field.options.filter((option) => option.label === optionLabel);
  if (options.length !== 1) throw new NativeQualificationError('configuration_unknown');
  return parseAgentConfigurationSelectionFor(catalog, { key: field.key, expectedCatalogRevision: catalog.revision,
    expectedFieldRevision: field.revision, value: { fieldKind: 'single_select', optionId: options[0]!.optionId } });
}

function sameCatalog(actual: AgentConfigurationCatalog, expected: AgentConfigurationCatalog): void {
  if (!isDeepStrictEqual(parseAgentConfigurationCatalog(actual), parseAgentConfigurationCatalog(expected))) {
    throw new NativeQualificationError('configuration_unknown');
  }
}

function selectedField(catalog: AgentConfigurationCatalog, selection: AgentConfigurationSelectionInput): AgentSingleSelectConfigurationField {
  const field = catalog.fields.find((candidate) => candidate.key === selection.key);
  if (!field || field.fieldKind !== 'single_select' || selection.value.fieldKind !== 'single_select'
    || field.currentValue !== selection.value.optionId || field.scope !== 'session'
    || field.applicationTiming !== 'immediate' || !field.mutable) throw new NativeQualificationError('configuration_unknown');
  return field;
}

export async function discoverGrokConfiguration(input: {
  readonly session: AgentProviderSession;
  readonly choice: Readonly<{ modelId: string; reasoning: 'low' }>;
  readonly signal: AbortSignal;
  readonly onConfigurationStart: () => void;
}): Promise<GrokConfigurationSelection> {
  if (input.choice.reasoning !== 'low' || !input.choice.modelId || input.choice.modelId.length > 200) {
    throw new NativeQualificationError('configuration_unknown');
  }
  const control = selectable(input.session);
  const initial = await control.listConfiguration({ signal: input.signal });
  const model = select(initial, 'Model', input.choice.modelId);
  const appliedModel = await control.applyConfigurationSelection({ selection: model, signal: input.signal,
    onProviderExecutionStarted: input.onConfigurationStart });
  if (appliedModel.status !== 'completed') throw new NativeQualificationError('configuration_unknown');
  const afterModel = await control.listConfiguration({ signal: input.signal });
  selectedField(afterModel, model);
  const reasoningSelection = select(afterModel, 'Reasoning Effort', 'Low');
  const appliedReasoning = await control.applyConfigurationSelection({ selection: reasoningSelection, signal: input.signal,
    onProviderExecutionStarted: input.onConfigurationStart });
  if (appliedReasoning.status !== 'completed') throw new NativeQualificationError('configuration_unknown');
  const afterReasoning = await control.listConfiguration({ signal: input.signal });
  selectedField(afterReasoning, model);
  selectedField(afterReasoning, reasoningSelection);
  return { modelId: input.choice.modelId, reasoning: 'low', initial, afterModel, afterReasoning, model, reasoningSelection };
}

export function validateGrokSelection(selection: GrokConfigurationSelection): void {
  if (selection.reasoning !== 'low') throw new NativeQualificationError('configuration_unknown');
  const model = select(selection.initial, 'Model', selection.modelId);
  const reasoning = select(selection.afterModel, 'Reasoning Effort', 'Low');
  if (!isDeepStrictEqual(model, selection.model) || !isDeepStrictEqual(reasoning, selection.reasoningSelection)) {
    throw new NativeQualificationError('configuration_unknown');
  }
  selectedField(selection.afterModel, model);
  selectedField(selection.afterReasoning, model);
  selectedField(selection.afterReasoning, reasoning);
}

export function grokOpeningConfiguration(selection: GrokConfigurationSelection): AgentSessionConfiguration {
  validateGrokSelection(selection);
  return { kind: 'selected', revision: parseAgentConfigurationRevisionId('native-grok:selected-model'),
    catalogRevision: selection.model.expectedCatalogRevision,
    selections: [{ key: selection.model.key, fieldRevision: selection.model.expectedFieldRevision, value: selection.model.value }] };
}

export const grokBootstrapConfiguration: AgentSessionConfiguration = Object.freeze({ kind: 'selected',
  revision: parseAgentConfigurationRevisionId('native-grok:discovery-bootstrap'), catalogRevision: 1, selections: [] });

/** Opening already acknowledged the model; this separately observed public call selects low reasoning. */
export async function configureGrokSession(input: {
  readonly session: AgentProviderSession;
  readonly selection: GrokConfigurationSelection;
  readonly signal: AbortSignal;
  readonly onConfigurationStart: () => void;
}): Promise<AgentConfigurationCatalog> {
  validateGrokSelection(input.selection);
  const control = selectable(input.session);
  sameCatalog(await control.listConfiguration({ signal: input.signal }), input.selection.afterModel);
  const result = await control.applyConfigurationSelection({ selection: input.selection.reasoningSelection,
    signal: input.signal, onProviderExecutionStarted: input.onConfigurationStart });
  if (result.status !== 'completed') throw new NativeQualificationError('configuration_unknown');
  const observed = await control.listConfiguration({ signal: input.signal });
  verifyGrokConfiguration(observed, input.selection);
  return observed;
}

export function verifyGrokConfiguration(catalog: AgentConfigurationCatalog, selection: GrokConfigurationSelection): void {
  validateGrokSelection(selection);
  sameCatalog(catalog, selection.afterReasoning);
  selectedField(catalog, selection.model);
  selectedField(catalog, selection.reasoningSelection);
}

export function createGrokTarget(input: {
  readonly instanceId: AgentInstanceId;
  readonly providerKey: AgentProviderKey;
  readonly selection: GrokConfigurationSelection;
  readonly mapping: NativeGrokMapping;
}): DelegationTarget {
  validateGrokSelection(input.selection);
  if (input.mapping.modelId !== input.selection.modelId || input.mapping.reasoning !== 'low'
    || input.mapping.executionMode !== 'standard' || !input.mapping.proofDigest) {
    throw new NativeQualificationError('standard_mapping_unverified');
  }
  const options = [input.selection.model, input.selection.reasoningSelection].map((selection) => {
    if (selection.value.fieldKind !== 'single_select') throw new NativeQualificationError('configuration_unknown');
    return { key: selection.key, optionId: selection.value.optionId };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return parseDelegationTargetCatalog({ catalogId: 'native-grok-catalog', revision: 1, targets: [{
    reference: { catalogId: 'native-grok-catalog', catalogRevision: 1, targetId: 'grok-standard-low', targetRevision: 1,
      sourceId: input.mapping.mappingId, sourceRevision: input.mapping.mappingRevision },
    instanceId: input.instanceId, providerKey: input.providerKey, modelId: input.mapping.modelId,
    label: `${input.mapping.modelId}, standard, low`, options,
    reasoning: { kind: 'certified', value: 'low' }, executionMode: { kind: 'certified', value: 'standard' },
    certification: { mappingId: input.mapping.mappingId, mappingRevision: input.mapping.mappingRevision },
    availability: { kind: 'available' }, limitations: ['Exact pinned native candidate and observed API-key route only; no dollar cap.'],
    application: { configuration: grokOpeningConfiguration(input.selection), beforeFirstTurn: [input.selection.reasoningSelection] },
  }] }).targets[0]!;
}

export const NATIVE_CHILD_PROMPT = 'Choose a new harmless token containing exactly 12 uppercase ASCII letters. Do not use any tools, files, environment values, credentials or outside information. Return only a JSON object with the single key "token" and your chosen token as its string value.';
export const NATIVE_CANCELLATION_PROMPT = 'Without using tools, files or outside information, compose a detailed original explanation of how a binary search tree works. This is a host cancellation qualification task; do not delegate.';
export const NATIVE_ORDINARY_PROMPT = 'Without using tools, files, environment values or outside information, return exactly {"ready":true} and no other text.';

export function parseNativeToken(text: string): string {
  const match = /^\s*\{\s*"token"\s*:\s*"([A-Z]{12})"\s*\}\s*$/u.exec(text);
  if (!match) throw new NativeQualificationError('child_result_unavailable');
  return match[1]!;
}

export function assertNativeOrdinaryResult(text: string): void {
  if (!/^\s*\{\s*"ready"\s*:\s*true\s*\}\s*$/u.test(text)) throw new NativeQualificationError('native_protocol_incompatible');
}

export function nativeResultDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

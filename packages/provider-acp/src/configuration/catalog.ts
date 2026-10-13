import { createHash } from 'node:crypto';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import {
  AGENT_CONFIGURATION_FIELDS_MAX_LENGTH,
  AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH,
  parseAgentConfigurationCatalog,
  parseAgentConfigurationSelectionFor,
  type AgentBooleanConfigurationField,
  type AgentCapabilities,
  type AgentConfigurationCatalog,
  type AgentConfigurationSelectionInput,
  type AgentSingleSelectConfigurationField,
} from '@agen-ai/agent-protocol';

import { AcpConfigurationError, invalidConfigurationCatalog } from './errors.js';

type ConfigurationField = Omit<AgentBooleanConfigurationField, 'revision'> | Omit<AgentSingleSelectConfigurationField, 'revision'>;

interface AcpConfigurationBinding {
  readonly field: ConfigurationField;
  readonly method: 'session/set_config_option' | 'session/set_mode';
  readonly nativeId: string;
  readonly options: ReadonlyMap<string, string>;
}

function object(value: AcpJsonValue | undefined): AcpJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidConfigurationCatalog();
  return value;
}

function string(value: AcpJsonValue | undefined): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) return invalidConfigurationCatalog();
  return value;
}

function optionalDescription(value: AcpJsonValue | undefined): { readonly description?: string } {
  return value === null || value === undefined || value === '' ? {} : { description: string(value) };
}

function id(kind: string, ...nativeIds: readonly string[]): string {
  return `acp:${kind}:${createHash('sha256').update(JSON.stringify(nativeIds)).digest('hex')}`;
}

function compareKeys(left: { readonly key: string }, right: { readonly key: string }): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function selectBinding(input: {
  readonly nativeId: string;
  readonly name: string;
  readonly description?: string;
  readonly currentValue: string;
  readonly values: readonly AcpJsonObject[];
  readonly method: AcpConfigurationBinding['method'];
}): AcpConfigurationBinding {
  if (!input.values.length || input.values.length > AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH) return invalidConfigurationCatalog();
  const options = new Map<string, string>();
  const nativeValues = new Set<string>();
  const publicOptions = input.values.map((option) => {
    const nativeValue = string(input.method === 'session/set_mode' ? option.id : option.value);
    if (nativeValues.has(nativeValue)) return invalidConfigurationCatalog();
    nativeValues.add(nativeValue);
    const optionId = id('value', input.method, input.nativeId, nativeValue);
    options.set(optionId, nativeValue);
    return { optionId, label: string(option.name), ...optionalDescription(option.description) };
  }).sort((left, right) => compareKeys({ key: left.optionId }, { key: right.optionId }));
  if (!nativeValues.has(input.currentValue)) return invalidConfigurationCatalog();
  return {
    field: {
      key: id('field', input.method, input.nativeId),
      fieldKind: 'single_select',
      label: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      scope: 'session',
      applicationTiming: 'immediate',
      mutable: true,
      currentValue: id('value', input.method, input.nativeId, input.currentValue),
      options: publicOptions,
    },
    method: input.method,
    nativeId: input.nativeId,
    options,
  };
}

function selectValues(value: AcpJsonValue | undefined): readonly AcpJsonObject[] {
  if (!Array.isArray(value) || value.length > AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH) return invalidConfigurationCatalog();
  const values: AcpJsonObject[] = [];
  const groupIds = new Set<string>();
  const grouped = value.length > 0 && Object.hasOwn(object(value[0]), 'group');
  for (const item of value) {
    const option = object(item);
    if (Object.hasOwn(option, 'group') !== grouped) return invalidConfigurationCatalog();
    if (grouped) {
      const groupId = string(option.group);
      if (groupIds.has(groupId)) return invalidConfigurationCatalog();
      groupIds.add(groupId);
      const groupName = string(option.name);
      if (!Array.isArray(option.options)) return invalidConfigurationCatalog();
      for (const member of option.options) {
        if (values.length >= AGENT_CONFIGURATION_OPTIONS_MAX_LENGTH) return invalidConfigurationCatalog();
        const groupedOption = object(member);
        values.push({ ...groupedOption, name: `${groupName}: ${string(groupedOption.name)}` });
      }
    } else values.push(option);
  }
  return values;
}

function mapAcpConfigOptions(value: AcpJsonValue | undefined): readonly AcpConfigurationBinding[] {
  if (!Array.isArray(value) || value.length > AGENT_CONFIGURATION_FIELDS_MAX_LENGTH) return invalidConfigurationCatalog();
  const nativeIds = new Set<string>();
  return value.map((item): AcpConfigurationBinding => {
    const option = object(item);
    const nativeId = string(option.id);
    if (nativeIds.has(nativeId)) return invalidConfigurationCatalog();
    nativeIds.add(nativeId);
    const common = {
      key: id('field', 'session/set_config_option', nativeId),
      label: string(option.name),
      ...optionalDescription(option.description),
      scope: 'session' as const,
      applicationTiming: 'immediate' as const,
      mutable: true,
    };
    if (option.type === 'boolean' && typeof option.currentValue === 'boolean') {
      return {
        field: { ...common, fieldKind: 'boolean', currentValue: option.currentValue },
        method: 'session/set_config_option', nativeId, options: new Map(),
      };
    }
    if (option.type !== 'select') return invalidConfigurationCatalog();
    return selectBinding({
      nativeId,
      name: common.label,
      ...optionalDescription(option.description),
      currentValue: string(option.currentValue),
      values: selectValues(option.options),
      method: 'session/set_config_option',
    });
  }).sort((left, right) => compareKeys(left.field, right.field));
}

function mapAcpModes(value: AcpJsonValue | undefined): readonly AcpConfigurationBinding[] {
  const modes = object(value);
  if (!Array.isArray(modes.availableModes)) return invalidConfigurationCatalog();
  return [selectBinding({
    nativeId: 'mode', name: 'Session mode', currentValue: string(modes.currentModeId),
    values: modes.availableModes.map(object), method: 'session/set_mode',
  })];
}

export class AcpConfigurationCatalogState {
  private snapshot: AgentConfigurationCatalog | undefined;
  private bindings = new Map<string, AcpConfigurationBinding>();
  private fingerprint: string | undefined;
  private failure: Error | undefined;
  private source: 'config' | 'modes' | undefined;

  constructor(
    private readonly maxSnapshotBytes: number,
    private readonly capability: Extract<AgentCapabilities['configuration'], { readonly kind: 'selectable' }>,
  ) {}

  private replace(source: 'config' | 'modes', native: AcpJsonValue | undefined): void {
    this.assertValid();
    try {
      if (native === undefined || Buffer.byteLength(JSON.stringify(native), 'utf8') > this.maxSnapshotBytes) return invalidConfigurationCatalog();
      const bindings = source === 'config' ? mapAcpConfigOptions(native) : mapAcpModes(native);
      if (bindings.length > this.capability.maxFields || bindings.some((binding) => !this.capability.fieldKinds.includes(binding.field.fieldKind))) return invalidConfigurationCatalog();
      const fingerprint = JSON.stringify(bindings.map((binding) => binding.field));
      if (this.source === source && this.fingerprint === fingerprint) return;
      const revision = (this.snapshot?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) return invalidConfigurationCatalog();
      const fields = bindings.map((binding) => {
        const previous = this.bindings.get(binding.field.key);
        const previousField = this.snapshot?.fields.find((field) => field.key === binding.field.key);
        const fieldRevision = previous && previousField && JSON.stringify(previous.field) === JSON.stringify(binding.field)
          ? previousField.revision : revision;
        return { ...binding.field, revision: fieldRevision };
      });
      const snapshot = parseAgentConfigurationCatalog({ revision, fields });
      this.bindings = new Map(bindings.map((binding) => [binding.field.key, binding]));
      this.snapshot = snapshot;
      this.source = source;
      this.fingerprint = fingerprint;
    } catch (cause) {
      const error = cause instanceof AcpConfigurationError ? cause : new AcpConfigurationError(
        'acp_configuration_catalog_invalid', 'ACP configuration cannot be represented faithfully within the declared bounds.', { cause },
      );
      this.failure = error;
      throw error;
    }
  }

  assertValid(): void {
    if (this.failure) throw this.failure;
  }

  retire(error: Error): void { this.failure ??= error; }

  observeSetup(response: AcpJsonObject): void {
    if (response.configOptions !== null && response.configOptions !== undefined) this.replace('config', response.configOptions);
    else if (this.source !== 'config' && response.modes !== null && response.modes !== undefined) this.replace('modes', response.modes);
  }

  observeUpdate(update: AcpJsonObject): boolean {
    if (update.sessionUpdate === 'config_option_update') { this.replace('config', update.configOptions); return true; }
    if (update.sessionUpdate === 'current_mode_update') {
      if (this.source === 'modes') this.observeMode(string(update.currentModeId));
      return true;
    }
    return false;
  }

  observeConfigResponse(response: AcpJsonObject): void {
    this.replace('config', response.configOptions);
  }

  observeMode(nativeMode: string): void {
    this.assertValid();
    const binding = [...this.bindings.values()].find((candidate) => candidate.method === 'session/set_mode');
    if (this.source !== 'modes' || !binding || binding.field.fieldKind !== 'single_select') return invalidConfigurationCatalog();
    const availableModes = binding.field.options.map((option) => ({
      id: binding.options.get(option.optionId)!, name: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    this.replace('modes', { currentModeId: nativeMode, availableModes });
  }

  list(): AgentConfigurationCatalog {
    this.assertValid();
    if (!this.snapshot) throw new AcpConfigurationError('acp_configuration_catalog_unknown', 'The ACP peer has not supplied a configuration catalog.');
    return this.snapshot;
  }

  resolve(input: AgentConfigurationSelectionInput): { readonly binding: AcpConfigurationBinding; readonly selection: AgentConfigurationSelectionInput } {
    try {
      const selection = parseAgentConfigurationSelectionFor(this.list(), input);
      const binding = this.bindings.get(selection.key);
      if (!binding) return invalidConfigurationCatalog();
      return { binding, selection };
    } catch (cause) {
      if (cause instanceof AcpConfigurationError) throw cause;
      throw new AcpConfigurationError('acp_configuration_selection_invalid', 'The configuration selection is stale or outside the offered catalog.', { cause });
    }
  }
}

import type { AgentApprovalCapability } from '@agen-ai/agent-protocol';
import type { AcpPermissionMappingSelection, AcpPermissionMenuSignature, AcpPermissionOptionSignature } from './contracts.js';

function selectionObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError('ACP permission mapping selections must contain only their declared fields.');
  }
  return value as Record<string, unknown>;
}

function canonicalText(value: unknown, maximum: number, identity = false): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
    || (identity ? /[\p{Cc}\p{Cf}]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value)) {
    throw new TypeError('ACP permission mapping identities must be bounded canonical strings.');
  }
  return value;
}

function optionKind(value: unknown): AcpPermissionOptionSignature['kind'] {
  switch (value) {
    case 'allow_once': case 'reject_once': case 'allow_always': case 'reject_always': return value;
    default: throw new TypeError('ACP permission option kind is invalid.');
  }
}

function toolKind(value: unknown): AcpPermissionMenuSignature['toolKind'] {
  switch (value) {
    case 'read': case 'edit': case 'delete': case 'move': case 'search':
    case 'execute': case 'think': case 'fetch': case 'switch_mode': case 'other': return value;
    default: throw new TypeError('ACP permission tool kind is invalid.');
  }
}

function boundedNonempty<Value>(value: unknown, parse: (item: unknown) => Value): readonly [Value, ...Value[]] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new TypeError('ACP permission declarations require between one and sixteen entries.');
  }
  const first = parse(value[0]);
  return Object.freeze([first, ...Array.from(value.slice(1), parse)]);
}

function menuSignature(value: unknown): AcpPermissionMenuSignature {
  const menu = selectionObject(value, ['toolKind', 'options']);
  const ids = new Set<string>();
  const options = boundedNonempty(menu.options, (entry) => {
    const option = selectionObject(entry, ['optionId', 'kind']);
    const optionId = canonicalText(option.optionId, 256);
    if (ids.has(optionId)) throw new TypeError('ACP declared permission option identities must be unique.');
    ids.add(optionId);
    return Object.freeze({ optionId, kind: optionKind(option.kind) });
  });
  return Object.freeze({ toolKind: toolKind(menu.toolKind), options });
}

export function resolveAcpPermissionMapping(value: unknown): AcpPermissionMappingSelection {
  if (value === undefined) return Object.freeze({ mapping: 'once-only-v1' });
  const selection = selectionObject(value, ['mapping', 'agentInfo', 'menus']);
  if (selection.mapping === 'once-only-v1' || selection.mapping === 'grok-build-1.0.50-edit-remembrance-v1') {
    selectionObject(value, ['mapping']);
    return Object.freeze({ mapping: selection.mapping });
  }
  if (selection.mapping !== 'declared-complete-consequences-v1') throw new TypeError('ACP permission mapping is invalid.');
  const info = selectionObject(selection.agentInfo, ['name', 'version']);
  const agentInfo = Object.freeze({ name: canonicalText(info.name, 256, true), version: canonicalText(info.version, 160, true) });
  const signatures = new Set<string>();
  const menus = boundedNonempty(selection.menus, (entry) => {
    const menu = menuSignature(entry);
    const signature = JSON.stringify(menu);
    if (signatures.has(signature)) throw new TypeError('ACP declared permission menus must be unique.');
    signatures.add(signature);
    return menu;
  });
  return Object.freeze({ mapping: selection.mapping, agentInfo, menus });
}

export function acpPermissionCapability(selection: AcpPermissionMappingSelection): AgentApprovalCapability {
  const once = { persistence: 'once', scopeKinds: ['exact_action'] } as const;
  if (selection.mapping === 'once-only-v1') {
    return { kind: 'supported', modes: [once], providerManagedRemembrance: false };
  }
  if (selection.mapping === 'grok-build-1.0.50-edit-remembrance-v1') {
    return { kind: 'supported', modes: [once], providerManagedRemembrance: true };
  }
  const options = selection.menus.flatMap((menu) => menu.options);
  const precise = options.some((option) => option.kind === 'allow_once' || option.kind === 'reject_once');
  const remembered = options.some((option) => option.kind === 'allow_always' || option.kind === 'reject_always');
  return remembered ? { kind: 'supported', modes: precise ? [once] : [], providerManagedRemembrance: true }
    : { kind: 'supported', modes: [once], providerManagedRemembrance: false };
}

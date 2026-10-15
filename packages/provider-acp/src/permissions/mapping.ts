import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { parseAgentApprovalOptionId, type AgentApprovalOption } from '@agen-ai/agent-protocol';
import { AcpProviderSessionError } from '../session/errors.js';
import { displayText, nativeObject, nativeString } from '../session/native.js';
import type { AcpPermissionMappingSelection, AcpPermissionMenuSignature, AcpPermissionOptionSignature } from './contracts.js';

interface NativePermissionOption extends AcpPermissionOptionSignature {
  readonly source: AcpJsonObject;
}

export interface MappedPermissionOptions {
  readonly options: readonly AgentApprovalOption[];
  readonly nativeOptions: ReadonlyMap<string, string>;
  readonly warning?: Readonly<{ code: string; message: string }>;
}

const GROK_EDIT_MENU: AcpPermissionMenuSignature = {
  toolKind: 'edit',
  options: [
    { optionId: 'allow-edits-session', kind: 'allow_always' },
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ],
};

function unsupportedConsequence(): never {
  throw new AcpProviderSessionError('acp_permission_consequence_unsupported', 'The selected ACP permission mapping does not represent this complete native menu.');
}

function readNativeOptions(params: AcpJsonObject): readonly NativePermissionOption[] {
  if (!Array.isArray(params.options) || params.options.length < 1 || params.options.length > 16) {
    throw new AcpProviderSessionError('acp_permission_options_invalid', 'ACP permission menus require between one and sixteen options.');
  }
  const ids = new Set<string>();
  return params.options.map((value) => {
    const option = nativeObject(value, 'permission option');
    const optionId = nativeString(option.optionId, 'permission option identity');
    if (!optionId || optionId.length > 256 || optionId !== optionId.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(optionId)) {
      throw new AcpProviderSessionError('acp_permission_options_invalid', 'ACP permission option identities must be bounded canonical strings.');
    }
    if (ids.has(optionId)) throw new AcpProviderSessionError('acp_permission_option_duplicate', 'ACP repeated a permission option identity.');
    ids.add(optionId);
    const kind = option.kind;
    if (kind !== 'allow_once' && kind !== 'reject_once' && kind !== 'allow_always' && kind !== 'reject_always') {
      throw new AcpProviderSessionError('acp_permission_options_invalid', 'ACP permission option kind is unsupported.');
    }
    return { optionId, kind, source: option };
  });
}

function matchesMenu(menu: AcpPermissionMenuSignature, tool: AcpJsonObject, options: readonly NativePermissionOption[]): boolean {
  return menu.toolKind === tool.kind && menu.options.length === options.length
    && menu.options.every((option, index) => option.optionId === options[index]?.optionId && option.kind === options[index]?.kind);
}

function assertCompleteChoiceFields(params: AcpJsonObject, options: readonly NativePermissionOption[]): void {
  if (Object.keys(params).some((key) => !['sessionId', 'toolCall', 'options'].includes(key))
    || options.some((option) => Object.keys(option.source).some((key) => !['optionId', 'name', 'kind'].includes(key)))) {
    unsupportedConsequence();
  }
}

function qualifiedGrokEdit(tool: AcpJsonObject, options: readonly NativePermissionOption[]): boolean {
  const input = tool.rawInput;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  return matchesMenu(GROK_EDIT_MENU, tool, options)
    && Object.keys(input).length === 5
    && typeof input.file_path === 'string' && input.file_path.length > 0
    && typeof input.old_string === 'string' && typeof input.new_string === 'string'
    && input.variant === 'SearchReplace' && input.replace_all === false;
}

export function mapAcpPermissionOptions(selection: AcpPermissionMappingSelection, params: AcpJsonObject): MappedPermissionOptions {
  const native = readNativeOptions(params);
  const tool = nativeObject(params.toolCall, 'permission tool');
  let complete = false;
  let fallback = false;
  if (selection.mapping === 'declared-complete-consequences-v1') {
    assertCompleteChoiceFields(params, native);
    if (!selection.menus.some((menu) => matchesMenu(menu, tool, native))) unsupportedConsequence();
    complete = true;
  } else if (selection.mapping === 'grok-build-1.0.50-edit-remembrance-v1') {
    if (tool.kind === 'edit') {
      assertCompleteChoiceFields(params, native);
      if (!qualifiedGrokEdit(tool, native)) unsupportedConsequence();
      complete = true;
    } else fallback = true;
  }
  const nativeOptions = new Map<string, string>();
  const options: AgentApprovalOption[] = [];
  for (const [index, option] of native.entries()) {
    const remembered = option.kind === 'allow_always' || option.kind === 'reject_always';
    if (remembered && !complete) continue;
    const approved = option.kind === 'allow_once' || option.kind === 'allow_always';
    const optionId = parseAgentApprovalOptionId(`acp:option:${index + 1}`);
    nativeOptions.set(optionId, option.optionId);
    options.push({
      optionId,
      label: remembered ? approved ? 'Allow and remember' : 'Deny and remember'
        : displayText(option.source.name, approved ? 'Allow once' : 'Reject once'),
      decision: approved ? 'approved' : 'denied',
      consequence: remembered ? {
        kind: 'provider_managed_remembrance',
        duration: { kind: 'unknown' },
        applicability: { kind: 'unknown' },
        explanation: 'The provider is asked to remember this decision. Duration and future matching are unspecified. Delivery does not establish successful persistence or revocation.',
      } : { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } },
    });
  }
  if (options.length === 0) {
    if (fallback) unsupportedConsequence();
    throw new AcpProviderSessionError('acp_permission_persistence_unsupported', 'ACP offered no supported once-only permission choice.');
  }
  return {
    options,
    nativeOptions,
    ...(fallback ? { warning: {
      code: 'acp_permission_remembrance_unmapped',
      message: 'The selected ACP profile does not map remembered choices for this action. Only once-only choices are available.',
    } } : {}),
  };
}

import type { AcpClient, AcpJsonObject } from '@agen-ai/acp-transport';
import {
  type AgentCapabilities,
  type AgentConfigurationSelectionInput,
  type AgentSessionConfiguration,
} from '@agen-ai/agent-protocol';
import {
  throwIfAgentOperationAborted,
  type AgentProviderApplyConfigurationSelectionInput,
  type AgentProviderOperationResult,
  type AgentSessionConfigurationControl,
} from '@agen-ai/agent-runtime';

import { AcpConfigurationCatalogState } from './catalog.js';
import { AcpConfigurationError, invalidConfigurationCatalog } from './errors.js';

export interface AcpSessionConfiguration {
  readonly control: AgentSessionConfigurationControl;
  readonly observeSetup: (response: AcpJsonObject) => void;
  readonly observeUpdate: (update: AcpJsonObject) => boolean;
  readonly applyOpeningConfiguration: (configuration: AgentSessionConfiguration, signal?: AbortSignal) => Promise<void>;
}

export function createAcpSessionConfiguration(input: {
  readonly capability: AgentCapabilities['configuration'];
  readonly client: AcpClient;
  readonly getSessionId: () => string;
  readonly assertUsable: () => void;
  readonly onFailure: (error: Error) => void;
  readonly timeoutMs: number;
  readonly maxSnapshotBytes?: number;
}): AcpSessionConfiguration {
  if (input.capability.kind === 'managed') {
    return Object.freeze({
      control: Object.freeze({ kind: 'managed' as const }),
      observeSetup() {},
      observeUpdate(update: AcpJsonObject) { return ['config_option_update', 'current_mode_update'].includes(String(update.sessionUpdate)); },
      async applyOpeningConfiguration(configuration: AgentSessionConfiguration, signal?: AbortSignal) {
        input.assertUsable();
        throwIfAgentOperationAborted(signal);
        if (configuration.kind !== 'managed') throw new AcpConfigurationError('acp_configuration_kind_unsupported', 'This ACP instance requires managed configuration.');
      },
    });
  }

  const state = new AcpConfigurationCatalogState(input.maxSnapshotBytes ?? 1_024 * 1_024, input.capability);
  let applying = false;

  const apply = async (operation: AgentProviderApplyConfigurationSelectionInput): Promise<AgentProviderOperationResult> => {
    input.assertUsable();
    throwIfAgentOperationAborted(operation.signal);
    if (applying) throw new AcpConfigurationError('acp_configuration_busy', 'Another ACP configuration selection is pending.');
    const { binding, selection } = state.resolve(operation.selection);
    const value = selection.value.fieldKind === 'single_select'
      ? binding.options.get(selection.value.optionId) : selection.value.fieldKind === 'boolean' ? selection.value.value : undefined;
    if (value === undefined) throw new AcpConfigurationError('acp_configuration_selection_invalid', 'ACP configuration supports only offered selections and boolean values.');
    const params: AcpJsonObject = binding.method === 'session/set_mode'
      ? { sessionId: input.getSessionId(), modeId: value }
      : { sessionId: input.getSessionId(), configId: binding.nativeId, value, ...(typeof value === 'boolean' ? { type: 'boolean' } : {}) };
    applying = true;
    let dispatched = false;
    try {
      await input.client.request(binding.method, params, {
        timeoutMs: input.timeoutMs,
        ...(operation.signal === undefined ? {} : { signal: operation.signal }),
        onRequestDispatch() {
          input.assertUsable();
          throwIfAgentOperationAborted(operation.signal);
          state.resolve(selection);
          operation.onProviderExecutionStarted?.();
          dispatched = true;
        },
        onResponseReceived(response) {
          if (response.kind === 'error') return;
          if (binding.method === 'session/set_mode') {
            if (typeof value !== 'string') return invalidConfigurationCatalog();
            state.observeMode(value);
          } else {
            if (response.result === null || typeof response.result !== 'object' || Array.isArray(response.result)) return invalidConfigurationCatalog();
            state.observeConfigResponse(response.result);
          }
          const confirmed = state.list().fields.find((field) => field.key === selection.key);
          if (!confirmed || (
            selection.value.fieldKind === 'boolean'
              ? confirmed.fieldKind !== 'boolean' || confirmed.currentValue !== selection.value.value
              : confirmed.fieldKind !== 'single_select' || selection.value.fieldKind !== 'single_select' || confirmed.currentValue !== selection.value.optionId
          )) throw new AcpConfigurationError('acp_configuration_selection_unconfirmed', 'The ACP response did not confirm the selected configuration value.');
        },
      });
      return { status: 'completed' };
    } catch (cause) {
      if (dispatched) {
        const error = cause instanceof Error ? cause : new AcpConfigurationError(
          'acp_configuration_operation_failed', 'A dispatched ACP configuration operation failed.', { cause },
        );
        state.retire(error);
        input.onFailure(error);
      }
      throw cause;
    } finally { applying = false; }
  };

  return Object.freeze({
    control: Object.freeze({
      kind: 'selectable' as const,
      listConfiguration({ signal }: { readonly signal?: AbortSignal } = {}) {
        input.assertUsable();
        throwIfAgentOperationAborted(signal);
        return state.list();
      },
      applyConfigurationSelection: apply,
    }),
    observeSetup: (response: AcpJsonObject) => state.observeSetup(response),
    observeUpdate: (update: AcpJsonObject) => state.observeUpdate(update),
    async applyOpeningConfiguration(configuration: AgentSessionConfiguration, signal?: AbortSignal) {
      input.assertUsable();
      throwIfAgentOperationAborted(signal);
      if (configuration.kind !== 'selected') throw new AcpConfigurationError('acp_configuration_kind_unsupported', 'This ACP instance requires selected configuration.');
      state.assertValid();
      if (configuration.selections.length === 0 && configuration.catalogRevision === 1) return;
      const catalog = state.list();
      if (configuration.catalogRevision !== catalog.revision) throw new AcpConfigurationError('acp_configuration_selection_invalid', 'The opening configuration targets a stale catalog.');
      const selections: AgentConfigurationSelectionInput[] = configuration.selections.map((selection) => ({
        key: selection.key,
        expectedCatalogRevision: configuration.catalogRevision,
        expectedFieldRevision: selection.fieldRevision,
        value: selection.value,
      }));
      for (const selection of selections) state.resolve(selection);
      for (const selection of selections) {
        await apply({ selection: { ...selection, expectedCatalogRevision: state.list().revision }, ...(signal === undefined ? {} : { signal }) });
      }
    },
  });
}

import type {
  AgentHistoryDriver, AgentHistoryMutationDriverMethod, AgentHistoryMethod, AgentHistoryMutationDescriptor,
  AgentHistoryMutationInput, AgentHistoryMutationOperation, AgentHistoryMutationResult,
  AgentHistoryPort, AgentHistoryPorts, AgentHistorySource, AgentHistoryOperationOptions,
} from '../contracts/index.js';
import {
  parseAgentHistoryMutationDescriptor, parseAgentHistoryMutationInput,
  parseAgentHistoryMutationResult, parseAgentHistoryRenameInput,
} from '../validation/parse.js';
import { queryDigest } from '../pagination/cursor.js';
import { assertSource, method, operationOptions, unsupported } from './boundary.js';
import { AgentHistoryError, OperationFailure } from './errors.js';
import type { HistoryOwner } from './owner.js';

export function mutationPorts(source: AgentHistorySource, driver: AgentHistoryDriver, owner: HistoryOwner, enabled: readonly AgentHistoryMutationOperation[]): Pick<AgentHistoryPorts, 'rename' | 'archive' | 'restore' | 'delete'> {
  function bind<Input extends AgentHistoryMutationInput>(
    operation: AgentHistoryMutationOperation,
    port: AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMutationDriverMethod<Input> }>,
    parse: (input: unknown) => Input,
  ): AgentHistoryPort<AgentHistoryMutationDescriptor, { apply: AgentHistoryMethod<Input, AgentHistoryMutationResult> }> {
    if (port.status === 'unsupported') return unsupported(port.reason);
    const descriptor = parseAgentHistoryMutationDescriptor(port.descriptor);
    method(port.apply);
    const apply = port.apply.bind(port);
    if (!enabled.includes(operation)) return unsupported({ code: 'management_disabled', message: 'Saved-conversation management was not enabled for this operation.' });
    return Object.freeze({ status: 'supported' as const, descriptor, apply: async (raw: Input, options?: AgentHistoryOperationOptions): Promise<AgentHistoryMutationResult> => {
      const input = parse(raw);
      assertSource(input.conversation, source);
      if (queryDigest(input.acceptEffects) !== queryDigest(descriptor.effects)) {
        return { status: 'not_applied', ref: input.conversation, reason: { code: 'effects_not_accepted', message: 'The declared native effects must be accepted exactly before mutation.' } };
      }
      try {
        return await owner.run('mutation', operationOptions(options), async (context) => {
          const accept = (value: unknown): AgentHistoryMutationResult => {
            let result: AgentHistoryMutationResult;
            try {
              result = parseAgentHistoryMutationResult(value);
              assertSource(result.ref, source);
              if (result.ref.conversationId !== input.conversation.conversationId) throw new Error('Wrong mutation conversation');
            } catch { throw new AgentHistoryError('native_failure', 'Native history returned an invalid mutation result.'); }
            if (result.status === 'outcome_unknown') owner.fenceMutations();
            return result;
          };
          let receipt: AgentHistoryMutationResult | undefined;
          const value = await apply(input, { signal: context.signal, markDispatched: context.markDispatched,
            recordReceipt: (rawReceipt) => {
              const result = accept(rawReceipt);
              context.recordResult(result);
              receipt = result;
            },
          });
          const result = accept(value);
          if (receipt !== undefined && queryDigest(receipt) !== queryDigest(result)) {
            throw new AgentHistoryError('native_failure', 'Native history changed an already recorded mutation receipt.');
          }
          return receipt ?? result;
        });
      } catch (error) {
        const dispatched = error instanceof OperationFailure && error.dispatched;
        const failure = error instanceof OperationFailure ? error.error : error instanceof AgentHistoryError
          ? error : new AgentHistoryError('native_failure', 'The history mutation failed.');
        return { status: dispatched ? 'outcome_unknown' : 'not_applied', ref: input.conversation, reason: { code: failure.code, message: failure.message } };
      }
    } });
  }
  return {
    rename: bind('rename', driver.rename, parseAgentHistoryRenameInput),
    archive: bind('archive', driver.archive, parseAgentHistoryMutationInput),
    restore: bind('restore', driver.restore, parseAgentHistoryMutationInput),
    delete: bind('delete', driver.delete, parseAgentHistoryMutationInput),
  };
}

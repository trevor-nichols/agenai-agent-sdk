import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import { HistoryManagementSelectionSchema } from '../../validation/operations.js';
import type { GrokHistoryExtensionDefinition } from './contracts.js';
import { GrokStateParamsSchema, GrokStateSchema, GrokUpdatesParamsSchema, GrokUpdatesSchema,
  GrokSearchParamsSchema, GrokSearchResponseSchema, GrokRenameParamsSchema, GrokDeleteParamsSchema, GrokMutationReceiptSchema } from './native.js';

export function grokHistoryExtensions(options: Readonly<{ management?: readonly AgentHistoryMutationOperation[] }> = {}): readonly GrokHistoryExtensionDefinition[] {
  const selected = HistoryManagementSelectionSchema.parse(options.management ?? []);
  const definitions: GrokHistoryExtensionDefinition[] = [
    Object.freeze({ method: '_x.ai/session/state', direction: 'outbound_request',
      validateParams: (value: unknown) => GrokStateParamsSchema.safeParse(value).success,
      validateResult: (value: unknown) => GrokStateSchema.safeParse(value).success }),
    Object.freeze({ method: '_x.ai/session/updates', direction: 'outbound_request',
      validateParams: (value: unknown) => GrokUpdatesParamsSchema.safeParse(value).success,
      validateResult: (value: unknown) => GrokUpdatesSchema.safeParse(value).success }),
    Object.freeze({ method: '_x.ai/session/search', direction: 'outbound_request',
      validateParams: (value: unknown) => GrokSearchParamsSchema.safeParse(value).success,
      validateResult: (value: unknown) => GrokSearchResponseSchema.safeParse(value).success }),
  ];
  if (selected.includes('rename')) definitions.push(Object.freeze({ method: '_x.ai/session/rename', direction: 'outbound_request',
    validateParams: (value: unknown) => GrokRenameParamsSchema.safeParse(value).success,
    validateResult: (value: unknown) => GrokMutationReceiptSchema.safeParse(value).success }));
  if (selected.includes('delete')) definitions.push(Object.freeze({ method: '_x.ai/session/delete', direction: 'outbound_request',
    validateParams: (value: unknown) => GrokDeleteParamsSchema.safeParse(value).success,
    validateResult: (value: unknown) => GrokMutationReceiptSchema.safeParse(value).success }));
  return Object.freeze(definitions);
}

// ------------------------------------------------------------------------------------------------
//                pages.ts - Bounded keyset pages and opaque query cursors
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { delegationDataBytes, delegationInputDigest } from "../shared/identity.js";
import type { DelegationLimits } from "../shared/limits.js";
import type { DelegationPage, DelegationRunRecord, DelegationRunSummary } from "../tasks/types.js";

export function summarizeDelegationRun(run: DelegationRunRecord): DelegationRunSummary {
  const { input: _input, ...summary } = run;
  return summary;
}

export function delegationCursorPrefix(storeId: string, query: unknown): string {
  return `${storeId}:${delegationInputDigest(query).slice(0, 16)}:`;
}

export function parseDelegationPageCursor(storeId: string, query: unknown, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const prefix = delegationCursorPrefix(storeId, query);
  if (!cursor.startsWith(prefix)) failDelegation("stale_revision", "The cursor belongs to a different store query.");
  const key = cursor.slice(prefix.length);
  if (!key || key.length > 128) failDelegation("stale_revision", "The retained cursor is invalid.");
  return key;
}

export function pageDelegationRows<Value>(input: {
  readonly storeId: string;
  readonly query: unknown;
  readonly rows: readonly Value[];
  readonly key: (value: Value) => string;
  readonly limits: DelegationLimits;
  readonly cursor?: string;
  readonly limit?: number;
  readonly envelopeBytes?: number;
}): DelegationPage<Value> {
  const after = parseDelegationPageCursor(input.storeId, input.query, input.cursor);
  const limit = Math.min(input.limit ?? input.limits.maxPageRecords, input.limits.maxPageRecords);
  const rows = [...input.rows].sort((left, right) => {
    const a = input.key(left), b = input.key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const items: Value[] = [];
  let bytes = (input.envelopeBytes ?? 0) + 512;
  let hasMore = false;
  for (const row of rows) {
    if (after !== undefined && input.key(row) <= after) continue;
    const size = delegationDataBytes(row) + 1;
    if (items.length >= limit || bytes + size > input.limits.maxPageBytes) {
      if (items.length === 0) failDelegation("capacity_exceeded", "A complete record exceeds this read page budget.");
      hasMore = true;
      break;
    }
    items.push(row);
    bytes += size;
  }
  return { items, ...(hasMore ? { cursor: `${delegationCursorPrefix(input.storeId, input.query)}${input.key(items.at(-1)!)}` } : {}) };
}

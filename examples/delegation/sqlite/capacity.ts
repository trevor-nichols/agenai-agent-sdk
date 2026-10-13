// ------------------------------------------------------------------------------------------------
//                capacity.ts - Page, WAL and filesystem capacity outside assigned slots
// ------------------------------------------------------------------------------------------------

import { statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { DelegationStoreCapacity } from '@agen-ai/agent-orchestration';
import { fail } from './errors.js';
import { MAX_DATABASE_BYTES, PAGE_BYTES } from './schema.js';

export const FILESYSTEM_HEADROOM_BYTES = 67_108_864;
export const TRANSACTION_OVERHEAD_BYTES = 4_194_304;

export function readCapacity(database: DatabaseSync): DelegationStoreCapacity {
  const row = database.prepare('SELECT capacity_json FROM delegation_state WHERE singleton=1').get();
  if (!row || typeof row.capacity_json !== 'string') fail('store_failed', 'The retained store capacity is unavailable.');
  const capacity = JSON.parse(row.capacity_json) as DelegationStoreCapacity;
  if (Object.values(capacity).some((value) => !Number.isSafeInteger(value) || value < 0)) fail('store_failed', 'Retained store capacity is invalid.');
  return capacity;
}

export function assertPhysicalCapacity(database: DatabaseSync, root: string, capacity: DelegationStoreCapacity,
  ordinaryBytes = 0, assignedWriteBytes = 0): void {
  if (!Number.isSafeInteger(ordinaryBytes) || ordinaryBytes < 0 || !Number.isSafeInteger(assignedWriteBytes) || assignedWriteBytes < 0) {
    fail('capacity_exceeded', 'Reference transaction byte bounds must be finite safe integers.');
  }
  const reserve = BigInt(Math.max(0, capacity.reservedBytes - assignedWriteBytes)) * 3n
    + BigInt(TRANSACTION_OVERHEAD_BYTES) + BigInt(ordinaryBytes) * 3n;
  const pages = database.prepare('PRAGMA page_count').get()?.page_count;
  const freePages = database.prepare('PRAGMA freelist_count').get()?.freelist_count;
  if (typeof pages !== 'number' || typeof freePages !== 'number') fail('store_failed', 'SQLite page accounting is unavailable.');
  const used = BigInt(pages - freePages) * BigInt(PAGE_BYTES);
  const filesystem = statfsSync(root, { bigint: true });
  if (used + reserve > BigInt(MAX_DATABASE_BYTES)
    || filesystem.bavail * filesystem.bsize < BigInt(FILESYSTEM_HEADROOM_BYTES) + reserve) {
    fail('capacity_exceeded', 'Ordinary reference storage must preserve pending final/control pages, WAL growth and filesystem headroom.');
  }
}

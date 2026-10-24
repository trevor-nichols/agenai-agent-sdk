// ------------------------------------------------------------------------------------------------
//                sort.ts - Fixed-fan-in external merging and final path conflict validation
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverSpillFile } from '../../backend/spill.js';
import { compareRecords, decodeRecord, DESCRIPTOR_BYTES, isDescendant, MetadataConflictError } from './records.js';
import type { EncodedRecord } from './records.js';
import { address, readDescriptor, readRecord, writeDescriptor, writeRecord } from './storage.js';
import type { RunCursor } from './storage.js';

export interface SpillFiles {
  data: [SandboxDriverSpillFile, SandboxDriverSpillFile];
  descriptors: [SandboxDriverSpillFile, SandboxDriverSpillFile];
}

export interface SortState {
  readonly runs: number;
  readonly end: number;
  readonly descriptorEnd: number;
}

interface MergeHead {
  readonly cursor: RunCursor;
  record: EncodedRecord | undefined;
}

export async function mergePass(files: SpillFiles, input: SortState, fanIn: number, signal: AbortSignal): Promise<SortState> {
  await files.data[1].truncate(0);
  await files.descriptors[1].truncate(0);
  let end = 0;
  let descriptorEnd = 0;
  let runs = 0;
  let index = 0;
  while (index < input.runs) {
    signal.throwIfAborted();
    const heads: MergeHead[] = [];
    const count = Math.min(fanIn, input.runs - index);
    for (let item = 0; item < count; item += 1) {
      const cursor = await readDescriptor(files.descriptors[0], address(index * DESCRIPTOR_BYTES));
      heads.push({ cursor, record: await readRecord(files.data[0], cursor) });
      index += 1;
    }
    const start = end;
    for (;;) {
      signal.throwIfAborted();
      let selected: { readonly head: MergeHead; readonly record: EncodedRecord } | undefined;
      for (const head of heads) {
        const record = head.record;
        if (record && (!selected || compareRecords(record, selected.record) < 0)) selected = { head, record };
      }
      if (!selected) break;
      end = await writeRecord(files.data[1], selected.record, end);
      const head = selected.head;
      head.record = undefined;
      head.record = await readRecord(files.data[0], head.cursor);
    }
    descriptorEnd = await writeDescriptor(files.descriptors[1], descriptorEnd, start, end);
    runs = address(runs + 1);
  }
  files.data = [files.data[1], files.data[0]];
  files.descriptors = [files.descriptors[1], files.descriptors[0]];
  return { runs, end, descriptorEnd };
}

export async function validateRun(file: SandboxDriverSpillFile, end: number, signal: AbortSignal): Promise<void> {
  const cursor: RunCursor = { position: 0, end };
  const ancestors: EncodedRecord[] = [];
  for (;;) {
    signal.throwIfAborted();
    const record = await readRecord(file, cursor);
    if (!record) break;
    const decoded = decodeRecord(record);
    const previous = ancestors.at(-1);
    if (previous && compareRecords(previous, record) === 0) throw new MetadataConflictError('duplicate_path', decoded.path);
    for (;;) {
      const ancestor = ancestors.at(-1);
      if (!ancestor || isDescendant(record, ancestor)) break;
      ancestors.pop();
    }
    if (ancestors.at(-1)?.kind === 'file') throw new MetadataConflictError('file_ancestor', decoded.path);
    ancestors.push(record);
  }
  signal.throwIfAborted();
}

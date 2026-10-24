import type { AgentHistoryOmission, AgentHistoryReadInput, AgentHistoryRecord, AgentHistorySource, AgentHistoryTranscriptPage } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryTranscriptPage } from '../../validation/parse.js';
import { projectCursorTurn } from './content.js';
import { encodeCursorTranscript, nativeTranscriptCursor, type CursorTranscriptPosition } from './continuation.js';
import { parseCursorNative, runDocument, runInfo, type CursorHistorySdk } from './native.js';
import { scopedCursorAgent } from './session.js';

export async function readCursorTranscript(sdk: CursorHistorySdk, source: AgentHistorySource,
  input: AgentHistoryReadInput, bytes: number): Promise<AgentHistoryTranscriptPage> {
  const agentId = input.conversation.conversationId;
  const document = await scopedCursorAgent(sdk, source, agentId);
  const view = input.view ?? { kind: 'main' };
  if (view.kind !== 'main' && view.kind !== 'run') throw new AgentHistoryError('unsupported_scope', 'Cursor local history supports checkpoint and terminal run views only.');
  const limit = input.limit ?? 100, nativeLimit = Math.min(limit + 1, 100);
  let position: CursorTranscriptPosition;
  let nativeRows: readonly unknown[];
  let knownMore = false;
  if (view.kind === 'main') {
    const revision = document.latestCheckpoint?.rootBlobId ?? 'none';
    position = nativeTranscriptCursor(input.cursor, revision);
    const result = await sdk.messages(agentId, { offset: position.offset, limit: nativeLimit });
    if (!Array.isArray(result) || result.length > nativeLimit) throw new AgentHistoryError('native_failure', 'Cursor checkpoint helper returned an invalid page.');
    const after = await scopedCursorAgent(sdk, source, agentId);
    if ((after.latestCheckpoint?.rootBlobId ?? 'none') !== revision) throw new AgentHistoryError('invalid_cursor', 'Cursor checkpoint changed during the read.');
    nativeRows = result;
    knownMore = result.length === nativeLimit;
  } else {
    const rawRun = await sdk.runDocument(agentId, view.id);
    if (rawRun === null) throw new AgentHistoryError('not_found', 'The selected Cursor run is missing for this agent.');
    const run = parseCursorNative(runDocument, rawRun);
    if (run.agentId !== agentId || run.runId !== view.id) throw new AgentHistoryError('not_found', 'The selected Cursor run is missing for this agent.');
    if (run.status === 'running' || run.status === 'queued') throw new AgentHistoryError('unsupported_scope', 'Running Cursor replay can tail live execution and is not admitted by this history reader.');
    const revision = `${run.createdAt}:${run.updatedAt}:${run.status}`;
    position = nativeTranscriptCursor(input.cursor, revision);
    const handle = await sdk.getRun(view.id), info = parseCursorNative(runInfo, handle.runInfo);
    if (info.id !== view.id || info.agentId !== agentId) throw new AgentHistoryError('not_found', 'The selected Cursor run is missing for this agent.');
    if (info.status === 'running') throw new AgentHistoryError('unsupported_scope', 'The Cursor run is not a settled history view.');
    const result = await handle.conversation();
    if (!Array.isArray(result)) throw new AgentHistoryError('native_failure', 'Cursor run helper returned an invalid conversation.');
    const rawAfter = await sdk.runDocument(agentId, view.id);
    if (rawAfter === null) throw new AgentHistoryError('not_found', 'The selected Cursor run was removed during the read.');
    const after = parseCursorNative(runDocument, rawAfter);
    if (`${after.createdAt}:${after.updatedAt}:${after.status}` !== revision) throw new AgentHistoryError('invalid_cursor', 'Cursor run metadata changed during replay.');
    await scopedCursorAgent(sdk, source, agentId);
    nativeRows = result.slice(position.offset, position.offset + nativeLimit);
    knownMore = position.offset + nativeRows.length < result.length;
  }
  if (nativeRows.length === 0 && position.part !== 0) throw new AgentHistoryError('invalid_cursor', 'Cursor transcript no longer contains the continued record.');
  const items: AgentHistoryRecord[] = [], observedAt = new Date().toISOString();
  const omissions = new Set<AgentHistoryOmission>(['native_retention', 'subagents_excluded', 'provider_omission']);
  const makePage = (next?: CursorTranscriptPosition) => ({ items,
    ...(next === undefined ? {} : { nextCursor: encodeCursorTranscript(next) }), observedAt, consistency: 'live',
    coverage: { view: view.kind === 'main' ? 'current_checkpoint' : 'stored_updates', children: 'excluded', omissions: [...omissions] } });
  const finish = (next?: CursorTranscriptPosition): AgentHistoryTranscriptPage => {
    const page = makePage(next);
    if (!nativePageFits(page, bytes, page.nextCursor)) throw new AgentHistoryError('limit_exhausted', 'Cursor transcript page exceeds its output budget.');
    return parseAgentHistoryTranscriptPage(page);
  };
  for (let index = 0; index < nativeRows.length; index += 1) {
    const offset = position.offset + index;
    if (items.length === limit) return finish({ version: 1, kind: 'transcript', offset, part: 0, revision: position.revision });
    const turn = projectCursorTurn(nativeRows[index], view.kind === 'main' ? 'checkpoint' : 'run', agentId);
    const firstPart = index === 0 ? position.part : 0;
    if (firstPart >= turn.records.length || (index === 0 && position.fingerprint !== undefined && position.fingerprint !== turn.fingerprint)) {
      throw new AgentHistoryError('invalid_cursor', 'Cursor transcript record changed during traversal.');
    }
    for (const omission of turn.omissions) omissions.add(omission);
    for (let part = firstPart; part < turn.records.length; part += 1) {
      const record = turn.records[part];
      if (record === undefined) throw new AgentHistoryError('native_failure', 'Cursor transcript projection is incomplete.');
      const current = { version: 1 as const, kind: 'transcript' as const, offset, part, revision: position.revision, fingerprint: turn.fingerprint };
      if (items.length === limit) return finish(current);
      const next = part + 1 < turn.records.length
        ? { ...current, part: part + 1 }
        : index + 1 < nativeRows.length || knownMore
          ? { version: 1 as const, kind: 'transcript' as const, offset: offset + 1, part: 0, revision: position.revision }
          : undefined;
      items.push(record);
      const page = makePage(next);
      if (!nativePageFits(page, bytes, page.nextCursor)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One Cursor transcript record exceeds the output budget.');
        return finish(current);
      }
    }
  }
  return finish(knownMore ? { version: 1, kind: 'transcript', offset: position.offset + nativeRows.length, part: 0, revision: position.revision } : undefined);
}

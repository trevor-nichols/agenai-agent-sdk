import { randomUUID } from 'node:crypto';
import type { DelegationParentScope } from '@agen-ai/agent-orchestration';
import { parentKey, readInboxRow } from './records.js';
import type { ParentInboxContext } from './state.js';
import type { ParentDispatchReceipt, ParentInboxView, ParentTurnLease } from './types.js';

function settle(context: ParentInboxContext, inboxId: string, state: 'acknowledged' | 'recovery_required' | 'dismissed', reason?: string): void {
  context.database.ordinaryTransaction(4096, (database) => {
    const expected = state === 'dismissed' ? 'pending' : 'dispatch_intended';
    const changed = database.prepare('UPDATE delegation_parent_inbox SET state = ?, reason = ?, settled_at = ? WHERE inbox_id = ? AND state = ?')
      .run(state, reason ?? null, new Date().toISOString(), inboxId, expected);
    if (changed.changes !== 1 && database.prepare('SELECT state FROM delegation_parent_inbox WHERE inbox_id = ?').get(inboxId)?.state !== state) {
      throw new Error('The reference parent dispatch outcome is already settled or unavailable.');
    }
  });
}

async function releaseTurn(context: ParentInboxContext, lease: ParentTurnLease, releaseProducer: () => void): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await lease.release(); releaseProducer(); return; }
    catch { /* Retain the exact lease until its bounded retry succeeds. */ }
  }
  context.releaseFailed = true;
}

async function dispatchOne(context: ParentInboxContext, retained: ParentInboxView): Promise<ParentDispatchReceipt> {
  const { inboxId, envelope } = retained;
  const destination = context.destination(envelope.parent);
  if (!destination) return { inboxId, state: 'blocked', reason: 'authority_unavailable' };
  const terminalReason = destination.revision !== envelope.parent.revision || !destination.resultAccess ? 'revoked'
    : destination.lifecycle === 'retired' ? 'parent_retired'
      : Date.parse(envelope.expiresAt) <= Date.now() ? 'expired' : undefined;
  if (terminalReason) { settle(context, inboxId, 'dismissed', terminalReason); return { inboxId, state: 'dismissed', reason: terminalReason }; }
  if (destination.lifecycle !== 'idle' || !destination.executionAllowed) {
    return { inboxId, state: 'blocked', reason: destination.lifecycle !== 'idle' ? destination.lifecycle : 'execution_unavailable' };
  }
  const releaseProducer = context.database.retainProducer();
  let lease: ParentTurnLease | undefined;
  let intended = false;
  try {
    lease = context.host.acquireTurn(envelope.parent);
    if (!lease) return { inboxId, state: 'blocked', reason: 'busy' };
    lease.assertCurrent();
    lease.signal.throwIfAborted();
    context.shutdown.signal.throwIfAborted();
    context.database.ordinaryTransaction(4096, (database) => {
      lease!.assertCurrent();
      const changed = database.prepare("UPDATE delegation_parent_inbox SET state = 'dispatch_intended', dispatch_id = ?, dispatched_at = ? WHERE inbox_id = ? AND state = 'pending'")
        .run(randomUUID(), new Date().toISOString(), inboxId);
      if (changed.changes !== 1) throw new Error('The parent inbox dispatch state changed.');
    });
    intended = true;
    lease.assertCurrent();
    const signal = AbortSignal.any([lease.signal, context.shutdown.signal]);
    signal.throwIfAborted();
    context.database.assertCurrent();
    const response = await lease.dispatch({ envelope, inboxId, signal });
    const state = response.status === 'acknowledged' ? 'acknowledged' : 'recovery_required';
    settle(context, inboxId, state, state === 'recovery_required' ? 'dispatch_uncertain' : undefined);
    return { inboxId, state };
  } catch (error) {
    if (!intended) throw error;
    settle(context, inboxId, 'recovery_required', 'dispatch_uncertain');
    return { inboxId, state: 'recovery_required', reason: 'dispatch_uncertain' };
  } finally {
    if (lease) await releaseTurn(context, lease, releaseProducer);
    else releaseProducer();
  }
}

export async function dispatchPending(context: ParentInboxContext, input: Readonly<{
  parent: DelegationParentScope; trigger: 'automatic' | 'next_turn'; limit?: number;
}>): Promise<readonly ParentDispatchReceipt[]> {
  context.assertOpen();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('A parent inbox dispatch page requires a limit from 1 to 100.');
  if (input.trigger !== 'automatic' && input.trigger !== 'next_turn') throw new TypeError('The parent inbox dispatch trigger is invalid.');
  const identities = context.database.read((database) => database.prepare(
    "SELECT inbox_id FROM delegation_parent_inbox WHERE parent_key = ? AND state = 'pending' AND (? = 'next_turn' OR policy = 'automatic') ORDER BY accepted_at,inbox_id LIMIT ?",
  ).all(parentKey(input.parent), input.trigger, limit));
  const receipts: ParentDispatchReceipt[] = [];
  for (const identity of identities) {
    if (context.closing || context.releaseFailed) break;
    if (typeof identity.inbox_id !== 'string') throw new Error('The reference parent inbox identity is invalid.');
    const record = context.database.read((database) => {
      const row = database.prepare("SELECT * FROM delegation_parent_inbox WHERE inbox_id = ? AND state = 'pending'").get(identity.inbox_id!);
      return row ? readInboxRow(row) : undefined;
    });
    if (!record) continue;
    receipts.push(await dispatchOne(context, record));
  }
  return Object.freeze(receipts);
}

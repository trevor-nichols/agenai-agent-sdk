import { randomUUID } from 'node:crypto';
import {
  parseDelegationCompletionEnvelope, parseDelegationParentScope,
  DelegationOperationError,
  type DelegationInboxAcceptance, type DelegationInboxInspection, type DelegationParentDeliveryPort,
  type DelegationParentScope,
} from '@agen-ai/agent-orchestration';
import { delegationCanonicalJson, delegationInputDigest } from '@agen-ai/agent-orchestration/store-adapter';
import type { DatabaseSync } from 'node:sqlite';
import { parentKey, readInboxRow } from './records.js';
import { assertDeliveryDeadline, type ParentInboxContext } from './state.js';

function availability(context: ParentInboxContext, parent: DelegationParentScope): Exclude<DelegationInboxAcceptance, { status: 'accepted' | 'uncertain' }> | undefined {
  const destination = context.destination(parent);
  if (!destination) return { status: 'blocked', reason: 'authority_unavailable', retryAt: new Date(Date.now() + 1000).toISOString() };
  if (destination.revision !== parent.revision || !destination.resultAccess) return { status: 'rejected', reason: 'revoked' };
  if (destination.lifecycle === 'retired') return { status: 'rejected', reason: 'parent_retired' };
  return undefined;
}

function select(database: DatabaseSync, storeId: string, notificationId: string) {
  return database.prepare('SELECT * FROM delegation_parent_inbox WHERE store_id = ? AND notification_id = ?').get(storeId, notificationId);
}

export function createAcceptancePort(context: ParentInboxContext): DelegationParentDeliveryPort {
  return Object.freeze({
    persistence: 'durable' as const,
    async accept(input): Promise<DelegationInboxAcceptance> {
      context.assertOpen();
      assertDeliveryDeadline(input.signal, input.deadlineAt);
      const envelope = parseDelegationCompletionEnvelope(input.envelope);
      const encoded = delegationCanonicalJson(envelope);
      const digest = delegationInputDigest(envelope);
      let result: DelegationInboxAcceptance;
      try { result = context.database.ordinaryTransaction(Buffer.byteLength(encoded) + 4096, (database): DelegationInboxAcceptance => {
        assertDeliveryDeadline(input.signal, input.deadlineAt);
        const denied = availability(context, envelope.parent);
        if (denied) return denied;
        const existing = select(database, envelope.storeId, envelope.notificationId);
        if (existing) {
          if (existing.envelope_digest !== digest) throw new Error('The reference inbox notification identity has conflicting content.');
          const retained = readInboxRow(existing);
          return { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt };
        }
        if (Date.parse(envelope.expiresAt) <= Date.now()) return { status: 'rejected', reason: 'expired' };
        if (envelope.policy === 'collect') throw new Error('Collect completion does not require a parent inbox.');
        const inboxId = randomUUID();
        const acceptedAt = new Date().toISOString();
        database.prepare(`INSERT INTO delegation_parent_inbox
          (store_id,notification_id,parent_key,parent_revision,policy,envelope_digest,envelope,inbox_id,accepted_at,state)
          VALUES (?,?,?,?,?,?,?,?,?,'pending')`).run(envelope.storeId, envelope.notificationId,
          parentKey(envelope.parent), envelope.parent.revision, envelope.policy, digest, encoded, inboxId, acceptedAt);
        return { status: 'accepted', inboxId, acceptedAt };
      }); } catch (error) {
        if (!(error instanceof DelegationOperationError) || error.code !== 'capacity_exceeded') throw error;
        result = { status: 'blocked', reason: 'capacity', retryAt: new Date(Date.now() + 1000).toISOString() };
      }
      assertDeliveryDeadline(input.signal, input.deadlineAt);
      return result;
    },
    async inspect(input): Promise<DelegationInboxInspection> {
      context.assertOpen();
      assertDeliveryDeadline(input.signal, input.deadlineAt);
      const parent = parseDelegationParentScope(input.parent);
      const result = context.database.read((database): DelegationInboxInspection => {
        const denied = availability(context, parent);
        if (denied?.status === 'rejected') return denied;
        if (denied) throw new Error('Current parent receipt authority is unavailable.');
        const row = select(database, input.storeId, input.notificationId);
        if (!row) return { status: 'absent' };
        const retained = readInboxRow(row);
        if (parentKey(retained.envelope.parent) !== parentKey(parent) || retained.envelope.parent.revision !== parent.revision) {
          throw new Error('The reference inbox receipt belongs to another parent scope.');
        }
        return { status: 'accepted', inboxId: retained.inboxId, acceptedAt: retained.acceptedAt };
      });
      assertDeliveryDeadline(input.signal, input.deadlineAt);
      return result;
    },
  } satisfies DelegationParentDeliveryPort);
}

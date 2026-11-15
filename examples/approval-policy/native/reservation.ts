import { lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeRunConfiguration } from './config.js';
import { fields, integer, literal, NativeExampleError, text, token } from './data.js';
import { physicalDirectory, readJson, writeJson } from './files.js';

const refused = (): never => { throw new NativeExampleError('reservation_refused'); };
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** One durable authorization reservation; no refund, inference replay or implicit stale-lock removal. */
export async function consumeReservation(config: Pick<NativeRunConfiguration, 'runId' | 'profile' | 'backend' | 'reservation'>) {
  const { reservation } = config;
  await physicalDirectory(reservation.ledgerDirectory, true);
  const lock = join(reservation.ledgerDirectory, '.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { refused(); }
  try {
    const header = { format: 'agenai.approval-reservation-ledger.v1', campaignId: reservation.campaignId, currency: 'USD', maximumCents: reservation.maximumCents };
    const headerFile = join(reservation.ledgerDirectory, 'campaign.json');
    let existing: unknown;
    try { existing = await readJson(headerFile); }
    catch (error) { if (!missing(error)) throw error; }
    if (existing === undefined) await writeJson(headerFile, header, true);
    else {
      const data = fields(existing, ['format', 'campaignId', 'currency', 'maximumCents']);
      literal(data.format, header.format); literal(data.currency, 'USD');
      if (data.campaignId !== reservation.campaignId || data.maximumCents !== reservation.maximumCents) refused();
    }
    const entries = join(reservation.ledgerDirectory, 'reservations');
    try { await mkdir(entries, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    await physicalDirectory(entries, true);
    const names = await readdir(entries); if (names.length >= 1024) refused();
    let consumedCents = 0;
    for (const name of names) {
      if (!/^[a-z][a-z0-9-]{0,63}\.json$/u.test(name)) refused();
      const data = fields(await readJson(join(entries, name)), ['format', 'runId', 'nativeSessionId', 'instanceId', 'policy', 'imageDigest', 'amountCents', 'reservedAt']);
      literal(data.format, 'agenai.approval-reservation.v1');
      const runId = token(data.runId); if (name !== `${runId}.json`) refused();
      text(data.nativeSessionId, 36); text(data.instanceId, 256); text(data.policy, 32); text(data.imageDigest, 71); text(data.reservedAt, 64);
      consumedCents += integer(data.amountCents, 1, 1000000);
      if (!Number.isSafeInteger(consumedCents) || runId === config.runId || data.nativeSessionId === config.profile.nativeSessionId) refused();
    }
    if (consumedCents + reservation.amountCents > reservation.maximumCents) refused();
    const record = { format: 'agenai.approval-reservation.v1', runId: config.runId, nativeSessionId: config.profile.nativeSessionId,
      instanceId: config.profile.instanceId, policy: config.profile.policy, imageDigest: config.backend.imageDigest,
      amountCents: reservation.amountCents, reservedAt: new Date().toISOString() };
    await writeJson(join(entries, `${config.runId}.json`), record, true);
    return { currency: 'USD' as const, amountCents: reservation.amountCents, consumedCents: consumedCents + reservation.amountCents,
      maximumCents: reservation.maximumCents, meaning: 'authorization_reservation_only' as const, providerCharge: 'unobserved' as const };
  } finally {
    // This invocation created the lock; an already-present/crash lock is never removed here.
    await lstat(lock); await rmdir(lock);
  }
}

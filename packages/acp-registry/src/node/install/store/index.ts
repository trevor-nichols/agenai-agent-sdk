import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AcpInstallPlan } from '../../../planning/contracts.js';
import { parseAcpInstallPlan } from '../../../planning/parse.js';
import { canonicalDigest } from '../../../shared/digest.js';
import { deepFreeze } from '../../../shared/immutable.js';
import type { AcpInstallationAttempt, AcpInstallationIdentity, AcpInstallationLimits, AcpInstallationReceipt, AcpInstallationReference, AcpPreparedInstallation } from '../contracts.js';
import { resolveAcpInstallationLimits } from '../limits.js';
import { checkInstallationCancellation, isFilesystemError, storeFailure } from './errors.js';
import { inspectDirectory, openOwnedStoreRoot, readOwnedFile, syncDirectory, writeOwnedFile, type OwnedStoreRoot, type PhysicalIdentity } from './filesystem.js';
import { acquireStoreLock, inspectStoreLock, planDirectoryName, releaseStoreLock, type StoreLock } from './lock.js';
import { inspectInstalledPayload } from './payload.js';
import { createInstallationReceipt, parseInstallationReceipt, validatePreparedInstallation } from './receipt.js';
import { captureInstallationIdentity, captureReferenceInput, captureStoreData, inspectReferences, persistReference, releaseReference } from './references.js';
import { cleanInstallationStage, createInstallationStage, type InstallationStage, inspectInstallationStage } from './stage.js';

export interface OwnedInstallationRead { readonly receipt: AcpInstallationReceipt; readonly payloadRoot: string }
export interface OwnedInstallationPreparation { readonly payloadRoot: string; readonly workRoot: string; readonly signal?: AbortSignal }
export interface OwnedInstallationPublish {
  readonly plan: AcpInstallPlan;
  readonly signal?: AbortSignal;
  readonly prepare: (input: OwnedInstallationPreparation) => Promise<AcpPreparedInstallation>;
}
export interface OwnedAcpInstallationStore {
  publish(input: OwnedInstallationPublish): Promise<AcpInstallationReceipt>;
  read(identity: AcpInstallationIdentity): Promise<OwnedInstallationRead>;
  readReference(reference: AcpInstallationReference): Promise<OwnedInstallationRead>;
  acquire(input: AcpInstallationIdentity & { readonly ownerId: string }): Promise<AcpInstallationReference>;
  release(reference: AcpInstallationReference): Promise<void>;
  remove(identity: AcpInstallationIdentity): Promise<void>;
  inspectAttempt(planDigest: string): Promise<AcpInstallationAttempt | undefined>;
  recoverAttempt(input: AcpInstallationAttempt & { readonly ownerQuiesced: true }): Promise<void>;
}

async function readInstallation(authority: OwnedStoreRoot, limits: AcpInstallationLimits, planDigest: string, installationId?: string, verifyPayload = true): Promise<OwnedInstallationRead & { readonly directoryIdentity: PhysicalIdentity }> {
  await authority.assertAuthority();
  const directory = path.join(authority.root, 'installations', planDirectoryName(planDigest));
  let identity;
  try { identity = await inspectDirectory(directory); }
  catch (cause) {
    if (isFilesystemError(cause, 'ENOENT')) storeFailure('installation_not_found', 'No installation exists for the exact selected plan.');
    throw cause;
  }
  if ((await readdir(directory)).sort().join(',') !== 'payload,receipt.json') storeFailure('installation_mismatch', 'The installation has unrecognized retained entries.');
  const payloadRoot = path.join(directory, 'payload');
  await inspectDirectory(payloadRoot);
  const receipt = parseInstallationReceipt(await readOwnedFile(path.join(directory, 'receipt.json'), limits.maxReceiptBytes), limits, planDigest);
  if (receipt.plan.digest !== planDigest || (installationId !== undefined && receipt.installationId !== installationId)) storeFailure('installation_mismatch', 'The retained installation differs from the exact caller-pinned identity.');
  if (verifyPayload) {
    const payload = await inspectInstalledPayload(payloadRoot, limits);
    if (payload.digest !== receipt.payloadDigest || canonicalDigest(payload.entries) !== canonicalDigest(receipt.payload)) storeFailure('payload_changed', 'The complete installed payload differs from its published inventory.');
  }
  await inspectDirectory(directory, identity);
  await authority.assertAuthority();
  if (receipt.publication === 'synced-rename') {
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
    await inspectDirectory(directory, identity);
    await authority.assertAuthority();
  }
  return deepFreeze({ receipt, payloadRoot, directoryIdentity: identity });
}

async function withPlanLock<T>(authority: OwnedStoreRoot, planDigest: string, operation: AcpInstallationAttempt['operation'], action: () => Promise<T>): Promise<T> {
  const lock = await acquireStoreLock(authority, planDigest, operation);
  try { return await action(); } finally { await releaseStoreLock(authority, lock); }
}

async function publishInstallation(authority: OwnedStoreRoot, limits: AcpInstallationLimits, input: OwnedInstallationPublish): Promise<AcpInstallationReceipt> {
  const plan = parseAcpInstallPlan(input.plan, input.plan.digest);
  const signal = input.signal;
  checkInstallationCancellation(signal);
  const lock = await acquireStoreLock(authority, plan.digest, 'install', signal);
  let stage: InstallationStage | undefined;
  let retainLock = false;
  try {
    try { return (await readInstallation(authority, limits, plan.digest)).receipt; }
    catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'installation_not_found')) throw cause; }
    retainLock = true;
    stage = await createInstallationStage(authority, lock);
    retainLock = false;
    const installationIdentity = await inspectDirectory(stage.installationRoot);
    const payloadIdentity = await inspectDirectory(stage.payloadRoot);
    const workIdentity = await inspectDirectory(stage.workRoot);
    const preparedInput = await input.prepare({ payloadRoot: stage.payloadRoot, workRoot: stage.workRoot, ...(signal ? { signal } : {}) });
    checkInstallationCancellation(signal);
    await authority.assertAuthority();
    await inspectDirectory(stage.root, stage.identity);
    await inspectDirectory(stage.installationRoot, installationIdentity);
    await inspectDirectory(stage.payloadRoot, payloadIdentity);
    await inspectDirectory(stage.workRoot, workIdentity);
    if ((await readdir(stage.installationRoot)).join(',') !== 'payload') storeFailure('installation_mismatch', 'Preparation wrote outside the payload layout.');
    const payload = await inspectInstalledPayload(stage.payloadRoot, limits, { synchronize: true, ...(signal ? { signal } : {}) });
    const prepared = validatePreparedInstallation(preparedInput, plan, payload, limits);
    const receipt = createInstallationReceipt(plan, payload, prepared, process.platform === 'win32' ? 'atomic-rename' : 'synced-rename');
    const content = JSON.stringify(receipt);
    if (Buffer.byteLength(content) > limits.maxReceiptBytes) storeFailure('limit_exceeded', 'Installation receipt exceeds its byte limit.');
    await writeOwnedFile(path.join(stage.installationRoot, 'receipt.json'), content);
    await syncDirectory(stage.installationRoot);
    await syncDirectory(stage.root);
    checkInstallationCancellation(signal);
    await authority.assertAuthority();
    await inspectDirectory(stage.root, stage.identity);
    await inspectDirectory(stage.installationRoot, installationIdentity);
    await rename(stage.installationRoot, path.join(authority.root, 'installations', planDirectoryName(plan.digest)));
    await syncDirectory(path.join(authority.root, 'installations'));
    await syncDirectory(stage.root);
    return (await readInstallation(authority, limits, plan.digest, receipt.installationId)).receipt;
  } finally {
    if (stage) {
      retainLock = true;
      await cleanInstallationStage(authority, lock, stage);
      retainLock = false;
    }
    if (!retainLock) await releaseStoreLock(authority, lock);
  }
}

async function removeInstallation(authority: OwnedStoreRoot, limits: AcpInstallationLimits, identity: AcpInstallationIdentity): Promise<void> {
  const lock = await acquireStoreLock(authority, identity.planDigest, 'remove');
  let stage: InstallationStage | undefined;
  let retainLock = false;
  try {
    const inspected = await readInstallation(authority, limits, identity.planDigest, identity.installationId, false);
    if ((await inspectReferences(authority, identity.planDigest, limits.maxReferences)).length > 0) storeFailure('reference_active', 'Persisted installation references must be explicitly released before removal.');
    retainLock = true;
    stage = await createInstallationStage(authority, lock);
    retainLock = false;
    await authority.assertAuthority();
    await inspectDirectory(stage.root, stage.identity);
    await inspectDirectory(path.join(authority.root, 'installations', planDirectoryName(identity.planDigest)), inspected.directoryIdentity);
    await rename(path.join(authority.root, 'installations', planDirectoryName(identity.planDigest)), path.join(stage.root, 'retired'));
    await syncDirectory(path.join(authority.root, 'installations'));
    await syncDirectory(stage.root);
  } finally {
    if (stage) {
      retainLock = true;
      await cleanInstallationStage(authority, lock, stage);
      retainLock = false;
    }
    if (!retainLock) await releaseStoreLock(authority, lock);
  }
}

function publicAttempt(lock: StoreLock): AcpInstallationAttempt {
  return Object.freeze({ planDigest: lock.planDigest, attemptToken: lock.attemptToken, operation: lock.operation, createdAt: lock.createdAt });
}

export async function openOwnedAcpInstallationStore(input: { readonly root: string; readonly limits?: Partial<AcpInstallationLimits> }): Promise<OwnedAcpInstallationStore> {
  const limits = resolveAcpInstallationLimits(input.limits);
  const authority = await openOwnedStoreRoot(input.root);
  return Object.freeze({
    publish: (publishInput: OwnedInstallationPublish) => publishInstallation(authority, limits, publishInput),
    read: (inputIdentity: AcpInstallationIdentity) => {
      const identity = captureInstallationIdentity(inputIdentity);
      return withPlanLock(authority, identity.planDigest, 'read', () => readInstallation(authority, limits, identity.planDigest, identity.installationId));
    },
    readReference: (inputReference: AcpInstallationReference) => {
      const reference = captureReferenceInput(inputReference, true);
      return withPlanLock(authority, reference.planDigest, 'read', async () => {
        const references = await inspectReferences(authority, reference.planDigest, limits.maxReferences);
        if (!references.some((candidate) => candidate.referenceId === reference.referenceId && candidate.installationId === reference.installationId && candidate.ownerId === reference.ownerId)) storeFailure('reference_mismatch', 'Launch resolution requires an exact active persisted reference.');
        return readInstallation(authority, limits, reference.planDigest, reference.installationId);
      });
    },
    acquire: (referenceInput: AcpInstallationIdentity & { readonly ownerId: string }) => {
      const reference = captureReferenceInput(referenceInput, false);
      return withPlanLock(authority, reference.planDigest, 'acquire', async () => {
        await readInstallation(authority, limits, reference.planDigest, reference.installationId);
        await persistReference(authority, reference, limits.maxReferences);
        return Object.freeze(reference);
      });
    },
    release: (inputReference: AcpInstallationReference) => {
      const reference = captureReferenceInput(inputReference, true);
      return withPlanLock(authority, reference.planDigest, 'release', () => releaseReference(authority, reference, limits.maxReferences));
    },
    remove: (inputIdentity: AcpInstallationIdentity) => removeInstallation(authority, limits, captureInstallationIdentity(inputIdentity)),
    inspectAttempt: async (planDigest: string) => {
      const lock = await inspectStoreLock(authority, planDigest);
      return lock ? publicAttempt(lock) : undefined;
    },
    recoverAttempt: async (attempt: AcpInstallationAttempt & { readonly ownerQuiesced: true }) => {
      const captured = captureStoreData(attempt, ['planDigest', 'attemptToken', 'operation', 'createdAt', 'ownerQuiesced']);
      if (captured.ownerQuiesced !== true) storeFailure('recovery_conflict', 'Explicit caller authority that the inspected owner is quiescent is required.');
      if (typeof captured.planDigest !== 'string' || typeof captured.attemptToken !== 'string' || typeof captured.operation !== 'string'
        || typeof captured.createdAt !== 'string') storeFailure('recovery_conflict', 'Recovery requires an exact plain inspected attempt.');
      const current = await inspectStoreLock(authority, captured.planDigest);
      if (!current || canonicalDigest(publicAttempt(current)) !== canonicalDigest({ planDigest: captured.planDigest, attemptToken: captured.attemptToken, operation: captured.operation, createdAt: captured.createdAt })) storeFailure('recovery_conflict', 'Recovery requires the exact inspected attempt identity.');
      const stage = await inspectInstallationStage(authority, current);
      if (stage) await cleanInstallationStage(authority, current, stage);
      await releaseStoreLock(authority, current);
    },
  });
}

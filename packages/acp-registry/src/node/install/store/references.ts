import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ACP_REGISTRY_LIMITS } from '../../../catalog/limits.js';
import { parseBoundedRegistryJson } from '../../../shared/bounds.js';
import type { AcpInstallationIdentity, AcpInstallationReference } from '../contracts.js';
import { isFilesystemError, storeFailure, validateStoreRecord } from './errors.js';
import { inspectDirectory, readOwnedFile, syncDirectory, writeOwnedFile, type OwnedStoreRoot } from './filesystem.js';
import { planDirectoryName } from './lock.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;

export function captureStoreData(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) storeFailure('invalid_input', 'An exact plain installation identity is required.');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) storeFailure('invalid_input', 'Unknown installation identity field.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) storeFailure('invalid_input', 'Installation identities require plain data fields.');
    result[key] = descriptor.value;
  }
  return result;
}

export function captureInstallationIdentity(input: unknown): AcpInstallationIdentity {
  const value = captureStoreData(input, ['planDigest', 'installationId']);
  if (typeof value.planDigest !== 'string' || !digest.test(value.planDigest)
    || typeof value.installationId !== 'string' || !digest.test(value.installationId)) storeFailure('invalid_input', 'Exact plan and installation digests are required.');
  return { planDigest: value.planDigest, installationId: value.installationId };
}

export function captureReferenceInput(input: unknown, releasing: boolean): AcpInstallationReference {
  const value = captureStoreData(input, releasing ? ['planDigest', 'installationId', 'ownerId', 'referenceId'] : ['planDigest', 'installationId', 'ownerId']);
  const identity = captureInstallationIdentity({ planDigest: value.planDigest, installationId: value.installationId });
  if (typeof value.ownerId !== 'string' || !value.ownerId || Buffer.byteLength(value.ownerId) > 512 || /[\p{Cc}\p{Cf}]/u.test(value.ownerId)
    || (releasing && (typeof value.referenceId !== 'string' || !uuid.test(value.referenceId)))) storeFailure('invalid_input', 'A bounded owner identity and exact reference token are required.');
  return { ...identity, ownerId: value.ownerId, referenceId: releasing ? value.referenceId as string : randomUUID() };
}

function referenceDirectory(authority: OwnedStoreRoot, planDigest: string): string {
  return path.join(authority.root, 'references', planDirectoryName(planDigest));
}

export async function inspectReferences(authority: OwnedStoreRoot, planDigest: string, maxReferences: number): Promise<readonly AcpInstallationReference[]> {
  await authority.assertAuthority();
  const directory = referenceDirectory(authority, planDigest);
  let identity;
  try { identity = await inspectDirectory(directory); }
  catch (cause) { if (isFilesystemError(cause, 'ENOENT')) return []; throw cause; }
  const names = (await readdir(directory)).sort();
  if (names.length > maxReferences) storeFailure('limit_exceeded', 'Installation references exceed the configured bound.');
  const references: AcpInstallationReference[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) storeFailure('reference_mismatch', 'The reference directory contains unknown ownership state.');
    const content = await readOwnedFile(path.join(directory, name), 4_096);
    const input = validateStoreRecord('reference_mismatch', () => parseBoundedRegistryJson(content, {
      ...DEFAULT_ACP_REGISTRY_LIMITS, maxSnapshotBytes: 4_096, maxStringBytes: 2_048, maxDepth: 4, maxValues: 32,
    }));
    const record = captureStoreData(input, ['format', 'storeId', 'planDigest', 'installationId', 'ownerId', 'referenceId']);
    if (record.format !== 'acp-installation-reference-v1' || record.storeId !== authority.storeId || record.planDigest !== planDigest
      || record.referenceId !== name.slice(0, -5)) storeFailure('reference_mismatch', 'A retained installation reference has conflicting authority.');
    references.push(captureReferenceInput({ planDigest: record.planDigest, installationId: record.installationId, ownerId: record.ownerId, referenceId: record.referenceId }, true));
  }
  await inspectDirectory(directory, identity);
  if ((await readdir(directory)).sort().join(',') !== names.join(',')) storeFailure('reference_mismatch', 'Installation references changed during inspection.');
  await authority.assertAuthority();
  return references;
}

export async function persistReference(authority: OwnedStoreRoot, reference: AcpInstallationReference, maxReferences: number): Promise<void> {
  if ((await inspectReferences(authority, reference.planDigest, maxReferences)).length >= maxReferences) storeFailure('limit_exceeded', 'Installation reference capacity is exhausted.');
  const directory = referenceDirectory(authority, reference.planDigest);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (cause) { if (!isFilesystemError(cause, 'EEXIST')) throw cause; }
  const identity = await inspectDirectory(directory);
  await authority.assertAuthority();
  await writeOwnedFile(path.join(directory, `${reference.referenceId}.json`), JSON.stringify({ format: 'acp-installation-reference-v1', storeId: authority.storeId, ...reference }));
  await inspectDirectory(directory, identity);
  await syncDirectory(directory);
  await syncDirectory(path.dirname(directory));
  await authority.assertAuthority();
}

export async function releaseReference(authority: OwnedStoreRoot, reference: AcpInstallationReference, maxReferences: number): Promise<void> {
  const references = await inspectReferences(authority, reference.planDigest, maxReferences);
  const retained = references.find((candidate) => candidate.referenceId === reference.referenceId);
  if (!retained || retained.installationId !== reference.installationId || retained.ownerId !== reference.ownerId) storeFailure('reference_mismatch', 'Release requires the complete retained reference authority.');
  const directory = referenceDirectory(authority, reference.planDigest);
  const identity = await inspectDirectory(directory);
  await authority.assertAuthority();
  await unlink(path.join(directory, `${reference.referenceId}.json`));
  await inspectDirectory(directory, identity);
  await syncDirectory(directory);
  if ((await readdir(directory)).length === 0) await rmdir(directory);
  await syncDirectory(path.dirname(directory));
  await authority.assertAuthority();
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { limits, reject } from '../protocol.mjs';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const accountFields = Object.freeze({ email: 'email', principalType: 'principal_type', principalId: 'principal_id',
  teamId: 'team_id', organizationId: 'organization_id' });
const same = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every((key) => left[key] === right[key]);

export async function privateJson(filename, maximum, secret = true) {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || (secret && (before.mode & 0o077n) !== 0n)
    || before.size < 1n || before.size > BigInt(maximum) || await realpath(filename) !== filename) reject('configuration');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    if (!same(before, await file.stat({ bigint: true }))) reject('configuration');
    bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > maximum || !same(before, await file.stat({ bigint: true })) || !same(before, await lstat(filename, { bigint: true }))) reject('configuration');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { bytes?.fill(0); await file.close(); }
}

export async function prepareIdentity(config, signal) {
  if (config.observation === 'native' && (process.platform !== 'linux' || process.arch !== 'arm64'
    || process.version !== 'v24.18.0' || process.getuid() !== 65534 || process.getgid() !== 65534)) reject('native_identity');
  const before = await lstat(config.native.executable, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(config.native.bytes) || await realpath(config.native.executable) !== config.native.executable) reject('native_identity');
  const native = await open(config.native.executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (position < config.native.bytes) {
      if (signal.aborted) reject('cancelled');
      const { bytesRead } = await native.read(buffer, 0, Math.min(buffer.length, config.native.bytes - position), position);
      if (!bytesRead) reject('native_identity'); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (hash.digest('hex') !== config.native.sha256 || !same(before, await native.stat({ bigint: true }))
      || !same(before, await lstat(config.native.executable, { bigint: true }))) reject('native_identity');
  } finally { await native.close(); }
  const project = await lstat(config.project);
  if (!project.isDirectory() || project.isSymbolicLink() || await realpath(config.project) !== config.project
    || (await readdir(config.project)).length !== 0 || await realpath(dirname(config.profile)) !== dirname(config.profile)) reject('configuration');
  await mkdir(config.profile, { mode: 0o700 });
  const stored = await privateJson(config.authFile, limits.credentialBytes);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || Object.keys(stored).length !== 1) reject('authentication');
  const credential = stored[scope];
  if (!credential || credential.auth_mode !== 'oidc' || credential.oidc_issuer !== 'https://auth.x.ai'
    || typeof credential.key !== 'string' || credential.key.length === 0 || typeof credential.user_id !== 'string'
    || Object.hasOwn(credential, 'refresh_token')) reject('authentication');
  const expiry = credential.expires_at == null ? Date.parse(credential.create_time) + 30 * 24 * 60 * 60 * 1000 : Date.parse(credential.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now() + 300_000 || (!credential.email && !credential.principal_id)) reject('authentication');
  const expected = Object.fromEntries(Object.entries(accountFields).map(([nativeField, savedField]) => [nativeField, credential[savedField] ?? null]));
  for (const value of Object.values(expected)) if (value !== null && (typeof value !== 'string' || value.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(value))) reject('authentication');
  return expected;
}

export function acknowledgeAccount(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['cached_token', 'grok.com', 'oidc'].includes(value.methodId)) reject('authentication');
  for (const key of Object.keys(accountFields)) if ((value[key] ?? null) !== expected[key]) reject('authentication');
  return value.methodId;
}

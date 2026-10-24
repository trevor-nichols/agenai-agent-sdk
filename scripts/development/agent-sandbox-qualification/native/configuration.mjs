// ------------------------------------------------------------------------------------------------
//                configuration.mjs - Explicit installed native qualification admission
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { parseEnv } from 'node:util';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/native/run.mjs --mode native-initialize --manifest /absolute/native.json --consumer /absolute/installed/consumer --output /new/absolute/output
  node scripts/development/agent-sandbox-qualification/native/run.mjs --mode live --manifest /absolute/native.json --consumer /absolute/installed/consumer --output /new/absolute/output

The explicit manifest selects one local Engine, exact guest image and Grok build.
Initialize is offline and never reads credentials or starts a model turn. Live
reads only the selected XAI_API_KEY from its bounded dotenv source, injects that
key into fresh guest processes, and permits four turns without inference replay.
The retained complete ten-package MS006 consumer is required. Output must be new.
`;

/** @typedef {'native-initialize' | 'live'} QualificationMode */
/** @typedef {{kind: 'dotenv', path: string, key: 'XAI_API_KEY'}} CredentialReference */
/** @typedef {{format: 'agenai.sandbox-native-manifest.v1', engine: string, imageDigest: string,
 * user: {uid: number, gid: number}, harness: {name: 'grok', version: '1.0.62', sha256: string, executable: '/usr/local/bin/grok'},
 * model: 'grok-4.3', reasoning: 'low', credential?: CredentialReference}} NativeManifest */
/** @typedef {{mode: QualificationMode, manifestPath: string, consumer: string, output: string}} Invocation */

export const harnessSha256 = '2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {unknown} error @param {number} depth @returns {object} */
export function safeError(error, depth = 0) {
  return { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name) ? error.name : 'Error',
    messageSha256: sha256(error instanceof Error ? error.message : String(error)),
    ...(depth < 4 && error instanceof Error && error.cause !== undefined ? { cause: safeError(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.slice(0, 8).map((entry) => safeError(entry, depth + 1)) } : {}) };
}

/** @param {string} path */
export function absolutePath(path) {
  assert(typeof path === 'string' && path.length > 1 && path.length <= 4096 && !path.includes('\0')
    && isAbsolute(path) && normalize(path) === path && !path.endsWith('/'), 'Canonical absolute path required.');
  return path;
}

/** @param {string} root @param {string} target */
export function within(root, target) {
  const local = relative(root, target);
  return local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

/** @param {string} path @param {number} ceiling */
export async function boundedFile(path, ceiling) {
  const entry = await lstat(path);
  assert(entry.isFile() && !entry.isSymbolicLink() && entry.size <= ceiling, 'Bounded regular file required.');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    assert(before.isFile() && before.dev === entry.dev && before.ino === entry.ino && before.size <= ceiling, 'File identity changed before read.');
    const bytes = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    assert(total <= ceiling && total === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.ctimeMs === before.ctimeMs, 'File changed during bounded read.');
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}

/** @param {string[]} argv @returns {Invocation} */
export function parseArguments(argv) {
  const args = new Map();
  assert(argv.length === 8, 'Exactly --mode, --manifest, --consumer and --output are required.');
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(['--mode', '--manifest', '--consumer', '--output'].includes(key) && !args.has(key)
      && typeof value === 'string' && !value.startsWith('--'), 'Unknown, repeated or missing argument.');
    args.set(key, value);
  }
  const mode = args.get('--mode');
  assert(mode === 'native-initialize' || mode === 'live', 'Mode must be native-initialize or live.');
  return { mode, manifestPath: absolutePath(args.get('--manifest')), consumer: absolutePath(args.get('--consumer')),
    output: absolutePath(args.get('--output')) };
}

/** @param {string} path @param {QualificationMode} mode @returns {Promise<NativeManifest>} */
export async function readManifest(path, mode) {
  const value = JSON.parse((await boundedFile(absolutePath(path), 16_384)).toString('utf8'));
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Native manifest object required.');
  assert.deepEqual(Object.keys(value).sort(), ['format', 'engine', 'imageDigest', 'user', 'harness', 'model', 'reasoning',
    ...(Object.hasOwn(value, 'credential') ? ['credential'] : [])].sort(), 'Unknown or missing native manifest field.');
  assert.equal(value.format, 'agenai.sandbox-native-manifest.v1');
  assert(typeof value.engine === 'string' && value.engine.length <= 512 && /^unix:\/\/\/[a-zA-Z0-9_.\-/]+$/u.test(value.engine), 'Explicit local Engine required.');
  absolutePath(value.engine.slice(7));
  assert.match(value.imageDigest, /^sha256:[a-f0-9]{64}$/u, 'Exact image digest required.');
  assert.deepEqual(Object.keys(value.user).sort(), ['gid', 'uid']);
  for (const id of [value.user.uid, value.user.gid]) assert(Number.isInteger(id) && id >= 1 && id <= 262_143, 'Non-root numeric guest user required.');
  assert.deepEqual(value.harness, { name: 'grok', version: '1.0.62', sha256: harnessSha256, executable: '/usr/local/bin/grok' }, 'Exact qualified harness required.');
  assert.equal(value.model, 'grok-4.3');
  assert.equal(value.reasoning, 'low');
  if (value.credential !== undefined) {
    assert.deepEqual(Object.keys(value.credential).sort(), ['key', 'kind', 'path']);
    assert.equal(value.credential.kind, 'dotenv');
    assert.equal(value.credential.key, 'XAI_API_KEY');
    absolutePath(value.credential.path);
  }
  assert(mode !== 'live' || value.credential !== undefined, 'Live qualification requires an explicit credential reference.');
  return value;
}

/** @param {string} path */
export async function physicalDirectory(path) {
  absolutePath(path);
  const entry = await lstat(path);
  assert(entry.isDirectory() && !entry.isSymbolicLink() && await realpath(path) === path, 'Physical absolute directory required.');
}

/** @param {CredentialReference} reference */
export async function readSelectedCredential(reference) {
  const selected = parseEnv((await boundedFile(reference.path, 1024 * 1024)).toString('utf8'))[reference.key];
  assert(typeof selected === 'string' && selected.length >= 1 && Buffer.byteLength(selected) <= 16_384
    && !/[\0\r\n]/u.test(selected), 'Selected credential is absent or invalid.');
  return selected;
}

// ------------------------------------------------------------------------------------------------
//                filesystem.ts - Qualified local directory and retained file identities
// ------------------------------------------------------------------------------------------------

import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail } from './errors.js';

interface Identity { readonly dev: bigint; readonly ino: bigint }
const allowedFiles = new Set(['owner.sqlite', 'owner.sqlite-journal', 'task.sqlite', 'task.sqlite-wal', 'task.sqlite-shm']);

function identity(path: string, directory: boolean): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)
    || (!directory && stat.nlink !== 1n)) fail('store_failed', 'The reference store requires an owned private directory and regular private files.');
  return { dev: stat.dev, ino: stat.ino };
}

function equal(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino; }

export function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export interface ReferenceFiles {
  readonly root: string;
  readonly initial: boolean;
  readonly ownerPath: string;
  readonly taskPath: string;
  assertCurrent(): void;
  captureAuxiliary(): void;
}

export function prepareReferenceFiles(input: string, options: Readonly<{ existingOnly?: boolean }> = {}): ReferenceFiles {
  if (process.version !== 'v24.18.0' || process.versions.sqlite !== '3.53.1' || process.platform !== 'linux') {
    fail('store_failed', 'This reference is qualified only on Linux with Node 24.18.0 and SQLite 3.53.1.');
  }
  const root = resolve(input);
  if (!existsSync(root) && options.existingOnly) fail('store_failed', 'Offline migration requires an existing reference store.');
  if (!existsSync(root)) {
    if (realpathSync(dirname(root)) !== dirname(root)) fail('store_failed', 'The store parent must have a stable canonical path.');
    mkdirSync(root, { mode: 0o700 });
    syncDirectory(dirname(root));
  }
  if (realpathSync(root) !== root || statfsSync(root, { bigint: true }).type !== 0xef53n) {
    fail('store_failed', 'The reference requires a canonical directory on the qualified local filesystem.');
  }
  const rootIdentity = identity(root, true);
  const entries = readdirSync(root);
  if (entries.some((file) => !allowedFiles.has(file))) fail('store_failed', 'The dedicated store directory contains an unfamiliar file.');
  for (const file of entries) identity(join(root, file), false);
  const ownerPath = join(root, 'owner.sqlite');
  const taskPath = join(root, 'task.sqlite');
  const initial = !existsSync(ownerPath) && !existsSync(taskPath);
  if (!initial && (!existsSync(ownerPath) || !existsSync(taskPath))) fail('store_failed', 'The reference store initialization is incomplete.');
  if (initial && options.existingOnly) fail('store_failed', 'Offline migration requires initialized reference databases.');
  if (initial) {
    if (entries.length !== 0) fail('store_failed', 'Initial reference store creation requires an empty dedicated directory.');
    for (const path of [ownerPath, taskPath]) {
      const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    syncDirectory(root);
  }
  const identities = new Map([[ownerPath, identity(ownerPath, false)], [taskPath, identity(taskPath, false)]]);
  const assertCurrent = () => {
    if (realpathSync(root) !== root || !equal(rootIdentity, identity(root, true))) fail('owner_lost', 'The reference store directory changed.');
    for (const [path, retained] of identities) {
      if (!existsSync(path) || !equal(retained, identity(path, false))) fail('owner_lost', 'A retained reference database file changed.');
    }
    for (const file of readdirSync(root)) {
      if (!allowedFiles.has(file)) fail('owner_lost', 'An unfamiliar file appeared in the reference store.');
      identity(join(root, file), false);
    }
  };
  return { root, initial, ownerPath, taskPath, assertCurrent, captureAuxiliary() {
    assertCurrent();
    for (const name of ['task.sqlite-wal', 'task.sqlite-shm']) {
      const path = join(root, name);
      if (existsSync(path) && !identities.has(path)) identities.set(path, identity(path, false));
    }
    syncDirectory(root);
  } };
}

// ------------------------------------------------------------------------------------------------
//                prepare.ts - Explicit offline native credential bootstrap source preparation
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { SANDBOX_CREDENTIAL_DIRECTORY, SANDBOX_CREDENTIAL_EXECUTABLE, SANDBOX_CREDENTIAL_PROTOCOL } from './protocol.js';
import type { SandboxCredentialBootstrapPreparation, SandboxCredentialBootstrapPreparationOptions } from './types.js';

const assetNames = Object.freeze(['bootstrap.c', 'protocol.h']);
const instructions = [
  '# Credential bootstrap build instructions', '',
  'Build explicitly with a trusted, caller-selected Linux C toolchain for the workload architecture.',
  'The preparation function runs no commands and acquires no compiler, image or dependency.',
  'From this directory, compile the fixed source and header:', '',
  '    cc -std=c17 -O2 -static -Wall -Wextra -Werror -Wformat=2 -Wconversion -fno-ident bootstrap.c -o agenai-credential-bootstrap', '',
  'Install the resulting executable in the workload image with mode 0555.',
  'The workload must run as its non-root guest user and provide a private mode-0700 /home/sandbox.',
  'The credential directory must be absent before launch. Never add credential bytes to this context.',
  '',
].join('\n');

export async function prepareSandboxCredentialBootstrap(
  options: SandboxCredentialBootstrapPreparationOptions,
): Promise<SandboxCredentialBootstrapPreparation> {
  const { directory } = options;
  if (typeof directory !== 'string' || directory.length > 4096 || !isAbsolute(directory) || normalize(directory) !== directory
    || directory.endsWith('/') || /[\u0000-\u001f\u007f]/u.test(directory)) {
    throw new TypeError('Credential bootstrap preparation requires a canonical fresh absolute directory.');
  }
  const parent = dirname(directory);
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) {
    throw new TypeError('Credential bootstrap preparation requires a physical parent directory.');
  }
  const artifacts = await Promise.all(assetNames.map(async (path) => {
    const bytes = await readFile(new URL(`../../../native/credentials/${path}`, import.meta.url));
    if (bytes.length > 64 * 1024) throw new TypeError('Credential bootstrap source exceeds its artifact bound.');
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const files = Object.freeze(artifacts.map(({ path, sha256 }) => Object.freeze({ path, sha256 })));
  const sourceDigest = `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  const result: SandboxCredentialBootstrapPreparation = Object.freeze({
    protocol: SANDBOX_CREDENTIAL_PROTOCOL, guestDirectory: SANDBOX_CREDENTIAL_DIRECTORY,
    executableName: SANDBOX_CREDENTIAL_EXECUTABLE, directory, sourceDigest, files,
  });
  await mkdir(directory, { mode: 0o700 });
  for (const artifact of artifacts) await writeFile(join(directory, artifact.path), artifact.bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'BUILDING.md'), instructions, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}

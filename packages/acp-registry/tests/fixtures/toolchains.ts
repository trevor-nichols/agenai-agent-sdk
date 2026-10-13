import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AcpInspectedToolchain, AcpToolchainLocation } from '../../src/node/install/contracts.js';
import { inspectAcpToolchains } from '../../src/node/install/tools/inspect.js';

async function findExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  throw new Error(`The real offline installation fixture requires ${name} on the test host PATH.`);
}

/** Discovery is test-only; production always receives caller-selected absolute tool locations. */
export async function fixtureToolchains(kind: 'npx' | 'uvx', workRoot: string): Promise<readonly AcpInspectedToolchain[]> {
  const toolchains: AcpToolchainLocation[] = kind === 'npx'
    ? [{ kind: 'node', path: await realpath(process.execPath) }, { kind: 'npm', path: await findExecutable('npm') }]
    : [{ kind: 'python', path: await findExecutable('python3') }, { kind: 'uv', path: await findExecutable('uv') }];
  return inspectAcpToolchains({ toolchains, workRoot });
}

// ------------------------------------------------------------------------------------------------
//                darwinSpill.ts - Own-process lsof field boundary and actual spill identity matching
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface SpillFileIdentity {
  readonly path: string;
  readonly descriptor: number;
  readonly device: string;
  readonly inode: string;
}

interface Descriptor {
  readonly descriptor: number;
  readonly device: string;
  readonly inode: string;
  readonly links: number;
  readonly bytes: number;
  readonly target: string;
}

function decimal(value: string | undefined): number {
  assert(value !== undefined && /^\d+$/u.test(value), 'Missing or malformed lsof numeric field.');
  const result = Number(value);
  assert(Number.isSafeInteger(result), 'Unrepresentable lsof numeric field.');
  return result;
}

/** lsof -F0 terminates fields with NUL and process/file sets with NL. */
export function parseLsofDescriptors(output: string, pid: number): readonly Descriptor[] {
  assert(Buffer.byteLength(output) <= 256 * 1024, 'lsof observation exceeded its control-output bound.');
  const result: Descriptor[] = [];
  let processSeen = false;
  let file: Partial<Record<string, string>> | undefined;
  const finish = () => {
    if (!file) return;
    if (file.t === 'REG' && file.f !== undefined && /^\d+$/u.test(file.f)) {
      assert(file.D !== undefined && /^0x[\da-f]+$/iu.test(file.D), 'Missing or malformed lsof device.');
      assert(file.i !== undefined && /^\d+$/u.test(file.i), 'Missing or malformed lsof inode.');
      result.push({ descriptor: decimal(file.f), device: BigInt(file.D).toString(), inode: BigInt(file.i).toString(),
        links: decimal(file.k), bytes: decimal(file.s), target: file.n ?? '' });
    }
    file = undefined;
  };
  if (output === '') return result;
  assert(output.endsWith('\0\n'), 'Truncated lsof field output.');
  for (const token of output.split('\0')) {
    const field = token.startsWith('\n') ? token.slice(1) : token;
    if (field === '') continue;
    const name = field[0];
    const value = field.slice(1);
    if (name === 'p') {
      finish();
      assert.equal(decimal(value), pid, 'lsof returned a different process.');
      processSeen = true;
    } else if (name === 'f') {
      assert(processSeen, 'lsof file precedes process identity.');
      finish();
      file = { f: value };
    } else {
      assert(file && name !== undefined && ['D', 'i', 'k', 'n', 's', 't'].includes(name), 'Unexpected lsof field.');
      assert(!Object.hasOwn(file, name), 'Repeated lsof field.');
      file[name] = value;
    }
  }
  finish();
  return result;
}

export function capturedSpillFiles(input: unknown, root: string): readonly SpillFileIdentity[] {
  assert(input && typeof input === 'object' && 'kind' in input && input.kind === 'spill_held'
    && 'files' in input && Array.isArray(input.files) && input.files.length === 4, 'Child must report four actual pre-unlink identities.');
  const files = input.files.map((file: unknown) => {
    assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string'
      && file.path.startsWith(`${root}/agenai-metadata-`)
      && 'descriptor' in file && typeof file.descriptor === 'number' && Number.isSafeInteger(file.descriptor) && file.descriptor >= 0
      && 'device' in file && typeof file.device === 'string' && /^\d+$/u.test(file.device)
      && 'inode' in file && typeof file.inode === 'string' && /^\d+$/u.test(file.inode), 'Invalid native spill identity.');
    return { path: file.path, descriptor: file.descriptor, device: file.device, inode: file.inode };
  });
  assert.equal(new Set(files.map((file) => file.descriptor)).size, 4, 'Captured descriptors must be distinct.');
  assert.equal(new Set(files.map((file) => `${file.device}:${file.inode}`)).size, 4, 'Captured files must be distinct.');
  return files;
}

export async function darwinSpillDescriptors(pid: number, files: readonly SpillFileIdentity[]): Promise<readonly Descriptor[]> {
  let stdout: string;
  try {
    const observation = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '+L1', '-F0pfDiknst'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 });
    assert.equal(observation.stderr, '', 'lsof warnings prevent a complete observation.');
    stdout = observation.stdout;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1
      && 'stdout' in error && error.stdout === '' && 'stderr' in error && error.stderr === '') return [];
    throw error;
  }
  // Deleted Darwin paths may be absent or mount-only: correlate actual pre-unlink fstat identities.
  const observations = parseLsofDescriptors(stdout, pid);
  return files.flatMap((file) => observations.filter((value) => value.descriptor === file.descriptor
    && value.device === file.device && value.inode === file.inode));
}

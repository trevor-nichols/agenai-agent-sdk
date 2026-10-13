import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { NativeInputError, semanticDigest, textValue } from './json.js';

export function assertSeparateOutput(output: string, inputs: readonly string[]): void {
  if (!isAbsolute(output) || resolve(output) !== output || output === '/') throw new NativeInputError('output_path_invalid');
  for (const input of inputs) {
    const path = resolve(input);
    for (const [base, target] of [[output, path], [path, output]] as const) {
      const relation = relative(base, target);
      if (relation === '' || (!relation.startsWith('../') && !isAbsolute(relation))) throw new NativeInputError('output_overlaps_input');
    }
  }
}

/** Reserve a new physical destination; the final report is atomically published within it. */
export interface NativeOutputDirectory { readonly path: string; assertCurrent(): Promise<void> }

export async function reserveNativeOutput(output: string): Promise<NativeOutputDirectory> {
  textValue(output);
  if (await realpath(dirname(output)) !== dirname(output)) throw new NativeInputError('output_parent_invalid');
  await mkdir(output, { mode: 0o700 });
  if (await realpath(output) !== output) throw new NativeInputError('output_identity_changed');
  const identity = await lstat(output);
  return { path: output, async assertCurrent() {
    const actual = await lstat(output);
    if (!actual.isDirectory() || actual.dev !== identity.dev || actual.ino !== identity.ino || await realpath(output) !== output) {
      throw new NativeInputError('output_identity_changed');
    }
  } };
}

export async function publishNativeReport(destination: NativeOutputDirectory, filename: 'discovery.json' | 'evidence.json', value: object): Promise<void> {
  await destination.assertCurrent();
  const output = destination.path;
  const body = { ...value, evidenceDigest: semanticDigest(value) };
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  const maximum = filename === 'discovery.json' ? 524_288 : 1_048_576;
  if (bytes.length > maximum) throw new NativeInputError('evidence_byte_limit');
  const temporary = join(output, `.pending-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  // Both names are static children of the newly owned directory, never report-controlled paths.
  await destination.assertCurrent();
  await link(temporary, join(output, filename));
  await unlink(temporary);
  const directory = await open(output, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

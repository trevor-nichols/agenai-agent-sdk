import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertSeparateOutput, publishNativeReport, reserveNativeOutput } from '../artifacts.js';
import { parseNativeJson, readNativeInput } from '../json.js';

const execute = promisify(execFile);
const fileDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('native input rejects ambiguous JSON, excessive nesting and nonfinite numbers', () => {
  assert.deepEqual(parseNativeJson('{"value":[true,null,1,"x"]}'), { value: [true, null, 1, 'x'] });
  const invalid = [
    ['{"a":1,"\\u0061":2}', 'input_json_duplicate_or_unsafe_key'],
    ['{"nested":{"constructor":1}}', 'input_json_duplicate_or_unsafe_key'],
    ['['.repeat(18) + '0' + ']'.repeat(18), 'input_json_limit'],
    ['{"value":1e999}', 'evidence_value_invalid'],
    ['{"value":1,}', 'input_json_invalid'],
  ] as const;
  for (const [value, code] of invalid) assert.throws(() => parseNativeJson(value), { message: code });
});

test('input bytes are bounded and independently hashed before parsing, with no symlink reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-input-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'input.json');
  await writeFile(path, 'not json');
  await assert.rejects(readNativeInput(path, fileDigest('different'), 64), { message: 'input_digest_mismatch' });
  await assert.rejects(readNativeInput(path, fileDigest('not json'), 64), { message: 'input_json_invalid' });
  await assert.rejects(readNativeInput(path, fileDigest('not json'), 4), { message: 'input_file_limit' });
  await symlink(path, join(root, 'alias.json'));
  await assert.rejects(readNativeInput(join(root, 'alias.json'), fileDigest('not json'), 64), { message: 'input_path_invalid' });
  await writeFile(path, '{"ok":true}');
  assert.deepEqual(await readNativeInput(path, fileDigest('{"ok":true}'), 64), { value: { ok: true }, fileDigest: fileDigest('{"ok":true}') });
});

test('report publication preserves existing files and reserves private nonoverlapping output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-publication-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => assertSeparateOutput(root, [join(root, 'credential')]), { message: 'output_overlaps_input' });
  const output = join(root, 'output');
  assert.doesNotThrow(() => assertSeparateOutput(output, [join(root, 'input.json')]));
  const destination = await reserveNativeOutput(output);
  await assert.rejects(reserveNativeOutput(output), { code: 'EEXIST' });
  await publishNativeReport(destination, 'discovery.json', { outcome: 'blocked' });
  const report = join(output, 'discovery.json');
  const original = await readFile(report, 'utf8');
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(report)).mode & 0o777, 0o600);
  await assert.rejects(publishNativeReport(destination, 'discovery.json', { outcome: 'qualified' }), { code: 'EEXIST' });
  assert.equal(await readFile(report, 'utf8'), original);
});

test('CLI rejects invalid flags, wrong hashes and malformed candidates before reserving output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'candidate.json');
  await writeFile(manifest, '{}');
  const output = join(root, 'evidence');
  const common = ['discover', '--manifest', manifest, '--manifest-sha256', fileDigest('{}'), '--launch', 'direct', '--output', output];
  const cli = fileURLToPath(new URL('../../native.ts', import.meta.url));
  for (const [args, error] of [
    [[...common, '--launch', 'registry'], 'arguments_invalid'],
    [[...common, '--allow-live-inference'], 'arguments_invalid'],
    [common.map((part) => part === fileDigest('{}') ? fileDigest('different') : part), 'input_digest_mismatch'],
    [common, 'input_fields_invalid'],
  ] as const) {
    await assert.rejects(execute(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      env: { PATH: '/usr/bin:/bin', XAI_API_KEY: 'never-print-this-test-value' }, timeout: 10_000, maxBuffer: 8192,
    }), (failure: unknown) => {
      const result = failure as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), { error });
      return true;
    });
  }
  assert.deepEqual(await readdir(root), ['candidate.json']);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Darwin arm64 fixture required.');
if (process.argv.length !== 3) throw new Error('Provide a fresh output directory beneath a secure physical parent.');
const output = resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const native = join(root, 'packages/ai/sandbox-docker/native/desktop');
const common = ['-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-I', join(native, 'recovery')];
const files = join(output, 'files.o');
execFileSync('/usr/bin/clang', [...common, '-Dfstatat=diagnostic_fstatat', '-Dlstat=diagnostic_lstat', '-c', join(native, 'recovery/files.c'), '-o', files],
  { stdio: 'pipe', timeout: 30_000 });
const executable = join(output, 'log-rotation');
execFileSync('/usr/bin/clang', [...common, join(root, 'packages/ai/sandbox-docker/tests/native/desktop-recovery/log-rotation.c'),
  files, join(native, 'recovery/wire.c'), join(native, 'coordinator/authority.c'), join(native, 'coordinator/storage.c'), '-o', executable],
{ stdio: 'pipe', timeout: 30_000 });
const results = [];
for (const scenario of ['held-rename', 'held-delete', 'held-missing', 'unheld-rename', 'unheld-delete', 'multi-gap', 'multi-pass-gap', 'truncated', 'temporary-churn', 'churn']) {
  const scratch = join(output, scenario);
  mkdirSync(join(scratch, 'Library/Containers/com.docker.docker/Data/log/vm'), { recursive: true, mode: 0o700 });
  const transcript = execFileSync(executable, [scenario, scratch], { encoding: 'utf8', timeout: 15_000 });
  writeFileSync(join(scratch, 'transcript.jsonl'), transcript, { flag: 'wx', mode: 0o600 });
  const records = transcript.trim().split('\n').map((line) => JSON.parse(line));
  const chunks = records.filter((record) => record.kind === 'log_bytes');
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.bytesBase64, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), chunk.sha256);
    assert.equal(BigInt(chunk.end) - BigInt(chunk.start), BigInt(bytes.length));
  }
  const bytes = chunks.map((chunk) => Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).filter(Boolean).sort();
  if (scenario === 'temporary-churn') assert.deepEqual(bytes, ['rotation-tail\n']);
  else if (scenario === 'held-missing') assert.deepEqual(bytes, ['old-tail\n', 'rotation-tail\n']);
  else if (scenario.startsWith('held-')) assert.deepEqual(bytes, ['new-head\n', 'old-tail\n', 'rotation-tail\n']);
  else if (scenario === 'unheld-rename') assert.deepEqual(bytes, ['fresh-bytes\n']);
  else assert.deepEqual(bytes, []);
  results.push(records.at(-1));
}
writeFileSync(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ results, output }));

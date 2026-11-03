import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Darwin arm64 fixture required.');
if (process.argv.length !== 3) throw new Error('Provide a fresh, exclusively owned output directory.');
const output = resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const native = join(root, 'packages/ai/sandbox-docker/native/desktop');
const common = ['-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-I', join(native, 'recovery'),
  '-DAGENAI_RECOVERY_PROFILE_DIGEST="0000000000000000000000000000000000000000000000000000000000000000"'];
const storage = join(output, 'storage.o');
execFileSync('/usr/bin/clang', [...common, '-Dcoordinator_read=diagnostic_storage_read', '-c',
  join(native, 'coordinator/storage.c'), '-o', storage], { stdio: 'pipe', timeout: 30_000 });
const executable = join(output, 'stage-construction');
execFileSync('/usr/bin/clang', [...common, join(root, 'packages/ai/sandbox-docker/tests/native/desktop-recovery/stage-construction.c'),
  storage, join(native, 'coordinator/authority.c'), ...['wire', 'evidence', 'observation'].map((name) => join(native, `recovery/${name}.c`)),
  '-o', executable], { stdio: 'pipe', timeout: 30_000 });
const results = [];
for (const scenario of ['retry', 'exec', 'auxiliary']) {
  const key = randomBytes(32).toString('hex');
  const base = join(homedir(), 'Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1');
  const paths = ['lock', 'state', 'next', 'recovery-evidence-v1'].map((suffix) => join(base, `${key}.${suffix}`));
  for (const path of paths) {
    try { lstatSync(path); throw new Error(`Synthetic scope already exists: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const scratch = join(output, scenario); mkdirSync(scratch, { mode: 0o700 });
  try {
    const transcript = execFileSync(executable, [scenario, key, scratch], { encoding: 'utf8', timeout: 25_000 });
    writeFileSync(join(scratch, 'transcript.jsonl'), transcript, { flag: 'wx', mode: 0o600 });
    const records = transcript.trim().split('\n').map((line) => JSON.parse(line));
    const result = records.at(-1);
    if (scenario === 'auxiliary') {
      const armed = JSON.parse(records.find((record) => record.diagnosticRetryOk).nativeReply.text);
      const stopped = JSON.parse(records.find((record) => record.diagnosticStopped).nativeReply.text);
      assert.equal(armed.watchCount, 2);
      assert.deepEqual(armed.producers.map((producer) => producer.diagnosticOnlyPid), result.actors.slice(0, 2));
      assert.deepEqual(stopped.joined.map((producer) => producer.diagnosticOnlyPid), result.actors);
    }
    results.push(result);
  } finally {
    for (const path of paths) rmSync(path, { recursive: path.endsWith('.recovery-evidence-v1'), force: true });
  }
}
writeFileSync(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ results, output }));

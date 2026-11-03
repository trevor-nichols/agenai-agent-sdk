import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Darwin arm64 fixture required.');
if (process.argv.length !== 3) throw new Error('Provide a fresh, exclusively owned output directory.');
const output = resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const native = join(root, 'packages/ai/sandbox-docker/native/desktop');
const fixture = join(root, 'packages/ai/sandbox-docker/tests/native/desktop-recovery/process-epochs.c');
const common = ['-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-I', join(native, 'recovery')];
const object = join(output, 'processes.o');
execFileSync('/usr/bin/clang', [...common, '-Dproc_pidpath=diagnostic_pidpath', '-Dproc_listpids=diagnostic_listpids',
  '-c', join(native, 'recovery/processes.c'), '-o', object], { stdio: 'pipe', timeout: 30_000 });
const executable = join(output, 'process-epochs');
execFileSync('/usr/bin/clang', [...common, fixture, object, join(native, 'recovery/wire.c'),
  join(native, 'coordinator/authority.c'), join(native, 'coordinator/storage.c'), '-o', executable], { stdio: 'pipe', timeout: 30_000 });
const results = ['exec', 'exit', 'stable-valid', 'stable-invalid', 'installation-invalid', 'unknown', 'bound'].map((scenario) =>
  JSON.parse(execFileSync(executable, [scenario], { encoding: 'utf8', timeout: 15_000 })));
writeFileSync(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ results, output }));

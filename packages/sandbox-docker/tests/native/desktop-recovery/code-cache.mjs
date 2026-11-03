import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Darwin arm64 fixture required.');
if (process.argv.length !== 3) throw new Error('Provide a fresh, exclusively owned output directory.');
const output = resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const native = join(root, 'packages/ai/sandbox-docker/native/desktop');
const profile = join(output, 'owned-profile.h');
writeFileSync(profile, `#define AGENAI_DESKTOP_RECOVERY_PROFILE_H
#define RECOVERY_APPLICATION ${JSON.stringify(output)}
#define RECOVERY_TEAM "9BNSXJN65R"
#define RECOVERY_COMPONENTS_SHA "unused"
#define RECOVERY_IMAGE_ROWS { "owned-image", "plugin_init", "cb084941913b70406892c7f4ab72eeeb56a39cf86fe0f6f6e2f0d78b12a251d2", "docker-init" },
`, { flag: 'wx', mode: 0o600 });
const executable = join(output, 'code-cache');
execFileSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Wformat=2', '-Werror', '-O2', '-I', join(native, 'recovery'),
  '-include', profile, '-DAGENAI_RECOVERY_PROFILE_DIGEST="0000000000000000000000000000000000000000000000000000000000000000"',
  join(root, 'packages/ai/sandbox-docker/tests/native/desktop-recovery/code-cache.c'),
  ...['authority', 'storage'].map((name) => join(native, `coordinator/${name}.c`)),
  ...['wire', 'code', 'processes', 'files', 'endpoint', 'evidence', 'observation'].map((name) => join(native, `recovery/${name}.c`)),
  '-framework', 'Security', '-framework', 'CoreFoundation', '-lbsm', '-o', executable], { stdio: 'pipe', timeout: 30_000 });
const results = [];
for (const scenario of ['stable', 'restore-mtime', 'replace']) {
  for (const filename of ['owned-image', 'replacement']) {
    copyFileSync('/Applications/Docker.app/Contents/Resources/cli-plugins/docker-init', join(output, filename));
    chmodSync(join(output, filename), 0o600);
  }
  results.push(JSON.parse(execFileSync(executable, [scenario], { encoding: 'utf8', timeout: 15_000 })));
}
writeFileSync(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ results, output }));

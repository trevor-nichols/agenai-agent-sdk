// Explicit offline preparation. No import-time compilation, download or Docker operation.
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepare(attempt) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('requires_native_darwin_arm64');
  const physical = await realpath(attempt);
  if (!physical.startsWith('/private/tmp/agenai-ms001-exclusion-')) throw new Error('requires_unique_research_scratch');
  const root = join(physical, 'canonical-research-root');
  await mkdir(root, { mode: 0o700 });
  const source = fileURLToPath(new URL('./lock-holder.c', import.meta.url));
  const binary = join(physical, 'lock-holder');
  const compiler = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    `-DRESEARCH_ROOT=${JSON.stringify(root)}`, source, '-o', binary], { encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error(`offline_compilation_failed:${compiler.stderr}`);
  // This row requires already installed Rosetta. Never request installation or download it.
  await access('/Library/Apple/usr/libexec/oah/libRosettaRuntime');
  const translatedBinary = join(physical, 'lock-holder-x86_64');
  const translatedCompiler = spawnSync('/usr/bin/clang', ['-arch', 'x86_64', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    `-DRESEARCH_ROOT=${JSON.stringify(root)}`, source, '-o', translatedBinary], { encoding: 'utf8' });
  if (translatedCompiler.status !== 0) throw new Error(`offline_x86_compilation_failed:${translatedCompiler.stderr}`);
  const copies = [];
  for (const name of ['copy-a', 'copy-b']) {
    const directory = join(physical, name);
    await mkdir(directory);
    await copyFile(fileURLToPath(new URL('./controller.mjs', import.meta.url)), join(directory, 'controller.mjs'));
    await copyFile(binary, join(directory, 'lock-holder'));
    copies.push({ directory, binary: join(directory, 'lock-holder') });
  }
  const manifest = { researchOnly: true, root, binary, translatedBinary, copies, sourceBytes: (await readFile(source)).length };
  await writeFile(join(physical, 'preparation.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

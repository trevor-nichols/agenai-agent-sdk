import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startNativeServer } from '../src/node/server.js';

const FIXTURE = fileURLToPath(new URL('./support/native-server.mjs', import.meta.url));

async function launch(t: test.TestContext, mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'oc-server-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'opencode');
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  await chmod(executable, 0o700);
  const record = join(directory, 'record.json');
  const environment = { PATH: '/nonexistent', HOME: directory, FIXTURE_MODE: mode, FIXTURE_RECORD: record };
  return { directory, record, start: () => startNativeServer({ executable, directory, environment }) };
}

const gone = (pid: number) => {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
};

test('the server receives exactly the launch contract and announces its loopback origin', async (t) => {
  const fixture = await launch(t, 'ok');
  const server = await fixture.start();
  t.after(() => server.close());
  assert.equal(server.url, 'http://127.0.0.1:4096');
  const record = JSON.parse(await readFile(fixture.record, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> };
  assert.deepEqual(record.argv, ['serve', '--stdio', '--port', '0', '--hostname', '127.0.0.1']);
  assert.equal(record.cwd.endsWith(fixture.directory.split('/').at(-1)!), true);
  assert.deepEqual(Object.keys(record.env).filter((key) => !['PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'].includes(key)).sort(), ['FIXTURE_MODE', 'FIXTURE_RECORD', 'HOME', 'PATH']);
  await server.close();
  await server.exited;
});

test('closing joins a descendant that outlives the server in its process group', async (t) => {
  const fixture = await launch(t, 'descendant');
  const server = await fixture.start();
  t.after(() => server.close());
  const child = Number(await readFile(`${fixture.record}.child`, 'utf8'));
  assert.equal(gone(child), false);
  await server.close();
  assert.equal(gone(child), true);
});

for (const mode of ['exit', 'foreign']) {
  test(`a server that ${mode === 'exit' ? 'exits before announcing' : 'announces a non-loopback origin'} is refused and joined`, async (t) => {
    const fixture = await launch(t, mode);
    await assert.rejects(fixture.start(), { name: 'NodeOpenCodeNativeFailure', stage: 'startup' });
  });
}

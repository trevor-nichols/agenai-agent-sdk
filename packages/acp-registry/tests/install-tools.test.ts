import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAcpInstallTool } from '../src/node/install/tools/run.js';
import { inspectAcpToolchains } from '../src/node/install/tools/inspect.js';
import { resolveAcpInstallationLimits } from '../src/node/install/limits.js';
import { AcpInstallationError } from '../src/node/install/errors.js';

const code = (expected: string) => (error: unknown) => error instanceof AcpInstallationError && error.code === expected;

test('tool execution supplies literal arguments and only the explicit environment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-tool-test-'));
  try {
    const arg = 'literal;$(never-execute) $HOME';
    const result = await runAcpInstallTool({ executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env}))', arg],
      cwd, env: { ACP_FIXTURE: 'explicit' }, timeoutMs: 5_000, maxOutputBytes: 8_192 });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { argv: [arg], env: { ACP_FIXTURE: 'explicit' } });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('real processes settle output, cancellation, deadline, spawn and exit failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-tool-test-'));
  const base = { executable: process.execPath, cwd, env: {}, timeoutMs: 5_000, maxOutputBytes: 128 };
  try {
    await assert.rejects(runAcpInstallTool({ ...base, args: ['-e', 'process.stdout.write("x".repeat(8192));setInterval(()=>{},1000)'] }), code('limit_exceeded'));
    await assert.rejects(runAcpInstallTool({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 }), code('timeout'));
    const controller = new AbortController();
    const running = runAcpInstallTool({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], signal: controller.signal });
    controller.abort();
    await assert.rejects(running, code('aborted'));
    await assert.rejects(runAcpInstallTool({ ...base, executable: join(cwd, 'missing'), args: [] }), code('tool_failed'));
    assert.equal((await runAcpInstallTool({ ...base, args: ['-e', 'process.exit(7)'] })).exitCode, 7);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('toolchain inspection measures a real executable and leaves no probe configuration behind', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-tool-test-'));
  try {
    const [node] = await inspectAcpToolchains({ toolchains: [{ kind: 'node', path: process.execPath }], workRoot: cwd });
    assert.equal(node?.version, process.versions.node);
    assert.match(node!.sha256, /^sha256:[a-f0-9]{64}$/u);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(cwd), []);
    await assert.rejects(inspectAcpToolchains({ toolchains: [{ kind: 'npm', path: process.execPath }], workRoot: cwd }), code('invalid_input'));
    await assert.rejects(inspectAcpToolchains({ toolchains: [{ kind: 'node', path: join(cwd, 'missing-runtime') }], workRoot: cwd }), code('toolchain_mismatch'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('installation resource limits are captured once and reject accessors and unbounded values', () => {
  let reads = 0;
  assert.throws(() => resolveAcpInstallationLimits({ get maxEntries() { reads++; return 1; } }), code('invalid_input'));
  assert.equal(reads, 0);
  assert.throws(() => resolveAcpInstallationLimits({ maxArtifactBytes: Infinity }), code('invalid_input'));
  const options = new Proxy({ maxEntries: 1 }, { get(target, key, receiver) { if (key === 'maxEntries') return Infinity; return Reflect.get(target, key, receiver); } });
  assert.equal(resolveAcpInstallationLimits(options).maxEntries, 1);
});


test('a deadline settles when an escaped descendant retains the tool stdout pipe', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-tool-pipes-'));
  const pidFile = join(cwd, 'descendant.pid');
  let descendant: number | undefined;
  try {
    const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
      writeFileSync(process.argv[1],String(child.pid));child.unref();`;
    const operation = runAcpInstallTool({ executable: process.execPath, args: ['-e', script, pidFile], cwd, env: {}, timeoutMs: 500, maxOutputBytes: 1024 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Tool deadline did not settle after inherited pipes escaped.')), 2000); });
    try { await assert.rejects(Promise.race([operation, bound]), code('timeout')); }
    finally { if (timer) clearTimeout(timer); }
    descendant = Number(await readFile(pidFile, 'utf8'));
    assert(Number.isSafeInteger(descendant) && descendant > 0, 'The fixture must actually spawn its detached descendant.');
  } finally {
    try { descendant = Number(await readFile(pidFile, 'utf8')); } catch { /* The tool can fail before spawning its descendant. */ }
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    await rm(cwd, { recursive: true, force: true });
  }
});

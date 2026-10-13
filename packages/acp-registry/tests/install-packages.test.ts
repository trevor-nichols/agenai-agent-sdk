import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNpm } from '../src/node/install/packages/npm.js';
import { prepareUv } from '../src/node/install/packages/uv.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { runAcpInstallTool } from '../src/node/install/tools/run.js';
import { openAcpInstallationStore } from '../src/node/install/index.js';
import { packageContext } from './fixtures/install-packages/index.js';

for (const kind of ['npx', 'uvx'] as const) {
  const prepare = kind === 'npx' ? prepareNpm : prepareUv;
  test(`${kind} publishes a verified locked installation and resolves an offline launch from its active reference`, async () => {
    const fixture = await packageContext(kind);
    try {
      const { context } = fixture;
      const store = await openAcpInstallationStore({ root: join(fixture.root, 'store'), limits: context.limits });
      const receipt = await store.install({ plan: context.plan, expectedPlanDigest: context.plan.digest,
        toolchains: context.toolchains.map(({ kind, path }) => ({ kind, path })), localArtifacts: context.localArtifacts, packageArtifacts: context.packageArtifacts });
      assert.deepEqual(receipt.prepared.packages, [
        { name: 'fixture-agent', version: '1.2.3', dependencies: ['fixture-dependency@4.5.6'] },
        { name: 'fixture-dependency', version: '4.5.6', dependencies: [] },
      ]);
      assert.deepEqual(receipt.prepared.verification, { expectedArtifactIntegrity: 'verified', dependencyClosure: 'verified', packageCommand: 'verified',
        toolchains: 'verified', reproducibility: 'locked-package-inputs', gaps: [] });
      assert.equal(receipt.prepared.resolvedLock!.content, context.plan.packageResolution!.dependencyLock!.content);
      assert(receipt.prepared.artifacts.every((artifact) => artifact.origin === 'local' && artifact.measuredSha256 === artifact.expectedSha256));
      assert(!receipt.payload.some((entry) => entry.path.includes('SCRIPT_RAN') || entry.path.includes('__pycache__')));
      const identity = { planDigest: context.plan.digest, installationId: receipt.installationId };
      const reference = await store.acquire({ ...identity, ownerId: 'offline-package-consumer' });
      const launch = await store.resolveLaunch(reference);
      const result = await runAcpInstallTool({ executable: launch.executable, args: launch.args, env: launch.env, cwd: fixture.root, timeoutMs: 5000, maxOutputBytes: 16 * 1024 });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { dependency: 'dependency-ok', args: ['literal;$(never-execute)', '--acp'], launch: 'launch-only',
        ...(kind === 'uvx' ? { command: 'native-fixture' } : {}) });
      assert.equal((await store.read(identity)).payloadDigest, receipt.payloadDigest);
      await store.release(reference);
    } finally { await fixture.cleanup(); }
  });

    test(`${kind} retains best-effort gaps and a portable resolved lock after an actual offline install`, async () => {
      const fixture = await packageContext(kind, { locked: false });
      try {
        const prepared = await prepare(fixture.context);
        assert.deepEqual(prepared.packages, [
          { name: 'fixture-agent', version: '1.2.3', dependencies: ['fixture-dependency@4.5.6'] },
          { name: 'fixture-dependency', version: '4.5.6', dependencies: [] },
        ]);
        assert.equal(prepared.verification.dependencyClosure, 'verified');
        assert.equal(prepared.verification.packageCommand, 'verified');
        assert.equal(prepared.verification.expectedArtifactIntegrity, 'verified');
        assert.equal(prepared.verification.reproducibility, 'incomplete');
        assert.deepEqual(prepared.verification.gaps, ['dependency-closure-missing']);
        assert.equal(prepared.artifacts.length, 2);
        assert(prepared.artifacts.every((artifact) => artifact.origin === 'local' && artifact.expectedSha256 === artifact.measuredSha256));
        assert(prepared.resolvedLock!.content.includes('fixture-dependency'));
        assert(!prepared.resolvedLock!.content.includes('file:'));
        assert(!prepared.resolvedLock!.content.includes(fixture.root));
        const retainedLock = join(fixture.context.payloadRoot, kind === 'npx' ? 'package-lock.json' : 'requirements.txt');
        assert.equal(await readFile(retainedLock, 'utf8'), prepared.resolvedLock!.content);
        const moved = join(fixture.root, 'published');
        await rename(fixture.context.payloadRoot, moved);
        assert.equal(prepared.launch.command.kind, 'toolchain');
        if (prepared.launch.command.kind !== 'toolchain') throw new Error('Expected an inspected runtime command.');
        const command = prepared.launch.command;
        const tool = prepared.toolchains.find((item) => item.kind === command.toolchain)!;
        const args = prepared.launch.args.map((argument) => argument.kind === 'literal' ? argument.value : join(moved, argument.path));
        const output = await runAcpInstallTool({ executable: tool.path, args, cwd: moved, env: prepared.launch.env, timeoutMs: 5000, maxOutputBytes: 16 * 1024 });
        assert.equal(output.exitCode, 0, output.stderr);
        const observed: unknown = JSON.parse(output.stdout);
        assert.deepEqual(observed, { dependency: 'dependency-ok', args: ['literal;$(never-execute)', '--acp'], launch: 'launch-only',
          ...(kind === 'uvx' ? { command: 'native-fixture' } : {}) });
      } finally { await fixture.cleanup(); }
    });

  test(`${kind} rejects a root artifact whose actual dependency requirement contradicts the planned closure`, async () => {
    const fixture = await packageContext(kind, { rootName: 'fixture-conflict' });
    try { await assert.rejects(prepare(fixture.context), (error: unknown) => error instanceof AcpInstallationError && error.code === 'tool_failed'); }
    finally { await fixture.cleanup(); }
  });

  test(`${kind} rejects an unrelated acquired package instead of retaining it as part of the agent closure`, async () => {
    const fixture = await packageContext(kind, { locked: false, extra: true });
    try { await assert.rejects(prepare(fixture.context), (error: unknown) => error instanceof AcpInstallationError && error.code === 'integrity_mismatch'); }
    finally { await fixture.cleanup(); }
  });

  test(`${kind} rejects a command not exported by the selected root package`, async () => {
    const fixture = await packageContext(kind, { command: 'not-a-package-command' });
    try { await assert.rejects(prepare(fixture.context), (error: unknown) => error instanceof AcpInstallationError && error.code === 'integrity_mismatch'); }
    finally { await fixture.cleanup(); }
  });
}

test('Python path initialization hooks cannot execute during inspection or enter the isolated launch profile', async () => {
  const fixture = await packageContext('uvx', { rootName: 'fixture-path-hook' });
  try { await assert.rejects(prepareUv(fixture.context), (error: unknown) => error instanceof AcpInstallationError && error.code === 'unsupported_format'); }
  finally { await fixture.cleanup(); }
});

test('an extensionless npm bin with an exact Node shebang launches through the selected runtime', async () => {
  const fixture = await packageContext('npx', { rootName: 'fixture-extensionless' });
  try {
    const prepared = await prepareNpm(fixture.context);
    const node = prepared.toolchains.find((item) => item.kind === 'node')!;
    const result = await runAcpInstallTool({ executable: node.path, args: prepared.launch.args.map((arg) => arg.kind === 'literal' ? arg.value : join(fixture.context.payloadRoot, arg.path)),
      env: prepared.launch.env, cwd: fixture.root, timeoutMs: 5000, maxOutputBytes: 16 * 1024 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { dependency: 'dependency-ok', args: ['literal;$(never-execute)', '--acp'], launch: 'launch-only' });
  } finally { await fixture.cleanup(); }
});

test('an extensionless npm bin cannot grant an unknown interpreter launch', async () => {
  const fixture = await packageContext('npx', { rootName: 'fixture-wrong-interpreter' });
  try { await assert.rejects(prepareNpm(fixture.context), (error: unknown) => error instanceof AcpInstallationError && error.code === 'unsupported_format'); }
  finally { await fixture.cleanup(); }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProviderSessionCleanupError } from '@agen-ai/agent-runtime';
import { NativeCleanupError } from '../launch.js';
import type { NativeExecutableLease, NativeLaunchCandidate, NativeProcessAllocation } from '../launch-contracts.js';
import { nativeGrokMappingFixtureCredential, probeNativeGrokStandardMapping, type NativeGrokModelFixture } from '../mapping-probe.js';

for (const behavior of ['opened-session', 'rejected-opening'] as const) {
  test(`mapping ${behavior} cleanup retains the real ACP producer until its retry succeeds`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-mapping-cleanup-'));
    const workingDirectory = join(root, 'work');
    await mkdir(workingDirectory, { mode: 0o700 });
    const receiptPath = join(root, 'process.json');
    const bytes = await readFile(process.execPath);
    const identity = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const candidate: NativeLaunchCandidate = {
      native: { ...identity, version: '1.0.50', target: 'linux-x86_64',
        installedCommandPath: process.execPath, inspectedExecutablePath: process.execPath },
      launch: { args: [] },
      upstreamArtifact: { ...identity, url: 'https://fixture.invalid/native', decoded: { ...identity, magicHex: '7f454c46' } },
      transformation: { recipe: 'gzip-single-member-stream-v1', decoderExecutable: '/unused/python', decoderExecutableSha256: '0'.repeat(64),
        pythonVersion: 'fixture', zlibCompileVersion: 'fixture', zlibRuntimeVersion: 'fixture', inputChunkBytes: 1,
        outputChunkBytes: 1, maxInputBytes: identity.bytes, maxOutputBytes: identity.bytes, plannedTimeoutMs: 1_000 },
    };
    const executable: NativeExecutableLease = { mode: 'direct', executable: process.execPath, identity,
      evidence: { mode: 'direct', identity, allocationId: randomUUID() },
      async assertUnchanged() { assert.equal(createHash('sha256').update(await readFile(process.execPath)).digest('hex'), identity.sha256); },
      async release() { assert.throws(() => originalKill(ownedPid(), 0), { code: 'ESRCH' }); },
    };
    const env = { PATH: '/usr/bin:/bin', XAI_API_KEY: nativeGrokMappingFixtureCredential() };
    const allocation: NativeProcessAllocation = { allocationId: randomUUID(), role: 'comparison', workingDirectory,
      environmentKeys: Object.keys(env),
      launch: { executable: process.execPath, args: [fileURLToPath(new URL('./mapping-peer.mjs', import.meta.url)), receiptPath, behavior],
        cwd: workingDirectory, env, shutdownTimeoutMs: 100 },
      async configurationFilesSnapshot() { return []; },
      async release() { assert.throws(() => originalKill(ownedPid(), 0), { code: 'ESRCH' }); await rm(workingDirectory, { recursive: true }); },
    };
    const fixture: NativeGrokModelFixture = { id: 'grok-4.3', object: 'model', context_length: 1_000_000,
      capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'low' },
      aliases: ['grok-4.3-latest'] };
    const originalKill = process.kill.bind(process);
    const ownedPid = (): number => (JSON.parse(readFileSync(receiptPath, 'utf8')) as { pid: number }).pid;
    let denyTermination = true;
    const intercepted = t.mock.method(process, 'kill', (pid: number, signal?: number | string) => {
      if (signal !== 0 && denyTermination && pid < 0 && pid === -ownedPid()) {
        throw Object.assign(new Error('Synthetic owned process-group termination failure.'), { code: 'EACCES' });
      }
      return originalKill(pid, signal);
    });
    let retained: NativeCleanupError | undefined;
    try {
      await assert.rejects(probeNativeGrokStandardMapping({ candidate, executable, allocation, fixture,
        signal: AbortSignal.timeout(5_000) }), (error: unknown) => {
        assert.equal((JSON.parse(readFileSync(receiptPath, 'utf8')) as { phase: string }).phase,
          behavior === 'opened-session' ? 'turn_completed' : 'opening_rejected');
        assert.ok(error instanceof NativeCleanupError);
        retained = error;
        return true;
      });
      assert.ok(retained);
      assert.equal(retained.retainedRoot, workingDirectory);
      assert.equal((await lstat(workingDirectory)).isDirectory(), true);
      assert.equal(originalKill(ownedPid(), 0), true);
      if (behavior === 'rejected-opening') assert.ok(retained.errors.some((error) => error instanceof AgentProviderSessionCleanupError));
      else assert.equal(retained.errors[0], undefined);
      await assert.rejects(retained.retryCleanup());
      assert.equal(originalKill(ownedPid(), 0), true);
      denyTermination = false;
      intercepted.mock.restore();
      await retained.retryCleanup();
      assert.throws(() => originalKill(ownedPid(), 0), { code: 'ESRCH' });
      await retained.retryCleanup();
      await allocation.release();
      await executable.release();
    } finally {
      denyTermination = false;
      intercepted.mock.restore();
      try { await retained?.retryCleanup(); }
      finally {
        try { originalKill(-ownedPid(), 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}

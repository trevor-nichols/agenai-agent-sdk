// Authoring gate: this owns the example's observable threshold/sole-reader/drain/export contract.
// The inert test lane cannot supervise a process: its unchanged neutral guard forbids spawn.
// Both source and packed proofs use this supervisor; the child itself remains guarded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export async function runToolActionsProof(options: {
  fixtureRoot: string;
  childFile: string;
  guardFile: string;
  cwd: string;
  source?: { loader: string; tsconfig: string };
}) {
  const cases = [];
  for (const mode of ['limited', 'omitted', 'unreached']) {
    const root = await mkdtemp(join(options.fixtureRoot, `tool-actions-${mode}-`));
    try {
      const environment = { HOME: options.fixtureRoot, TMPDIR: options.fixtureRoot, TMP: options.fixtureRoot, TEMP: options.fixtureRoot,
        ...(options.source ? { TSX_TSCONFIG_PATH: options.source.tsconfig } : {}) };
      const guardFile = join(root, 'guard.mjs');
      await writeFile(guardFile, await readFile(options.guardFile, 'utf8')
        + '\nfor (const key of Object.keys(process.env)) delete process.env[key];\n'
        + `Object.assign(process.env, ${JSON.stringify(environment)});\n`, { flag: 'wx' });
      // The supervisor is the sole process owner. A synchronous bounded child is reaped before cleanup.
      // Standard Node filesystem access preserves the reservation's real fsync behavior.
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks',
        ...(options.source ? ['--import', options.source.loader] : []), '--import', guardFile, options.childFile, root, mode], {
        cwd: options.cwd, timeout: 10000, encoding: 'utf8', maxBuffer: 262144,
        env: environment,
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
      const { report: rawReport, trace: rawTrace, guard } = object(JSON.parse(child.stdout));
      const report = object(rawReport); const trace = object(rawTrace);
      assert.deepEqual(guard, { process: 'refused', network: 'refused', fetch: 'refused', ambientEnvironment: 'cleared' });
      assert.equal(object(report.output).observedToolItems, 3);
      assert.equal(report.turnOutcome, 'completed');
      assert.equal(report.status, mode === 'limited' ? 'cancelled' : 'completed');
      assert.equal(report.failureCode, mode === 'limited' ? 'tool_action_limit' : undefined);
      assert.deepEqual(report.toolActionLimit, mode === 'limited' ? { maximum: 2, outcome: 'stop_requested', observedAtStop: 2 }
        : mode === 'unreached' ? { maximum: 4, outcome: 'not_reached' } : undefined);
      assert.deepEqual(trace, { readers: 1, readerDrained: true, stopRequestedBeforeLate: mode === 'limited',
        stopAfterProducerDistinct: mode === 'limited' ? 2 : 3, registryEntered: 1, resolutions: mode === 'limited' ? 0 : 1,
        sessionClosed: 1, providerDisposed: 1, exportedAfterDrain: true });
      assert.equal(object(report.cleanup).settled, true);
      assert.equal(await readFile(join(root, 'export/marker.txt'), 'utf8'), 'owned late observation\n');
      assert(!JSON.stringify(report).includes('synthetic-private-tool-text'));
      cases.push({ mode, observedToolItems: 3, stopRequested: mode === 'limited', reader: 'drained', cleanup: 'settled' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  return { scope: 'scripted example dependencies; no native admission', childGuard: 'process/network/fetch refused; ambient environment cleared', cases };
}

// Explicit installed Desktop coordinator proof. This file never compiles helpers or creates Engine resources.
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnvironment } from '../ci-profile.mjs';
import { runOwnedCommand } from '../command.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { admitOutput, within } from '../scalability/identity.mjs';
import { absolute, closeEntry, context, encode, enginePath, errorEvidence, expectBusy, facts, fileIdentity, installed,
  installRequestGuard, ownerEntry, preparedIdentity, profiles, readInput, runtimeIdentity, scope, sourceIdentity, writeReport } from './coordinator-proof.mjs';

const self = fileURLToPath(import.meta.url);

async function child(inputPath, action) {
  assert(['contend', 'fresh'].includes(action), 'Unknown owned child action.');
  const selected = await readInput(inputPath, ['consumer', 'routeAuthority', 'helper', 'report', 'expectedGeneration']);
  const input = selected.value;
  assert(typeof input.expectedGeneration === 'string' && /^[a-f0-9-]{36}$/u.test(input.expectedGeneration));
  const reportPath = absolute(input.report);
  assert.equal(await realpath(dirname(reportPath)), dirname(reportPath));
  await assert.rejects(lstat(reportPath), { code: 'ENOENT' });
  const report = { format: 'agenai.desktop-coordinator-child-proof.v1', status: 'running', action, input: selected.identity,
    runtime: await runtimeIdentity(), source: await sourceIdentity(), prepared: await preparedIdentity(input.routeAuthority, input.helper),
    installed: null, owners: [], requests: null, primaryFailure: null, cleanupFailures: [], scope };
  const guard = installRequestGuard(new Set([enginePath(input.routeAuthority)]), join(dirname(reportPath), `${action}-requests.jsonl`));
  const entries = [];
  try {
    const loaded = await installed(input.consumer); report.installed = loaded.identity;
    const entry = ownerEntry(loaded.api, input, input.consumer, entries, action);
    await context.run({ case: action, consumer: input.consumer }, async () => {
      if (action === 'contend') report.result = await expectBusy(entry);
      else {
        const authority = await entry.owner.activate({ timeoutMs: 60_000 });
        assert.notEqual(authority.generation, input.expectedGeneration, 'A released predecessor cannot reuse its generation.');
        report.result = { generation: authority.generation, previousGeneration: input.expectedGeneration };
        entry.evidence.states.push(entry.owner.state); entry.owner.closeAdmission(); await entry.owner.settle();
        await closeEntry(entry);
        assert.deepEqual(entry.owner.state, { kind: 'closed', result: 'clean', generation: authority.generation });
      }
    });
    report.status = 'pass';
  } catch (error) { report.status = 'fail'; report.primaryFailure = errorEvidence(error); }
  finally {
    for (const entry of entries.toReversed()) if (entry.owner.state.kind !== 'closed') {
      try { await context.run({ case: `${action}-cleanup`, consumer: entry.consumer }, () => closeEntry(entry)); }
      catch (error) { report.cleanupFailures.push(errorEvidence(error)); report.status = 'fail'; }
    }
    report.owners = entries.map((entry) => entry.evidence); report.requests = guard.summarize(); guard.restore();
    if (report.requests.blocked || report.requests.dispatchedMutations || report.requests.mutationAttempts) report.status = 'fail';
    await writeReport(reportPath, report);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

async function main(inputPath) {
  const selected = await readInput(inputPath, ['consumers', 'routeAuthority', 'helper', 'output']);
  const input = selected.value;
  assert(Array.isArray(input.consumers) && input.consumers.length === 2 && input.consumers.every((root) => typeof root === 'string'));
  assert.notEqual(input.consumers[0], input.consumers[1], 'Two separate installed consumer roots are required.');
  absolute(input.output);
  for (const consumer of input.consumers) await admitOutput(input.output, absolute(consumer));
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const prepared = await preparedIdentity(input.routeAuthority, input.helper);
  const runtime = await runtimeIdentity();
  await mkdir(input.output, { mode: 0o700 });
  await writeFile(join(input.output, 'input.json'), selected.text, { flag: 'wx', mode: 0o600 });
  const reportPath = join(input.output, 'coordinator-lifecycle-report.json');
  const report = { format: 'agenai.desktop-coordinator-installed-lifecycle.v1', status: 'running', input: selected.identity,
    runtime, source: await sourceIdentity(), prepared, installed: [], alias: null, owners: [], cases: [], commands: [],
    requests: null, primaryFailure: null, cleanupFailures: [], scope };
  const allowedPaths = new Set([enginePath(input.routeAuthority)]);
  const guard = installRequestGuard(allowedPaths, join(input.output, 'engine-requests.jsonl'));
  const entries = [];
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Coordinator qualification interrupted.'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let aliasRoot;
  const save = async () => {
    report.owners = entries.map((entry) => entry.evidence); report.requests = guard.summarize();
    await writeReport(reportPath, report);
  };
  const row = async (name, consumer, perform) => {
    cancellation.signal.throwIfAborted();
    const entry = { name, consumer, status: 'running' }; report.cases.push(entry); await save();
    try {
      entry.result = await context.run({ case: name, consumer }, perform);
      entry.requests = guard.summarize(name);
      assert.equal(entry.requests.blocked, 0); assert.equal(entry.requests.mutationAttempts, 0);
      assert.equal(entry.requests.dispatchedMutations, 0); entry.status = 'pass';
    } catch (error) { entry.status = 'fail'; entry.failure = errorEvidence(error); throw error; }
    finally { await save(); }
  };
  const runChild = async (action, previousGeneration) => {
    const childInputPath = join(input.output, `${action}-input.json`);
    const childReport = join(input.output, `${action}-report.json`);
    await writeFile(childInputPath, encode({ consumer: input.consumers[1], routeAuthority: input.routeAuthority,
      helper: input.helper, report: childReport, expectedGeneration: previousGeneration }), { flag: 'wx', mode: 0o600 });
    const command = { action, executable: process.execPath, arguments: [self, '--child', childInputPath, action],
      cwd: input.consumers[1], timeoutMs: 120_000, maxOutputBytes: 64 * 1024 };
    report.commands.push(command); await save();
    let result;
    try {
      result = await runOwnedCommand({ command: command.executable, args: command.arguments, cwd: command.cwd,
        env: credentialFreeEnvironment(process.env, join(input.output, 'docker-config')), timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes, terminationGraceMs: 10_000, signal: cancellation.signal });
    } catch (error) { result = error; throw error; }
    finally {
      Object.assign(command, { status: result?.status, quiescent: result?.quiescent });
      await writeFile(join(input.output, `${action}-stdout.log`), result?.stdout ?? '', { flag: 'wx', mode: 0o600 });
      await writeFile(join(input.output, `${action}-stderr.log`), result?.stderr ?? '', { flag: 'wx', mode: 0o600 });
      await save();
    }
    const childEvidence = JSON.parse((await boundedFile(childReport, 4 * 1024 ** 2)).toString('utf8'));
    assert.equal(childEvidence.status, 'pass'); assert.equal(result.quiescent, true);
    assert.deepEqual(childEvidence.installed.packages, report.installed[1].packages);
    assert.deepEqual(childEvidence.source, report.source, 'Child must run the exact captured qualification sources.');
    assert.deepEqual(childEvidence.prepared, report.prepared, 'Child must observe the original prepared assets and Engine socket.');
    assert.equal(childEvidence.requests.mutationAttempts, 0); assert.equal(childEvidence.requests.dispatchedMutations, 0);
    return { report: childReport, reportIdentity: await fileIdentity(childReport, 4 * 1024 ** 2),
      quiescent: result.quiescent, result: childEvidence.result, requests: childEvidence.requests };
  };
  try {
    await mkdir(join(input.output, 'docker-config'), { mode: 0o700 });
    const first = await installed(input.consumers[0]);
    const second = await installed(input.consumers[1]);
    report.installed = [first.identity, second.identity];
    assert.notEqual(first.identity.entrypoint.path, second.identity.entrypoint.path,
      'Independent installed consumers must resolve to different physical public entrypoints.');
    assert.deepEqual(first.identity.packages, second.identity.packages, 'Both installed copies must contain the same complete candidate.');
    const winner = ownerEntry(first.api, input, input.consumers[0], entries, 'original');
    await row('inert-construction', input.consumers[0], async () => {
      assert.deepEqual(winner.owner.state, { kind: 'inert' }); assert.equal(guard.requests.length, 0);
      return { state: winner.owner.state };
    });
    await row('explicit-initialize-and-idempotent-initialize', input.consumers[0], async () => {
      await winner.owner.initialize({ timeoutMs: 60_000, signal: cancellation.signal });
      await winner.owner.initialize({ timeoutMs: 60_000, signal: cancellation.signal });
      assert.deepEqual(winner.owner.state, { kind: 'inert' }); winner.evidence.states.push(winner.owner.state);
      return { state: winner.owner.state, initializationCalls: 2 };
    });
    let generation;
    await row('activate-original-installed-copy', input.consumers[0], async () => {
      const authority = await winner.owner.activate({ timeoutMs: 60_000, signal: cancellation.signal }); generation = authority.generation;
      assert.equal(winner.owner.state.kind, 'active'); winner.evidence.states.push(winner.owner.state);
      return { generation, state: winner.owner.state };
    });
    await row('same-process-independent-installed-copy-contention', input.consumers[1], async () =>
      expectBusy(ownerEntry(second.api, input, input.consumers[1], entries, 'installed-copy-contender')));
    aliasRoot = await mkdtemp('/private/tmp/agenai-coordinator-alias-');
    report.alias = { directory: aliasRoot, removed: false };
    assert.equal(await realpath(aliasRoot), aliasRoot);
    const aliasPath = join(aliasRoot, 'engine.sock'); assert(Buffer.byteLength(aliasPath) <= 100);
    const directoryIdentity = facts(await lstat(aliasRoot, { bigint: true }));
    await symlink(enginePath(input.routeAuthority), aliasPath);
    const aliasIdentity = await lstat(aliasPath, { bigint: true });
    report.alias = { directory: aliasRoot, directoryIdentity, path: aliasPath, target: await readlink(aliasPath),
      identity: facts(aliasIdentity), removed: false };
    allowedPaths.add(aliasPath);
    const aliasedRoute = structuredClone(input.routeAuthority); aliasedRoute.engine.endpoint = `unix://${aliasPath}`;
    await row('endpoint-alias-contention', input.consumers[1], async () => {
      assert.equal(await realpath(aliasPath), await realpath(enginePath(input.routeAuthority)));
      return expectBusy(ownerEntry(second.api, input, input.consumers[1], entries, 'alias-contender', aliasedRoute));
    });
    const otherProfile = structuredClone(input.routeAuthority);
    otherProfile.profile = profiles.find((profile) => profile !== input.routeAuthority.profile);
    await row('cross-workload-profile-contention', input.consumers[1], async () => {
      const result = await expectBusy(ownerEntry(second.api, input, input.consumers[1], entries, 'profile-contender', otherProfile));
      return { ...result, originalProfile: input.routeAuthority.profile, contenderProfile: otherProfile.profile };
    });
    await row('separate-process-contention', input.consumers[1], () => runChild('contend', generation));
    await row('graceful-drain-settle-and-clean-close', input.consumers[0], async () => {
      winner.owner.closeAdmission(); assert.equal(winner.owner.state.kind, 'draining');
      winner.evidence.states.push(winner.owner.state); await winner.owner.settle({ timeoutMs: 60_000, signal: cancellation.signal });
      await closeEntry(winner);
      assert.deepEqual(winner.owner.state, { kind: 'closed', result: 'clean', generation });
      return { generation, state: winner.owner.state };
    });
    await row('fresh-process-generation-after-release', input.consumers[1], () => runChild('fresh', generation));
    report.status = 'pass';
  } catch (error) { report.status = 'fail'; report.primaryFailure = errorEvidence(error); }
  finally {
    for (const entry of entries.toReversed()) if (entry.owner.state.kind !== 'closed') {
      try { await context.run({ case: 'original-owner-cleanup', consumer: entry.consumer }, () => closeEntry(entry)); }
      catch (error) { report.cleanupFailures.push(errorEvidence(error)); report.status = 'fail'; }
    }
    if (aliasRoot) {
      try {
        const alias = report.alias;
        const unsettled = entries.filter((entry) => entry.owner.state.kind !== 'closed').map((entry) => entry.role);
        assert(unsettled.length === 0 && report.commands.every((command) => command.quiescent === true),
          'Owned callers did not all join; preserve the alias for the retained original owners.');
        assert(alias && alias.directory === aliasRoot && within(aliasRoot, alias.path));
        const currentDirectory = facts(await lstat(aliasRoot, { bigint: true }));
        for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'birthtimeNs']) {
          assert.equal(currentDirectory[key], alias.directoryIdentity[key], 'Owned alias directory changed; preserve it for inspection.');
        }
        assert.deepEqual(facts(await lstat(alias.path, { bigint: true })), alias.identity, 'Owned alias changed; preserve it for inspection.');
        await rm(alias.path); await rmdir(aliasRoot); alias.removed = true;
      } catch (error) { report.cleanupFailures.push(errorEvidence(error)); report.status = 'fail'; }
    }
    if (guard.summarize().blocked || guard.summarize().mutationAttempts) report.status = 'fail';
    await save(); guard.restore();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--child') { assert.equal(args.length, 3); await child(absolute(args[1]), args[2]); }
  else { assert.equal(args.length, 1, 'Usage: node coordinator-lifecycle.mjs /absolute/input.json'); await main(absolute(args[0])); }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'fail', failure: errorEvidence(error) })}\n`);
  process.exitCode = 1;
}

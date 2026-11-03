import { createHash } from 'node:crypto';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDockerDesktopCoordinator } from '../../src/node/desktopCoordinator.js';
import { createDockerDesktopRouteAuthority } from '../../src/node/desktopRouteAuthority.js';
import { readDesktopCoordinatorSourceDigest } from '../../src/node/prepareDesktopCoordinator.js';
import type { WorkOwnership } from '../../src/network/desktop/coordinator/journal/schema.js';
import { desktopResourcesFixture } from './desktopResources.js';
import type { FixtureOptions } from './engine.js';

type Scenario = 'normal' | 'paused_generation' | 'failed_generation' | 'paused_close' | 'failed_clean' | 'paused_health' | 'bootstrap';
interface Event { readonly command: string; readonly text?: string; readonly mode?: string; readonly pid?: number }

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Caller-prepared protocol peer and real Unix HTTP/host-observer boundaries; no native namespace. */
export async function desktopCoordinatorLifecycleFixture(scenario: Scenario = 'normal',
  faults: Pick<FixtureOptions, 'beforeContainerReply' | 'handleRequest'> = {},
  observations?: Readonly<{ vm?: Parameters<typeof desktopResourcesFixture>[3]; network?: Parameters<typeof desktopResourcesFixture>[4] }>) {
  const { handleRequest, ...replies } = faults;
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', handleRequest, replies, observations?.vm, observations?.network);
  await fixture.enableObservation();
  fixture.descriptor.pollIntervalMs = 1_000;
  fixture.descriptor.commandTimeoutMs = 5_000;
  fixture.descriptor.vmObserver.control.heartbeatMs = 1_000;
  fixture.descriptor.vmObserver.control.leaseTimeoutMs = 60_000;
  const directory = await realpath(fixture.spillDirectory);
  const executablePath = join(directory, 'coordinator-peer');
  const scriptPath = join(directory, 'coordinator-peer.mjs');
  const currentPath = join(directory, 'coordinator-current.json');
  const tempPath = join(directory, 'coordinator-next.json');
  const tracePath = join(directory, 'coordinator-events.jsonl');
  const releasePath = join(directory, 'release-commit');
  const failDiscardPath = join(directory, 'fail-discard');
  const failCommitPath = join(directory, 'fail-next-commit');
  const failRetirementPath = join(directory, 'fail-retirement-after-rename');
  const failWorkPath = join(directory, 'fail-work-publication');
  const engineKey = `sha256:${createHash('sha256').update('agenai.desktop-coordinator.engine.v1\0daemon-unit-1').digest('hex')}`;
  const initial = { format: 'agenai.docker-desktop-coordinator.v1', authorityId: 'baec56cc-5e80-4fbf-9fa1-9a39d552037e',
    engineKey, daemonId: 'daemon-unit-1', sequence: 0, previousDigest: null,
    generation: { kind: 'clean', generationOrdinal: 0, lastGenerationId: null, settledAtSequence: 0 } };
  if (scenario !== 'bootstrap') await writeFile(currentPath, JSON.stringify(initial));
  const script = String.raw`
import { createHash } from 'node:crypto';
import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const scenario = ${JSON.stringify(scenario)};
const currentPath = ${JSON.stringify(currentPath)};
const tempPath = ${JSON.stringify(tempPath)};
const tracePath = ${JSON.stringify(tracePath)};
const releasePath = ${JSON.stringify(releasePath)};
const failDiscardPath = ${JSON.stringify(failDiscardPath)};
const failCommitPath = ${JSON.stringify(failCommitPath)};
const failRetirementPath = ${JSON.stringify(failRetirementPath)};
const failWorkPath = ${JSON.stringify(failWorkPath)};
const identity = { stateDevice: '1', stateInode: '2' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (path) => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
// Like the native helper, bootstrap creates an empty state that only the first commit fills.
const bootstrapped = scenario === 'bootstrap' && process.argv[2] === 'initialize' && !await exists(currentPath);
if (bootstrapped) await writeFile(currentPath, '');
let text = await readFile(currentPath, 'utf8');
let pendingTemp = false, fenced = false, cleanup = false, commits = 0, checks = 0, closing = false;
const trace = (value) => appendFile(tracePath, JSON.stringify(value) + '\n');
const reply = (value) => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', (error) => error ? reject(error) : resolve()));
await trace({ command: 'OPEN', mode: process.argv[2], pid: process.pid });
if (text === '' && !bootstrapped) {
  await reply({ kind: 'failure', reason: 'state_frame_bound', errno: 70, claim: 'lost' });
  process.exit(1);
}
await reply({ kind: 'opened', initial: bootstrapped ? 'required' : 'existing', rootDevice: '3', rootInode: '4', lockDevice: '5', lockInode: '6', ...identity, pendingTemp });
async function command(name, payload) {
  await trace({ command: name, ...(payload === undefined ? {} : { text: payload.toString('utf8') }) });
  if (name === 'READ') return reply({ kind: 'snapshot', text, digest: hash(text), ...identity, pendingTemp });
  if (name === 'CHECK') {
    if (scenario === 'paused_health' && ++checks === 1) {
      await trace({ command: 'CHECK_WAITING' });
      while (!await exists(releasePath)) await delay(5);
    }
    return reply({ kind: 'checked', fenced });
  }
  if (name === 'CLEANUP') { cleanup = true; return reply({ kind: 'cleanup' }); }
  if (name === 'DISCARD_TEMP') {
    if (!cleanup) throw new Error('Cleanup was not entered');
    if (await exists(failDiscardPath)) return reply({ kind: 'failure', reason: 'temp_discard', errno: 5, claim: 'held' });
    if (!pendingTemp) throw new Error('No unpublished temp');
    await rm(tempPath); pendingTemp = false;
    return reply({ kind: 'discarded' });
  }
  if (name === 'COMMIT') {
    commits++;
    let workFailure;
    if (await exists(failWorkPath)) {
      const selected = JSON.parse(await readFile(failWorkPath, 'utf8'));
      const previous = JSON.parse(text).generation;
      const next = JSON.parse(payload.toString('utf8')).generation;
      if (previous.kind === 'dirty' && next.kind === 'dirty' && next.members.some((member) =>
        member.work[selected.scope].kind === selected.state
        && previous.members.find((entry) => entry.memberId === member.memberId)?.work[selected.scope].kind !== selected.state)) {
        workFailure = selected;
        await rm(failWorkPath);
        await trace({ command: 'WORK_PUBLICATION_FAILURE', text: JSON.stringify(selected) });
      }
    }
    if (scenario === 'failed_generation' && commits === 1 || await exists(failCommitPath) || workFailure?.stage === 'before_rename') {
      await rm(failCommitPath, { force: true });
      await writeFile(tempPath, payload); pendingTemp = true; fenced = true;
      return reply({ kind: 'failure', reason: 'snapshot_write', errno: 5, claim: 'held' });
    }
    if ((scenario === 'paused_generation' && commits === 1) || (scenario === 'paused_close' && commits === 2)
      || (scenario === 'failed_clean' && commits === 4)) {
      await trace({ command: 'COMMIT_WAITING' });
      while (!await exists(releasePath)) await delay(5);
    }
    if (fenced && !cleanup) throw new Error('Fenced live publication');
    await writeFile(tempPath, payload); await rename(tempPath, currentPath);
    text = payload.toString('utf8'); identity.stateInode = String(Number(identity.stateInode) + 1);
    if (workFailure?.stage === 'after_rename') {
      fenced = true;
      return reply({ kind: 'failure', reason: 'publication_sync', errno: 5, claim: 'held' });
    }
    if (await exists(failRetirementPath)) {
      const memberId = await readFile(failRetirementPath, 'utf8');
      const current = JSON.parse(text);
      if (current.generation.kind === 'dirty' && current.generation.retired.some((member) => member[0] === memberId)) {
        await trace({ command: 'RETIREMENT_ACK_FAILURE', text: memberId });
        await rm(failRetirementPath); fenced = true;
        return reply({ kind: 'failure', reason: 'publication_sync', errno: 5, claim: 'held' });
      }
    }
    if (scenario === 'failed_clean' && commits === 3) {
      fenced = true;
      return reply({ kind: 'failure', reason: 'publication_sync', errno: 5, claim: 'held' });
    }
    return reply({ kind: 'committed', digest: hash(payload), ...identity });
  }
  if (name === 'CLOSE') { await reply({ kind: 'closed' }); closing = true; return; }
  throw new Error('Unknown fixture command');
}
let bytes = Buffer.alloc(0), length;
for await (const chunk of process.stdin) {
  bytes = Buffer.concat([bytes, chunk]);
  for (;;) {
    if (length !== undefined) {
      if (bytes.length < length + 1) break;
      if (bytes[length] !== 10) throw new Error('Payload terminator');
      const payload = bytes.subarray(0, length); bytes = bytes.subarray(length + 1); length = undefined;
      await command('COMMIT', payload);
    } else {
      const newline = bytes.indexOf(10); if (newline < 0) break;
      const line = bytes.subarray(0, newline).toString('ascii'); bytes = bytes.subarray(newline + 1);
      if (/^COMMIT [1-9][0-9]*$/.test(line)) length = Number(line.slice(7));
      else await command(line);
    }
    if (closing) break;
  }
  if (closing) break;
}
await trace({ command: 'EXIT' });
`;
  const executable = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`;
  await writeFile(scriptPath, script, { flag: 'wx', mode: 0o600 });
  await writeFile(executablePath, executable, { flag: 'wx', mode: 0o700 });
  const options = { routeAuthority: createDockerDesktopRouteAuthority(fixture.descriptor),
    helper: { protocol: 'agenai.desktop-coordinator.v1' as const,
      executable: { path: executablePath, sha256: createHash('sha256').update(executable).digest('hex') },
      sourceDigest: await readDesktopCoordinatorSourceDigest() } };
  async function events(): Promise<readonly Event[]> {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line: string): Event => JSON.parse(line)); }
    catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return []; throw cause; }
  }
  return { ...fixture, createOwner: () => createDockerDesktopCoordinator(options), events,
    failNextCommit: () => writeFile(failCommitPath, ''),
    failRetirementAfterRename: (memberId: string) => writeFile(failRetirementPath, memberId),
    failWorkPublication: (scope: keyof WorkOwnership, state: 'owned' | 'joined', stage: 'before_rename' | 'after_rename') =>
      writeFile(failWorkPath, JSON.stringify({ scope, state, stage })),
    pauseCommit: () => rm(releasePath, { force: true }),
    replaceCanonical: (text: string) => writeFile(currentPath, text),
    async terminateHolder() {
      const pid = (await events()).findLast((entry) => entry.command === 'OPEN')?.pid;
      if (pid === undefined) throw new Error('The fixture has no original holder process.');
      process.kill(pid, 'SIGKILL');
      const deadline = Date.now() + 5_000;
      while (true) {
        try { process.kill(pid, 0); }
        catch (cause) {
          if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH') break;
          throw cause;
        }
        if (Date.now() >= deadline) throw new Error('The original fixture holder process did not join.');
        await delay(5);
      }
      try { process.kill(-pid, 0); throw new Error('The original fixture holder process group remains.'); }
      catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause; }
    },
    releaseCommit: () => writeFile(releasePath, ''),
    async failDiscard(fail: boolean) { if (fail) await writeFile(failDiscardPath, ''); else await rm(failDiscardPath, { force: true }); },
    async waitFor(command: string, occurrence = 1) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await events()).filter((entry) => entry.command === command).length >= occurrence) return;
        await delay(5);
      }
      throw new Error(`Lifecycle peer did not reach ${command}.`);
    },
    async current(): Promise<unknown> { return JSON.parse(await readFile(currentPath, 'utf8')); },
    async hasTemp(): Promise<boolean> {
      try { await readFile(tempPath); return true; }
      catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false; throw cause; }
    },
  };
}

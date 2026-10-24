// ------------------------------------------------------------------------------------------------
//                memory.mjs - Separate-process controller RSS and externally requested Node samples
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { failure } from './configuration.mjs';
import { writeRecord } from './manifests.mjs';

function parseProcStatus(text) {
  assert(Buffer.byteLength(text) <= 64 * 1024, 'Bounded Linux process status required.');
  const field = (name) => {
    const match = text.match(new RegExp(`^${name}:\\s+([0-9]+) kB$`, 'mu'));
    assert(match, `Linux process status omitted ${name}.`);
    const bytes = Number(match[1]) * 1024;
    assert(Number.isSafeInteger(bytes));
    return bytes;
  };
  return { rssBytes: field('VmRSS'), highWaterRssBytes: field('VmHWM') };
}

export async function runObservedController({ controllerPath, configurationPath, consumer, output, budgets, env, signal }) {
  const samples = await open(join(output, 'memory-samples.jsonl'), 'wx', 0o600);
  let log;
  try { log = await open(join(output, 'controller.log'), 'wx', 0o600); }
  catch (error) {
    try { await samples.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Memory evidence acquisition and cleanup failed.'); }
    throw error;
  }
  let child;
  let closure;
  let primary;
  let sampler;
  let closed = false;
  let exited = false;
  let exit;
  let logBytes = 0;
  let nextId = 0;
  let outstanding;
  let logWrites = Promise.resolve();
  const sampleCancellation = new AbortController();
  const summary = { samplerPid: process.pid, controllerPid: null, intervalMs: 250, samples: 0, peaks: {
    rssBytes: 0, highWaterRssBytes: 0, externalBytes: 0, arrayBufferBytes: 0, heapUsedBytes: 0 }, budgets,
    method: 'Sampler reads controller /proc/PID/status and independently requests one Node process.memoryUsage snapshot over IPC at a time.',
    caveat: 'Periodic observations can miss short external/array-buffer peaks and the final unsampled interval. Linux VmHWM retains earlier RSS high water until process exit; Node external bytes are self-reported, not an OS counter.',
    failure: null, cleanupFailures: [], commandQuiescent: false };
  const stop = (error) => {
    primary ??= { error };
    if (child && !closed) child.kill('SIGTERM');
  };
  const abort = () => stop(new Error('Qualification launcher interrupted.'));
  try {
    signal?.throwIfAborted();
    child = spawn(process.execPath, [controllerPath, configurationPath], { cwd: consumer, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    summary.controllerPid = child.pid;
    closure = new Promise((resolve) => {
      child.once('error', (error) => { stop(error); });
      child.once('exit', () => { exited = true; });
      child.once('close', (code, signalName) => {
        closed = true;
        exit = { code, signal: signalName };
        sampleCancellation.abort();
        outstanding?.resolve(null);
        resolve();
      });
    });
    const accept = (kind, bytes) => {
      logBytes += bytes.length;
      if (logBytes > 64 * 1024) { stop(new Error('Controller output exceeded 64 KiB.')); return; }
      logWrites = logWrites.then(() => log.writeFile(`${kind}: ${bytes.toString('utf8')}`));
      void logWrites.catch(stop);
    };
    child.stdout.on('data', (bytes) => accept('stdout', bytes));
    child.stderr.on('data', (bytes) => accept('stderr', bytes));
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.on('message', (message) => {
      if (message?.kind !== 'memory' || !outstanding || message.id !== outstanding.id) return;
      outstanding.resolve(message);
    });
    child.once('disconnect', () => { outstanding?.resolve(null); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const processStat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    const statFields = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    assert(/^[0-9]+$/u.test(statFields[19]), 'Linux process start identity required.');
    summary.controllerIdentity = { pid: child.pid, startClockTicks: statFields[19],
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
    sampler = (async () => {
      const joinDisconnected = async () => {
        let timer;
        try {
          await Promise.race([closure, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Controller remained active after its memory channel closed.')), 5000);
          })]);
        } finally { clearTimeout(timer); }
      };
      while (!closed) {
        if (exited || !child.connected) { await joinDisconnected(); break; }
        const requestedAt = new Date().toISOString();
        let proc;
        try {
          const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
          if (closed || exited || /^State:\s+Z /mu.test(status)) { await joinDisconnected(); break; }
          proc = parseProcStatus(status);
        }
        catch (error) { if (closed || error.code === 'ENOENT') break; throw error; }
        const id = nextId++;
        let resolveSample;
        const sample = new Promise((resolve) => { resolveSample = resolve; });
        outstanding = { id, resolve: resolveSample };
        const timeout = setTimeout(() => resolveSample(null), 5000);
        child.send({ kind: 'memory', id }, (error) => { if (error && !closed && child.connected) stop(error); });
        let observed;
        try { observed = await sample; }
        finally { clearTimeout(timeout); outstanding = undefined; }
        if (closed) break;
        if (!child.connected) { await joinDisconnected(); break; }
        assert(observed, 'Controller memory sample did not settle within five seconds.');
        assert.equal(observed.pid, child.pid);
        const memory = observed.memory;
        for (const key of ['rss', 'external', 'arrayBuffers', 'heapUsed']) assert(Number.isSafeInteger(memory?.[key]) && memory[key] >= 0, 'Invalid Node memory observation.');
        assert(typeof observed.phase === 'string' && observed.phase.length <= 64);
        const row = { requestedAt, observedAt: new Date().toISOString(), pid: child.pid, phase: observed.phase, ...proc,
          nodeRssBytes: memory.rss, externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers, heapUsedBytes: memory.heapUsed };
        await writeRecord(samples, row);
        summary.samples += 1;
        for (const key of Object.keys(summary.peaks)) summary.peaks[key] = Math.max(summary.peaks[key], row[key]);
        assert(Math.max(proc.rssBytes, proc.highWaterRssBytes) <= budgets.rssBytes, 'Controller exceeded selected qualification RSS budget.');
        assert(memory.external <= budgets.externalBytes, 'Controller exceeded selected qualification external-memory budget.');
        try { await delay(summary.intervalMs, undefined, { signal: sampleCancellation.signal }); }
        catch (error) { if (!closed) throw error; }
      }
    })();
    void sampler.catch(stop);
    await closure;
    summary.commandQuiescent = true;
    await sampler;
    await logWrites;
    assert.equal(exit.code, 0, `Controller exited unsuccessfully (${exit.code ?? exit.signal}).`);
    assert(summary.samples > 0, 'At least one independent memory sample required.');
  } catch (error) { stop(error); }
  finally {
    signal?.removeEventListener('abort', abort);
    if (closure) await closure;
    summary.commandQuiescent = child === undefined || closed;
    sampleCancellation.abort();
    outstanding?.resolve(null);
    for (const work of [sampler, logWrites]) {
      try { await work; }
      catch (error) { if (primary === undefined) primary = { error }; else if (primary.error !== error) summary.cleanupFailures.push(failure(error)); }
    }
    for (const file of [samples, log]) {
      try { await file.close(); }
      catch (error) { summary.cleanupFailures.push(failure(error)); }
    }
  }
  summary.exit = exit;
  summary.failure = primary === undefined ? summary.cleanupFailures.length ? { name: 'CleanupFailure', message: 'Memory observer cleanup failed.' } : null : failure(primary.error);
  return summary;
}

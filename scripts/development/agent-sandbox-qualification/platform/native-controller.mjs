import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const readyFormat = 'agenai.native-controller-ready.v1';

/** Declare installed graceful handlers before entering native effects. CLI use needs no IPC. */
export async function nativeControllerReady() {
  if (typeof process.send !== 'function' || !process.connected) return;
  await new Promise((resolve) => {
    const disconnect = () => {
      try { if (process.connected) process.disconnect(); } catch { /* The ready-only channel may already be closed. */ }
      resolve();
    };
    try { process.send({ format: readyFormat, pid: process.pid }, disconnect); }
    catch { disconnect(); }
  });
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** The finite work bound can fail; the original cleanup owner has no termination deadline. */
export async function runNativeController({ command, args, env, cwd, timeoutMs, maxOutputBytes = 8 * 1024 ** 2,
  signal, onStarted, directory, requireReady = true }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1);
  assert(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 64 * 1024 ** 2);
  if (signal?.aborted) throw Object.assign(new Error('Native controller cancelled before entry.'),
    { pid: null, status: null, stdout: '', stderr: '', quiescent: true });
  if (directory) await mkdir(directory, { mode: 0o700 });
  if (signal?.aborted) throw Object.assign(new Error('Native controller cancelled before entry.'),
    { pid: null, status: null, stdout: '', stderr: '', quiescent: true });
  const argv = [...args], workingDirectory = cwd ?? process.cwd();
  const child = spawn(command, argv, { cwd: workingDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const stdout = [], stderr = [];
  let failure, ready = false, exited = false, status = null, exitedSignal = null;
  let retainedOutputBytes = 0, observedOutputBytes = 0, gracefulRequest = null;
  const requestCleanup = () => {
    if (!failure || !ready || exited || gracefulRequest) return;
    gracefulRequest = { signal: 'SIGTERM', requestedAt: new Date().toISOString(), delivered: false };
    try { gracefulRequest.delivered = child.kill('SIGTERM'); }
    catch (error) { failure ??= error; }
  };
  const fail = (error) => { failure ??= error; requestCleanup(); };
  const accept = (destination, chunk) => {
    observedOutputBytes += chunk.byteLength;
    const remaining = maxOutputBytes - retainedOutputBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      destination.push(Buffer.from(retained)); retainedOutputBytes += retained.byteLength;
    }
    if (observedOutputBytes > maxOutputBytes) fail(new Error(`Native controller exceeded its ${maxOutputBytes}-byte output bound.`));
  };
  const closed = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => accept(stdout, chunk));
    child.stderr.on('data', (chunk) => accept(stderr, chunk));
    child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.once('error', fail);
    child.once('exit', (code, name) => {
      exited = true; status = code; exitedSignal = name;
      if (code !== 0) fail(new Error(`Native controller failed (${code ?? name}).`));
    });
    child.on('message', (value) => {
      if (value?.format !== readyFormat || value.pid !== child.pid || ready) {
        fail(new Error('Native controller readiness must identify its original PID exactly once.')); return;
      }
      ready = true; requestCleanup();
    });
    child.once('close', resolve);
  });
  const timeout = setTimeout(() => fail(new Error(`Native controller exceeded its ${timeoutMs}ms work deadline.`)), timeoutMs);
  const abort = () => fail(new Error('Native controller work was cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const entered = { pid: child.pid ?? null, command, args: argv, cwd: workingDirectory, enteredAt: new Date().toISOString() };
  try {
    // PID publication precedes fallible caller persistence; failure retains this same child.
    if (child.pid) {
      try { writeSync(process.stderr.fd, `${JSON.stringify({ format: 'agenai.native-controller-entered.v1', ...entered })}\n`); }
      catch (error) { fail(error); }
      try { await onStarted?.(entered); } catch (error) { fail(error); }
    }
    await closed;
    if (requireReady && !ready) fail(new Error('Native controller did not declare installed graceful handlers.'));
    // close joins the original inherited output pipes. Descendants in the original group
    // remain owned even after the direct child exits; no signal escalates their cleanup.
    if (child.pid) for (;;) {
      let active = true;
      try { active = groupExists(child.pid); } catch (error) { fail(error); }
      if (!active) break;
      fail(new Error('Native controller exited with an active owned process group.'));
      await delay(20);
    }
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
  }
  const result = { ...entered, status, signal: exitedSignal, ready, gracefulRequest,
    stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    observedOutputBytes, retainedOutputBytes, quiescent: true, joinedAt: new Date().toISOString() };
  if (directory) {
    result.stdoutPath = join(directory, 'stdout.log'); result.stderrPath = join(directory, 'stderr.log');
    try {
      await writeFile(result.stdoutPath, Buffer.concat(stdout), { flag: 'wx', mode: 0o600 });
      await writeFile(result.stderrPath, Buffer.concat(stderr), { flag: 'wx', mode: 0o600 });
    } catch (error) { failure ??= error; }
  }
  if (failure) throw Object.assign(failure, result);
  return result;
}

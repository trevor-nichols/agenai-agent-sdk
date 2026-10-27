import { spawn } from 'node:child_process';
import { DESKTOP_VM_EXECUTABLE, DESKTOP_VM_OBSERVATION_PROTOCOL, type DesktopVmObserverConfiguration } from './protocol.js';

function observationDocument(bytes: Buffer): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid native Desktop observation.');
  const record: Record<string, unknown> = {};
  const fields = ['format', 'byteOrder', 'kernel', 'architecture', 'networkNamespace', 'links', 'addresses', 'routes', 'complete'];
  if (Object.keys(value).length !== fields.length) throw new TypeError('Unexpected native Desktop observation fields.');
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field);
    if (!property || !('value' in property)) throw new TypeError('Missing native Desktop observation field.');
    record[field] = property.value;
  }
  if (record.format !== DESKTOP_VM_OBSERVATION_PROTOCOL || record.byteOrder !== 'little' || record.complete !== true
    || record.architecture !== 'aarch64' || typeof record.kernel !== 'string' || !/^[a-zA-Z0-9._+-]{1,128}$/u.test(record.kernel)
    || typeof record.networkNamespace !== 'string' || !/^net:\[[0-9]{1,20}\]$/u.test(record.networkNamespace)) throw new TypeError('Invalid native Desktop observation identity.');
  for (const field of ['links', 'addresses', 'routes']) {
    const dump = record[field];
    if (typeof dump !== 'string' || dump.length > 1024 * 1024 || !/^(?:[a-f0-9]{2})*$/u.test(dump)) throw new TypeError('Invalid native Desktop observation dump.');
  }
  // Route semantics are admitted by the controller-side observation parser, never by this envelope.
  return Object.freeze(record);
}

export async function observeDesktopVmNetwork(configuration: DesktopVmObserverConfiguration, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(DESKTOP_VM_EXECUTABLE, [], { detached: true, cwd: '/',
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const fail = (cause: Error) => {
      failure ??= cause;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = error instanceof Error ? error : new Error('Cannot terminate the native Desktop observer.');
        }
      }
    };
    const receive = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > configuration.maxOutputBytes) fail(new Error('Native Desktop observation exceeded its output bound.'));
      else if (!stdout) fail(new Error('Native Desktop observer emitted a failure diagnostic.'));
      else if (!failure) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.once('error', fail);
    const abort = () => fail(new Error('Native Desktop observation was stopped.'));
    const timeout = setTimeout(() => fail(new Error('Native Desktop observation exceeded its command deadline.')), configuration.commandTimeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('close', (code, terminatedBy) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0 || terminatedBy !== null) { reject(new Error('Native Desktop observer did not complete successfully.')); return; }
      try { resolve(observationDocument(Buffer.concat(chunks))); }
      catch (error) { reject(error); }
    });
  });
}

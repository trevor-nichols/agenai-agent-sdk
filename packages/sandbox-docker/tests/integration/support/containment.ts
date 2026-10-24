// ------------------------------------------------------------------------------------------------
//                containment.ts - Independent cgroup observations and bounded controlled-peer input
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { engineGet } from './common.js';
import { kernelObservationMode, readKernelText } from './kernel.js';

type PeerMessage = Readonly<Record<string, unknown>>;

export async function eventually<T>(read: () => Promise<T>, accepted: (value: T) => boolean, description: string,
  timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accepted(value)) return value;
    assert(performance.now() < deadline, description);
    await delay(50);
  }
}

function numeric(value: string, name: string): number {
  assert(/^\d+\s*$/u.test(value), `Expected a finite numeric kernel ${name}.`);
  const result = Number(value.trim());
  assert(Number.isSafeInteger(result), `Kernel ${name} exceeds the fixture numeric bound.`);
  return result;
}

function counters(value: string): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const line of value.trim().split('\n')) {
    const fields = line.split(/\s+/u);
    assert.equal(fields.length, 2, 'Expected bounded kernel counter key/value rows.');
    const [name, count] = fields;
    assert(name && count);
    result[name] = numeric(count, name);
  }
  return result;
}

export interface CgroupLocation {
  readonly keeperPid: number;
  readonly relativePath: string;
  readonly directory: string;
  readonly procCgroup: string;
}

export async function locateCgroup(endpoint: string, computeId: string): Promise<CgroupLocation> {
  const inspection = await engineGet(endpoint, `/containers/${computeId}/json`);
  assert.equal(inspection.status, 200);
  assert(typeof inspection.body === 'object' && inspection.body !== null);
  assert.equal(Reflect.get(inspection.body, 'Id'), computeId);
  const state: unknown = Reflect.get(inspection.body, 'State');
  assert(typeof state === 'object' && state !== null);
  assert.equal(Reflect.get(state, 'Running'), true);
  const keeperPid: unknown = Reflect.get(state, 'Pid');
  assert(typeof keeperPid === 'number' && Number.isSafeInteger(keeperPid) && keeperPid > 0);
  const procCgroup = await readKernelText(`/proc/${keeperPid}/cgroup`);
  assert(procCgroup.length <= 4096);
  const rows = procCgroup.trim().split('\n');
  assert.equal(rows.length, 1, 'The containment proof requires a unified cgroup-v2 host.');
  assert(rows[0]?.startsWith('0::/'));
  const relativePath = rows[0].slice(3);
  assert(relativePath !== '/' && !relativePath.split('/').some((segment) => segment === '.' || segment === '..'));
  const directory = path.resolve('/sys/fs/cgroup', `.${relativePath}`);
  assert(directory.startsWith('/sys/fs/cgroup/'));
  assert(relativePath.includes(computeId), 'The observed keeper cgroup must identify the exact compute container.');
  return { keeperPid, relativePath, directory, procCgroup };
}

export async function readCgroup(location: CgroupLocation) {
  const names = ['memory.max', 'memory.current', 'memory.peak', 'memory.swap.max', 'memory.events',
    'pids.max', 'pids.current', 'pids.events', 'cpu.max', 'cgroup.procs'] as const;
  const values = await Promise.all(names.map(async (name) => {
    const text = await readKernelText(path.join(location.directory, name));
    assert(Buffer.byteLength(text) <= 16 * 1024, `Kernel ${name} exceeded the independent observation bound.`);
    return [name, text] as const;
  }));
  const files = Object.fromEntries(values);
  const get = (name: typeof names[number]) => {
    const value = files[name];
    assert(typeof value === 'string');
    return value;
  };
  return { observedAt: new Date().toISOString(), controllerPid: process.pid, kernelSource: kernelObservationMode(), location, files,
    memory: { maximum: numeric(get('memory.max'), 'memory.max'), current: numeric(get('memory.current'), 'memory.current'),
      peak: numeric(get('memory.peak'), 'memory.peak'), swapMaximum: numeric(get('memory.swap.max'), 'memory.swap.max'), events: counters(get('memory.events')) },
    pids: { maximum: numeric(get('pids.max'), 'pids.max'), current: numeric(get('pids.current'), 'pids.current'),
      events: counters(get('pids.events')) },
    processes: get('cgroup.procs').trim().split('\n').filter(Boolean).map((pid) => numeric(pid, 'cgroup.procs')) };
}

export function observePeerControl(stream: Readable, marker: string) {
  const messages: PeerMessage[] = [];
  let failure: unknown;
  const settled = (async () => {
    let retained = '';
    let bytes = 0;
    for await (const chunk of stream) {
      assert(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert(bytes <= 16 * 1024, 'Containment control output exceeded its fixture bound.');
      retained += Buffer.from(chunk).toString('utf8');
      for (;;) {
        const end = retained.indexOf('\n');
        if (end === -1) break;
        const line = retained.slice(0, end);
        retained = retained.slice(end + 1);
        const value: unknown = JSON.parse(line);
        assert(typeof value === 'object' && value !== null && !Array.isArray(value));
        assert.equal(Reflect.get(value, 'marker'), marker);
        assert(typeof Reflect.get(value, 'kind') === 'string');
        messages.push(value as PeerMessage);
        assert(messages.length <= 16);
      }
    }
    assert.equal(retained, '', 'Containment control output ended inside a JSON record.');
  })().catch((error: unknown) => { failure = error; });
  return { messages, settled, get failure() { return failure; },
    wait: (kind: string) => eventually(async () => {
      const message = messages.find((entry) => entry.kind === kind);
      if (!message && failure !== undefined) throw failure;
      return message;
    }, (message) => message !== undefined, `The controlled peer did not produce ${kind}.`).then((message) => { assert(message); return message; }) };
}

export async function sendCommand(stream: Writable, command: Readonly<Record<string, unknown>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(Buffer.from(`${JSON.stringify(command)}\n`), (error) => error ? reject(error) : resolve());
  });
}

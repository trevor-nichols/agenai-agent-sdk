import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { captureBackendLogs, readBackendLogs } from '../coordinator-negatives/backend-log.mjs';
import { backendEvents } from '../coordinator-negatives/cold-proof.mjs';

const INFO = /^(?:\/v1\.52)?\/info$/u;
const stopped = ({ source, message }) => source === 'idle' && message === 'VM stopped';
const woke = ({ source, message }) => source === 'idle' && /idle -> busy|starting VM/u.test(message);
const cached = ({ source, message }) => source === 'apicache' && /cache << GET \/(?:v1\.52\/)?info$/u.test(message);

/** The pure selection over Desktop backend events; `null` until the VM stopped and at least two health reads hit its cache. */
export function idleObservation(events, since) {
  const stop = events.find((event) => event.at > since && stopped(event));
  if (!stop) return null;
  const wake = events.find((event) => event.at > stop.at && woke(event));
  const reads = events.filter((event) => event.at > stop.at && (!wake || event.at < wake.at) && cached(event));
  return reads.length >= 2 ? { stoppedAt: stop.at, stopLine: stop.line, cachedReads: reads.map(({ at }) => at) } : null;
}

export async function healthReads(context, after, count = 2) {
  while (context.engineCapture.completedSince(INFO, after) < count) {
    context.signal.throwIfAborted();
    await delay(100, undefined, { signal: context.signal });
  }
}

const events = async (paths) => backendEvents((await readBackendLogs(paths)).map(({ bytes }) => bytes));

/** Waits for Desktop's own Resource Saver stop and this coordinator's health reads against it; it issues no Engine request. */
export async function awaitVmStopped(context, phase, since) {
  let observed;
  while (!(observed = idleObservation(await events(context.scenario.backendLogs), since))) {
    context.signal.throwIfAborted();
    await delay(1000, undefined, { signal: context.signal });
  }
  await healthReads(context, observed.stoppedAt);
  const retained = await captureBackendLogs(context.scenario.backendLogs, context.evidence, `idle-${phase}`);
  const wake = backendEvents(retained.map(({ bytes }) => bytes)).find((event) => event.at > observed.stoppedAt && woke(event));
  assert.equal(wake, undefined, 'Desktop woke before this coordinator read its stopped VM.');
  const result = { phase, since, ...observed, logs: retained.map(({ source, retained: file }) => ({ source, retained: file })),
    coordinator: context.coordinator.state };
  await context.evidence.event({ kind: 'desktop-vm-stopped', ...result });
  return result;
}

export async function createForeignNetwork(context, label) {
  const name = `${context.namespace}-${label}`;
  const created = await context.engine.request('POST', '/networks/create', { Name: name, Driver: 'bridge',
    Labels: { 'ai.agen.qualification.owner': context.namespace } }, { allowed: [201] });
  assert.match(created.data.Id, /^[a-f0-9]{64}$/u);
  const network = { id: created.data.Id, name, createdAt: Date.now() };
  await context.evidence.event({ kind: 'foreign-network-created', network });
  return network;
}

export async function removeForeignNetwork(context, network) {
  await context.engine.request('DELETE', `/networks/${network.id}`, undefined, { allowed: [204, 404] });
  const absence = [];
  for (const reference of [network.id, network.name]) {
    absence.push({ reference, status: (await context.engine.request('GET', `/networks/${reference}`, undefined, { allowed: [404] })).status });
  }
  const removed = { ...network, removedAt: Date.now(), absence };
  await context.evidence.event({ kind: 'foreign-network-removed', network: removed });
  return removed;
}

// Independent parent fixture authority: retain one original request and forward it at most once.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { requestJson, sha256, writeReceipt } from './late-engine-transport.mjs';

export async function createGateway(manifest, engineReceipts) {
  let state = 'waiting';
  let accepted;
  let response;
  let joined;
  let forwardCount = 0;
  let acknowledgeAccepted, rejectAccepted, acknowledgeDisconnect;
  const entered = new Promise((resolve, reject) => { acknowledgeAccepted = resolve; rejectAccepted = reject; });
  // Attach a rejection owner even before the parent begins waiting for admission.
  void entered.catch(() => {});
  const disconnected = new Promise((resolve) => { acknowledgeDisconnect = resolve; });
  const server = createServer(async (request, outgoing) => {
    if (state !== 'waiting' || request.method !== 'POST' || request.url !== '/v1.52/networks/create'
      || request.headers['x-agenai-research-request-id'] !== manifest.requestId) {
      outgoing.writeHead(409); outgoing.end('{}'); return;
    }
    state = 'receiving';
    outgoing.on('error', () => {});
    outgoing.once('close', acknowledgeDisconnect);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024) throw new Error('gateway_request_bound');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const original = JSON.parse(await readFile(join(manifest.attempt, 'original-create-intent.json'), 'utf8'));
      if (sha256(raw) !== original.requestBodySha256 || original.requestId !== manifest.requestId
        || original.body.Name !== manifest.name || original.body.Labels['ai.agen.research.attempt'] !== manifest.attemptId) {
        throw new Error('gateway_original_request_conflict');
      }
      accepted = { requestId: manifest.requestId, body: JSON.parse(raw), requestBodySha256: sha256(raw),
        acceptedAt: new Date().toISOString(), originalGeneration: original.generation,
        authority: 'independent research parent retains this original client message before Engine forwarding' };
      await writeReceipt(join(manifest.attempt, 'gateway-original-accepted.json'), accepted);
      response = outgoing;
      state = 'held';
      acknowledgeAccepted(accepted);
    } catch (error) {
      state = 'failed';
      rejectAccepted(error);
      if (!outgoing.destroyed) { outgoing.writeHead(400); outgoing.end('{}'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(manifest.gateway, resolve); });
  return {
    entered,
    disconnected,
    get state() { return state; },
    get forwardCount() { return forwardCount; },
    get accepted() { return accepted; },
    get joined() { return joined; },
    async releaseOriginalOnce() {
      if (state !== 'held' || forwardCount !== 0 || !accepted) throw new Error('gateway_not_releasable');
      state = 'forwarding';
      await writeReceipt(join(manifest.attempt, 'gateway-forward-intent.json'), { ...accepted, forwardingAt: new Date().toISOString() });
      forwardCount = 1;
      joined = requestJson(manifest.engineSocket, 'POST', '/v1.52/networks/create', accepted.body, engineReceipts);
      const acknowledgement = await joined;
      await writeReceipt(join(manifest.attempt, 'gateway-original-acknowledgement.json'), acknowledgement);
      state = 'joined';
      if (!response.destroyed) { response.writeHead(acknowledgement.status); response.end(JSON.stringify(acknowledgement.body)); }
      return acknowledgement;
    },
    async close() {
      if (state === 'held') {
        await writeReceipt(join(manifest.attempt, 'gateway-definitely-not-forwarded.json'), { requestId: manifest.requestId, forwardCount });
        state = 'cancelled_before_forward';
        if (!response.destroyed) { response.writeHead(503); response.end('{}'); }
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

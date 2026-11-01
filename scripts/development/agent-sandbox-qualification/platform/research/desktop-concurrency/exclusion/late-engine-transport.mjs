// Fixed bounded HTTP and immutable receipt files for the explicit late-effect fixture.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function writeReceipt(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > 1024 * 1024) throw new Error('receipt_bound');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  return sha256(bytes);
}

export function requestJson(socketPath, method, path, body, receipts, headers = {}) {
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('fixture_method');
  if (!(method === 'GET' && (path === '/v1.52/networks' || /^\/v1\.52\/networks\/[A-Za-z0-9_-]+$/u.test(path)))
    && !(method === 'POST' && path === '/v1.52/networks/create')
    && !(method === 'DELETE' && /^\/v1\.52\/networks\/[a-f0-9]{64}$/u.test(path))) throw new Error('fixture_path');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (payload && payload.length > 16 * 1024) throw new Error('request_bound');
  return new Promise((resolve, reject) => {
    const entered = new Date().toISOString();
    const http = request({ socketPath, method, path, agent: false,
      headers: { Connection: 'close', ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } },
    (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) http.destroy(new Error('response_bound'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => { clearTimeout(deadline); reject(error); });
      response.once('end', () => {
        clearTimeout(deadline);
        const data = Buffer.concat(chunks);
        let value;
        try { value = data.length === 0 ? null : JSON.parse(data); }
        catch (error) { reject(error); return; }
        const receipt = { socketPath, method, path, entered, settled: new Date().toISOString(),
          status: response.statusCode, requestSha256: payload ? sha256(payload) : null,
          responseSha256: sha256(data), responseBytes: data.length, body: value };
        receipts.push(receipt);
        resolve(receipt);
      });
    });
    const deadline = setTimeout(() => http.destroy(new Error(`request_timeout_uncertain:${method}:${path}`)), 15000);
    http.once('error', (error) => { clearTimeout(deadline); reject(error); });
    http.end(payload);
  });
}

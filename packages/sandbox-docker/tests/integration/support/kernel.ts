// ------------------------------------------------------------------------------------------------
//                kernel.ts - Explicit daemon-VM kernel read port with the existing Linux host default
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';

export function kernelObservationMode(): 'controller-host' | 'daemon-vm-observer' {
  return process.env.AGENAI_SANDBOX_TEST_KERNEL_OBSERVER === undefined ? 'controller-host' : 'daemon-vm-observer';
}

export async function readKernelText(path: string): Promise<string> {
  const endpoint = process.env.AGENAI_SANDBOX_TEST_KERNEL_OBSERVER;
  if (endpoint === undefined) return readFile(path, 'utf8');
  assert(/^unix:\/\/\/[^\0\r\n?#]+$/u.test(endpoint), 'An explicit private kernel observer socket is required.');
  const payload = Buffer.from(JSON.stringify({ path }));
  assert(payload.length <= 16 * 1024);
  return new Promise<string>((resolve, reject) => {
    const operation = request({ socketPath: endpoint.slice(7), path: '/read', method: 'POST', agent: false, maxHeaderSize: 16 * 1024,
      headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 128 * 1024) response.destroy(new Error('Independent kernel response exceeded its finite envelope.'));
        else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200, Buffer.concat(chunks).toString('utf8'));
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert(body !== null && typeof body === 'object' && !Array.isArray(body));
          const text: unknown = Reflect.get(body, 'text');
          assert(typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024);
          resolve(text);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => operation.destroy(new Error('Independent kernel read exceeded thirty seconds.')), 30_000);
    operation.once('error', reject); operation.once('close', () => clearTimeout(timer)); operation.end(payload);
  });
}

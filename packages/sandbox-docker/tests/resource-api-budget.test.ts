// ------------------------------------------------------------------------------------------------
//                resource-api-budget.test.ts - Cumulative actual Docker JSON response byte ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod/v4';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi, DockerResponseByteBudget } from '../src/resources/api.js';
import { engineFixture } from './fixtures/engine.js';

test('a shared JSON budget counts exact raw UTF-8 responses before parsing and remains exhausted', async () => {
  const raw = ` \n\t${JSON.stringify({ name: 'café' })}${' '.repeat(64)}\n`;
  const fixture = await engineFixture({ async handleRequest({ path, response }) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(path === '/malformed' ? 'not JSON' : raw);
    return true;
  } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 1000);
  const schema = z.object({ name: z.literal('café') });
  const responseBudget = new DockerResponseByteBudget(2 * Buffer.byteLength(raw, 'utf8'));
  try {
    for (let index = 0; index < 2; index += 1) {
      assert.deepEqual(await api.json('GET', '/value', schema, { responseBudget }), { name: 'café' });
    }
    await assert.rejects(api.json('GET', '/malformed', schema, { responseBudget }),
      { name: 'SandboxOperationError', code: 'output_limit' });
    await assert.rejects(api.json('GET', '/value', schema, { responseBudget }),
      { name: 'SandboxOperationError', code: 'output_limit' });
    assert.deepEqual(await api.json('GET', '/value', schema), { name: 'café' });
    await assert.rejects(api.json('GET', '/malformed', schema),
      { name: 'SandboxOperationError', code: 'driver_failure', message: 'Docker returned invalid JSON.' });
  } finally { await fixture.close(); }
});

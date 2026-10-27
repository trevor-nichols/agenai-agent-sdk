// ------------------------------------------------------------------------------------------------
//                image.mjs - Shared explicit fixture preparation and exact owned-image cleanup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwnedCommand } from '../command.mjs';
import { boundedFile } from '../native/configuration.mjs';
import { engineControl } from './resources.mjs';

export async function prepareFixtureImage({ endpoint, sourceImage, preparation, env, signal, architecture = 'amd64' }) {
  const result = await runOwnedCommand({ command: process.execPath,
    args: [fileURLToPath(new URL('../prepare-fixture.mjs', import.meta.url)), '--engine', endpoint,
      '--source-image', sourceImage, '--architecture', architecture, '--output', preparation], env, timeoutMs: 300_000, maxOutputBytes: 64 * 1024, signal });
  try {
    await writeFile(join(dirname(preparation), 'preparation.log'), `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
    const prepared = JSON.parse((await boundedFile(join(preparation, 'preparation.json'), 64 * 1024)).toString('utf8'));
    assert.equal(prepared.imageAcquisition, 'identified');
    assert.equal(prepared.containerRemoved, true);
    assert.equal(prepared.primaryFailure, null);
    assert.equal(prepared.cleanupFailure, null);
    return prepared.image;
  } catch (error) { throw Object.assign(error, { quiescent: true }); }
}

export async function cleanupFixtureImage({ endpoint, sourceImage, preparation, daemonId, commandsQuiescent }) {
  assert(commandsQuiescent, 'An entered command is not quiescent; prepared image retained for exact recovery.');
  const prepared = JSON.parse((await boundedFile(join(preparation, 'preparation.json'), 64 * 1024)).toString('utf8'));
  assert.equal(prepared.endpoint, endpoint);
  assert.equal(prepared.sourceImage, sourceImage);
  assert.equal(prepared.containerRemoved, true, 'Preparation container cleanup is not proven.');
  if (prepared.imageAcquisition === 'planned') return false;
  const info = (await engineControl(endpoint, 'GET', '/info')).value;
  assert.equal(info.ID, daemonId, 'Cleanup requires the original daemon.');
  const actual = (await engineControl(endpoint, 'GET', `/images/${encodeURIComponent(prepared.imageTag)}/json`)).value;
  assert.equal(actual.Id, prepared.image);
  assert.equal(actual.Os, 'linux');
  assert.equal(actual.Architecture, prepared.architecture ?? 'amd64');
  assert.equal(actual.Config?.Labels?.['org.agenai.sandbox.preparation'], prepared.operationId);
  assert.equal(actual.Config?.Labels?.['org.agenai.sandbox.source'], sourceImage);
  assert.equal(prepared.imageTag, `agenai-sandbox-fixture:${prepared.operationId}`);
  assert.match(prepared.operationId, /^[a-f0-9-]{36}$/u);
  await engineControl(endpoint, 'DELETE', `/images/${encodeURIComponent(actual.Id)}`, [200]);
  await engineControl(endpoint, 'GET', `/images/${encodeURIComponent(actual.Id)}/json`, [404]);
  return true;
}

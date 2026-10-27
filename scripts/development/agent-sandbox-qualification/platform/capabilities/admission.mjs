import assert from 'node:assert/strict';
import { readManifestInput } from '../configuration.mjs';
import { acquireJsonInput } from './input.mjs';
import { advancedRows, parseCapabilityManifest } from './manifest.mjs';
import { liveScenarioBudget } from './live/budget.mjs';
import { inspectHostRoots } from './preserve/host-roots.mjs';
import { networkScenarioBudget } from './network/budget.mjs';
import { combinedScenarioBudget } from './combined/budget.mjs';

export async function admitPlatformRun(options) {
  assert(['core', 'datasets', 'observer', 'grok-initialize', ...advancedRows].includes(options.row), 'Unknown qualification row.');
  const advanced = advancedRows.includes(options.row);
  assert(advanced ? typeof options.capabilitiesManifestPath === 'string'
    : options.capabilitiesManifestPath === null || options.capabilitiesManifestPath === undefined,
  advanced ? 'Advanced rows require --capabilities-manifest.' : 'Baseline rows reject --capabilities-manifest.');
  const selected = await readManifestInput(options.manifestPath, options.row);
  if (advanced) {
    const capabilities = await acquireJsonInput(options.capabilitiesManifestPath, 128 * 1024);
    const manifest = parseCapabilityManifest(capabilities.value, { row: options.row, platform: selected.manifest, platformInput: selected.input,
      consumer: options.consumer, output: options.output });
    if (options.row === 'live-files') return Object.freeze({ ...selected,
      capabilities: Object.freeze({ manifest, input: capabilities.input, utf8: capabilities.utf8,
        scenarioBudget: liveScenarioBudget(manifest) }) });
    if (options.row === 'preserve-internal') return Object.freeze({ ...selected,
      capabilities: Object.freeze({ manifest, input: capabilities.input, utf8: capabilities.utf8,
        scenarioBudget: liveScenarioBudget(manifest), hostRoots: await inspectHostRoots(manifest) }) });
    if (options.row === 'combined') return Object.freeze({ ...selected,
      capabilities: Object.freeze({ manifest, input: capabilities.input, utf8: capabilities.utf8,
        scenarioBudget: combinedScenarioBudget(manifest), hostRoots: await inspectHostRoots(manifest) }) });
    if (options.row === 'restricted-https' && manifest.profile !== 'linux-x64') return Object.freeze({ ...selected,
      capabilities: Object.freeze({ manifest, input: capabilities.input, utf8: capabilities.utf8,
        scenarioBudget: networkScenarioBudget(manifest) }) });
    const error = new Error(`UNIMPLEMENTED: capability row ${options.row} has validated inputs but no admitted scenario implementation.`);
    error.name = 'UnimplementedCapabilityRowError';
    error.code = 'UNIMPLEMENTED';
    throw error;
  }
  return selected;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpRegistryValidationError, parseAcpRegistrySnapshot, searchAcpRegistry, selectAcpRegistryDistribution, type AcpRegistryTarget } from '../src/index.js';
import { catalogAgent, catalogContent, catalogSource } from './fixtures/catalog/index.js';
import { binaryDistribution, planningSnapshot } from './planning.fixture.js';

const issue = (code: string) => (error: unknown) => error instanceof AcpRegistryValidationError && error.issues.some((item) => item.code === code);

test('search applies all query tokens and explicit distribution/target filters in stable identity order', () => {
  const snapshot = parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([
    catalogAgent({ id: 'zeta', name: 'Zeta Coding', authors: ['Smith'], distribution: { binary: { 'linux-x86_64': binaryDistribution() } } }),
    catalogAgent({ id: 'beta', distribution: { binary: { 'darwin-aarch64': binaryDistribution() } } }),
    catalogAgent({ id: 'alpha', name: 'Alpha Coding', authors: ['Smith'] }),
  ]) });
  assert.deepEqual(searchAcpRegistry(snapshot, { query: '  CODING Smith ' }).map((entry) => entry.id), ['alpha', 'zeta']);
  assert.deepEqual(searchAcpRegistry(snapshot, { target: 'linux-x86_64', distributionKinds: ['binary'] }).map((entry) => entry.id), ['zeta']);
  assert.deepEqual(searchAcpRegistry(snapshot, { agentIds: ['zeta', 'alpha'] }).map((entry) => entry.id), ['alpha', 'zeta']);
  const result = searchAcpRegistry(snapshot, {});
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => (result as unknown[]).push({}), TypeError);
  assert.deepEqual(searchAcpRegistry(JSON.parse(JSON.stringify(snapshot)), {}).map((entry) => entry.id), ['alpha', 'beta', 'zeta']);
});

test('selection follows only caller-ranked distribution choices and never substitutes a target', () => {
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution() }, npx: { package: 'fixture-agent@1.2.3' } });
  const entry = snapshot.entries[0]!;
  assert.equal(selectAcpRegistryDistribution(entry, { target: 'linux-x86_64', preference: ['npx', 'binary'] }).kind, 'npx');
  assert.equal(selectAcpRegistryDistribution(entry, { target: 'linux-x86_64', preference: ['binary', 'npx'] }).kind, 'binary');
  assert.throws(() => selectAcpRegistryDistribution(entry, { target: 'darwin-aarch64', preference: ['binary'] }), issue('acp_registry_distribution_not_found'));
  assert.throws(() => selectAcpRegistryDistribution(entry, { target: 'linux-x86_64-musl' as AcpRegistryTarget, preference: ['npx'] }), issue('acp_registry_target_unsupported'));
  assert.throws(() => selectAcpRegistryDistribution(entry, { target: 'linux-x86_64', preference: ['npx', 'npx'] }), issue('acp_registry_distribution_preference_invalid'));
});

test('an unqualified selected Windows batch launcher fails before trying a lower-ranked distribution', () => {
  const snapshot = planningSnapshot({ binary: { 'windows-x86_64': binaryDistribution({ cmd: '.\\dist-package\\agent.cmd' }) }, npx: { package: 'fixture-agent@1.2.3' } });
  assert.throws(() => selectAcpRegistryDistribution(snapshot.entries[0]!, { target: 'windows-x86_64', preference: ['binary', 'npx'] }), issue('acp_registry_launch_unsupported'));
  assert.equal(selectAcpRegistryDistribution(snapshot.entries[0]!, { target: 'windows-x86_64', preference: ['npx'] }).kind, 'npx');
});

test('Windows target selection rejects device and invalid paths while preserving literal Linux filenames', () => {
  for (const executable of ['bin/CON.exe', 'NUL', 'aux.data/agent.exe', 'bin/COM1.exe', 'Lpt9.txt', 'bin/agent?.exe', 'bin/agent|other.exe']) {
    const snapshot = planningSnapshot({ binary: { 'windows-x86_64': binaryDistribution({ cmd: executable }), 'linux-x86_64': binaryDistribution({ cmd: executable }) } });
    assert.throws(() => selectAcpRegistryDistribution(snapshot.entries[0]!, { target: 'windows-x86_64', preference: ['binary'] }), issue('acp_registry_launch_unsupported'));
    const selected = selectAcpRegistryDistribution(snapshot.entries[0]!, { target: 'linux-x86_64', preference: ['binary'] });
    assert.equal(selected.kind === 'binary' ? selected.executable : undefined, executable);
  }
});

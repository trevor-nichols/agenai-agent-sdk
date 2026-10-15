import assert from 'node:assert/strict';
import type { NodeAcpExecutionBoundary, NodeAcpExecutionInput, NodeAcpExecutionReservation } from '@agen-ai/provider-acp/node';
import { createLinuxExecutionHost, type LinuxExecutionHostOptions } from '../../examples/execution/linux/boundary.mjs';

const mounts: LinuxExecutionHostOptions['mounts'] = [];
const inputs = { resolver: '/unavailable/resolver', hosts: '/unavailable/hosts', certificates: '/unavailable/certificates' };
assert.throws(() => {
  // @ts-expect-error Host networking requires explicit network inputs.
  createLinuxExecutionHost({ network: 'host', mounts });
}, TypeError);
assert.throws(() => {
  // @ts-expect-error Host networking requires its resolver input.
  createLinuxExecutionHost({ network: 'host', mounts, networkInputs: { hosts: inputs.hosts, certificates: inputs.certificates } });
}, TypeError);
assert.throws(() => {
  // @ts-expect-error Host networking requires its hosts input.
  createLinuxExecutionHost({ network: 'host', mounts, networkInputs: { resolver: inputs.resolver, certificates: inputs.certificates } });
}, TypeError);
assert.throws(() => {
  // @ts-expect-error Host networking requires its certificates input.
  createLinuxExecutionHost({ network: 'host', mounts, networkInputs: { resolver: inputs.resolver, hosts: inputs.hosts } });
}, TypeError);

const hosts = [createLinuxExecutionHost({ mounts }), createLinuxExecutionHost({ network: 'host', mounts, networkInputs: inputs })];
const recipe: NodeAcpExecutionInput = Object.freeze({
  executable: '/unavailable/agent', args: Object.freeze(['--acp']), cwd: '/unavailable/workspace',
  env: Object.freeze({ HOME: '/unavailable/profile' }), shutdownTimeoutMs: 10,
});
for (const host of hosts) {
  const boundary: NodeAcpExecutionBoundary = host.executionBoundary;
  assert.equal(host.hostIdentity().operationRoot, null);
  const reservation: NodeAcpExecutionReservation = boundary.reserve(recipe);
  await reservation.release();
  await host.dispose();
  assert.equal(host.hostIdentity().operationRoot, null);
  assert.equal(host.hostIdentity().externalIntervention, null);
}
assert.deepEqual(hosts.map((host) => host.hostIdentity().network), ['isolated', 'host']);
process.stdout.write(JSON.stringify({ proof: 'packed-linux-execution-reference', evidence: 'inert-public-composition',
  hostInputsRequired: true, publicBoundaryCompatible: true, hostsConstructed: hosts.length,
  hostStarts: 0, nativeStarts: 0, operationRootsCreated: 0, unusedHostsDisposed: hosts.length }) + '\n');

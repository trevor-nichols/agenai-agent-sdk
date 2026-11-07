import assert from 'node:assert/strict';
import test from 'node:test';
import { coldScenario, parseScenario } from './configuration.mjs';
import { deploymentFromSettings, ROWS } from './compose-row.mjs';

const settings = { 'vm.hypervisor.mac': 'apple-virtualization-framework', 'vm.rosetta.enabled': true,
  'enhancedContainerIsolation.enabled': false, 'vm.network.hostNetworkingEnabled': false, 'vm.network.kernelForUDP': false,
  'vm.network.defaultNetworkingMode': 'ipv4only', 'vm.network.dnsInhibition': 'auto', 'vm.network.vpnkitCIDR': '192.168.65.0/24',
  'proxy.host.mode': 'system', 'proxy.host.http': '', 'proxy.host.https': '', 'proxy.host.pac': '',
  'proxy.containers.http': '', 'proxy.containers.https': '', 'proxy.containers.pac': '' };

test('Desktop settings map to the coordinator deployment assertion and pass unknown values through unchanged', () => {
  assert.deepEqual(deploymentFromSettings(settings, { version: '4.98.0', build: '245422' }), {
    virtualMachineManager: 'apple_virtualization', rosetta: true, enhancedContainerIsolation: false, hostNetworking: false,
    kernelUdp: false, networkingMode: 'ipv4only', dnsInhibition: 'auto', dockerSubnet: '192.168.65.0/24',
    proxyMode: 'automatic_system', manualProxyConfiguration: false, desktopVersion: '4.98.0', desktopBuild: '245422' });
  const changed = deploymentFromSettings({ ...settings, 'vm.hypervisor.mac': 'docker-vmm', 'proxy.host.mode': 'manual',
    'proxy.containers.https': 'http://proxy.internal:3128' }, { version: '4.98.0', build: '245422' });
  assert.deepEqual([changed.virtualMachineManager, changed.proxyMode, changed.manualProxyConfiguration], ['docker-vmm', 'manual', true]);
});

test('every composed row is a valid scenario, and only the warm rows require VM preparation', () => {
  const logs = ['/Users/operator/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log'];
  const cold = Object.keys(ROWS).filter((row) => coldScenario(parseScenario(ROWS[row](logs))));
  assert.deepEqual(cold, ['ms004', 'single', 'joint', 'foreign-network', 'idle-reentry', 'engine-restart']);
});

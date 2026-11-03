import assert from 'node:assert/strict';
import test from 'node:test';
import { networkSelection } from './selection.mjs';

test('legacy helper selection qualifies only captured-wire rejection and discloses omitted connectivity', () => {
  const selected = networkSelection('legacy-connect-baseline');
  assert.deepEqual(selected.cases, ['captured-native-connect-header']);
  assert.equal(selected.capturedConnectStatus, 403);
  assert.deepEqual(selected.requirements, { C01_OLD_HELPER_REJECTION: ['captured-native-connect-header'] });
  assert.deepEqual(selected.unexercisedRequirements, ['D11', 'D12', 'D13', 'D14', 'C01', 'C02', 'C03']);
  assert(selected.omittedCases.includes('verified-tls-exact-body'));
  assert(selected.omittedCases.includes('original-checkpoint-fresh-cleanup-only'));
});

test('compatibility selection retains connectivity, adds metadata proof and omits recovery while default stays complete', () => {
  const selected = networkSelection('connect-compatibility');
  assert.equal(selected.capturedConnectStatus, 200);
  assert.equal(selected.cases.length, 14);
  for (const name of ['host-and-special-host-reachable-denials', 'allowed-dns-public-local-denied',
    'direct-no-proxy-tcp-udp', 'connect-user-agent-clients-and-tls', 'connect-user-agent-denials-and-bounds']) {
    assert(selected.cases.includes(name), name);
  }
  assert.deepEqual(selected.unexercisedRequirements, ['D14']);
  assert(selected.omittedCases.includes('paused-controller-native-lease'));
  assert.equal(Object.hasOwn(selected.requirements, 'D14'), false);
  const full = networkSelection();
  assert.equal(full.kind, 'full'); assert.equal(full.cases.length, 26);
  assert(full.requirements.D14.includes('paused-controller-native-lease'));
  assert(full.omittedCases.includes('captured-native-connect-header'));
  assert.throws(() => networkSelection('automatic'), /Unknown restricted HTTPS selection/u);
});

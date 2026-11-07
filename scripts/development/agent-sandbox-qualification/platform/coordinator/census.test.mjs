import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNetworkCensusReturned } from './census.mjs';

const network = (Id, Name, Driver = 'bridge', Options = {}) => ({ Id, Name, Driver, Options });
const defaultBridge = (Id) => network(Id, 'bridge', 'bridge', { 'com.docker.network.bridge.default_bridge': 'true' });
const builtins = [network('host', 'host', 'host'), network('none', 'none', 'null'), network('foreign', 'foreign')];

test('a returned census passes unchanged and records no default-bridge replacement', () => {
  for (const coldStart of [false, true]) {
    assert.equal(assertNetworkCensusReturned([...builtins, defaultBridge('old')], [defaultBridge('old'), ...builtins], { coldStart }), null);
  }
});

test('only an unprepared row may end with a recreated default bridge', () => {
  const initial = [...builtins, defaultBridge('old')], final = [...builtins, defaultBridge('new')];
  assert.deepEqual(assertNetworkCensusReturned(initial, final, { coldStart: true }), { before: 'old', after: 'new' });
  assert.throws(() => assertNetworkCensusReturned(initial, final, { coldStart: false }), /did not return to its initial identities/u);
});

test('a cold start still refuses every other network change', () => {
  const initial = [...builtins, defaultBridge('old')];
  for (const final of [
    [...builtins, defaultBridge('new'), network('leaked', 'leaked')],
    [...builtins.filter(({ Id }) => Id !== 'foreign'), defaultBridge('new')],
    [...builtins, network('new', 'bridge')],
  ]) {
    assert.throws(() => assertNetworkCensusReturned(initial, final, { coldStart: true }), /did not return to its initial identities/u);
  }
});

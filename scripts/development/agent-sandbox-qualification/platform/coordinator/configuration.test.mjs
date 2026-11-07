import assert from 'node:assert/strict';
import test from 'node:test';
import { coldScenario, parseScenario, scenarioFamily } from './configuration.mjs';

test('Resource Saver rows are cold MS003 scenarios and only the idle rows name the backend logs they wait on', () => {
  const logs = ['/Users/operator/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log'];
  for (const kind of ['single', 'joint', 'foreign-network']) {
    const scenario = parseScenario({ kind });
    assert.equal(coldScenario(scenario), true); assert.equal(scenarioFamily(scenario), 'ms003');
    assert.throws(() => parseScenario({ kind, backendLogs: logs }));
  }
  for (const kind of ['idle-reentry', 'engine-restart']) {
    assert.deepEqual(parseScenario({ kind, backendLogs: logs }).backendLogs, logs);
    for (const backendLogs of [undefined, [], ['relative.log'], Array(5).fill(logs[0])]) assert.throws(() => parseScenario({ kind, backendLogs }));
  }
  assert.equal(coldScenario(parseScenario(undefined)), true); assert.equal(scenarioFamily(parseScenario(undefined)), 'ms004');
  const lifecycle = parseScenario({ kind: 'lifecycle', removalOrder: ['a', 'b'], reentry: true });
  assert.equal(coldScenario(lifecycle), false); assert.equal(scenarioFamily(lifecycle), 'ms005');
});

test('exploratory inputs admit only the omitted legacy row and explicit bounded lifecycle/handoff variants', () => {
  assert.equal(parseScenario(undefined).kind, 'ms004');
  for (const removalOrder of [['a', 'b'], ['b', 'a']]) assert.equal(parseScenario({ kind: 'lifecycle', removalOrder, reentry: true }).kind, 'lifecycle');
  assert.equal(parseScenario({ kind: 'handoff', at: 'two-active', canonicalPath: '/original/canonical', fault: null }).at, 'two-active');
  assert.equal(parseScenario({ kind: 'lost-ack', canonicalPath: '/original/canonical', fault: { operation: 'delete', role: 'compute' } }).kind, 'lost-ack');
  assert.equal(parseScenario({ kind: 'control-loss', role: 'route_observer' }).kind, 'control-loss');
  for (const input of [{ kind: 'ms004' }, { kind: 'lifecycle', removalOrder: ['a', 'a'], reentry: true },
    { kind: 'lifecycle', removalOrder: ['a', 'b'], reentry: true, retry: true },
    { kind: 'handoff', at: 'two-active', canonicalPath: 'relative', fault: null },
    { kind: 'handoff', at: 'effect-response', canonicalPath: '/original/canonical', fault: { operation: 'start', role: 'storage' } },
    { kind: 'handoff', at: 'effect-response', canonicalPath: '/original/canonical', fault: { operation: 'create', role: 'compute', replay: true } },
    { kind: 'lost-ack', canonicalPath: '/original/canonical', fault: { operation: 'delete', role: 'compute' }, resume: true },
    { kind: 'control-loss', role: 'compute' }, { kind: 'control-loss', role: 'filesystem', restart: true }]) {
    assert.throws(() => parseScenario(input));
  }
});

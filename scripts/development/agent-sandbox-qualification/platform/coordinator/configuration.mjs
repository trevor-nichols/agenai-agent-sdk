import assert from 'node:assert/strict';
import { absolute } from './evidence.mjs';

export function parseScenario(value) {
  if (value === undefined) return { kind: 'ms004' };
  assert(value && typeof value === 'object' && !Array.isArray(value));
  if (value.kind === 'lifecycle') {
    assert.deepEqual(Object.keys(value).sort(), ['kind', 'removalOrder', 'reentry'].sort());
    assert.deepEqual([...value.removalOrder].sort(), ['a', 'b']); assert.equal(value.reentry, true);
  } else if (value.kind === 'control-loss') {
    assert.deepEqual(Object.keys(value).sort(), ['kind', 'role'].sort());
    assert(['route_observer', 'filesystem', 'egress_broker', 'egress_relay'].includes(value.role));
  } else {
    assert(value.kind === 'handoff' || value.kind === 'lost-ack'); absolute(value.canonicalPath);
    assert.deepEqual(Object.keys(value).sort(), ['kind', 'canonicalPath', 'fault', ...(value.kind === 'handoff' ? ['at'] : [])].sort());
    if (value.kind === 'handoff') assert(['two-active', 'effect-response'].includes(value.at));
    if (value.kind === 'handoff' && value.at === 'two-active') assert.equal(value.fault, null);
    else {
      assert.deepEqual(Object.keys(value.fault).sort(), ['operation', 'role'].sort());
      assert(['create', 'start', 'delete'].includes(value.fault.operation));
      if (value.fault.operation !== 'delete') assert(!['network', 'storage', 'egress_socket'].includes(value.fault.role));
      assert(['compute', 'route_observer', 'filesystem', 'egress_broker', 'egress_relay', 'network', 'storage', 'egress_socket'].includes(value.fault.role));
    }
  }
  return value;
}

export function scenarioScope(scenario) {
  const common = ['Staged member addition during one original primary/stdout reader and live file producer',
    'Distinct immutable github.com and example.com CONNECT policies with fresh verified TLS and cross-host HTTP403',
    'Same-path live file identity isolation'];
  const live = scenario.kind === 'lifecycle' || scenario.kind === 'ms004';
  if (scenario.kind === 'control-loss') return { composition: 'One installed native-arm64 coordinator with two original independently owned restricted members.',
    qualification: 'MS005 provider-free control-loss exploration only; full MS007 profiles remain separate.',
    exercised: [...common, `Exact original B ${scenario.role} HTTP-upgrade socket loss after both members become active`,
      'Original peer PID/reader/file/fresh TLS continuity with active coordinator is the separate local-continuity acceptance',
      'A group fence preserves original error chains, event timing, both admission rejections and exact owned cleanup; causal attribution remains unproven until independently established',
      'Post-fence helper exit/absence does not qualify a group-fence outcome'],
    exclusions: ['Provider/model/account/credential use', 'Rosetta and mixed-workload profiles', 'Controller crash or execution restoration',
      'An arbitrary failure outcome treated as success', 'A complete unchanged-VM-graph claim from Engine inspection alone'] };
  return { composition: 'One installed native-arm64 coordinator with independent original restricted members.',
    qualification: scenario.kind === 'ms004' ? 'MS004 exploratory only; full MS007 profiles remain separate.'
      : 'MS005 provider-free lifecycle/failure exploration only; governed MS006 public row and full MS007 profiles remain separate.',
    exercised: live ? [...common,
      `Original ${scenario.kind === 'ms004' ? 'b' : scenario.removalOrder[0]} cancellation/stop/destruction while its original sibling reader, PID, files and fresh TLS continue`,
      'Stopped original export with retained exact network/storage/socket identities',
      ...(scenario.kind === 'lifecycle' ? ['Both selected removal-order members stop; zero active member observers with retained empty network; C admission and original-reader TLS continuity',
        `Selected removal order: ${scenario.removalOrder.join(' then ')}`] : []),
      'Independent exact original name/ID absence and acknowledged canonical clean close']
      : [...common.slice(0, scenario.fault?.operation === 'create' || scenario.fault?.operation === 'start' ? 1 : common.length),
        scenario.kind === 'lost-ack' ? 'One complete original mutation response is withheld; all original request error listeners return before synchronous cut capture and explicit self-suspension; original owner stop has not joined at this cut'
          : scenario.at === 'two-active' ? 'External crash handoff with two original active members'
            : 'Synchronous original mutation receipt/canonical capture and explicit self-suspension before selected response or error delivery to the installed SDK',
        'Complete immutable native canonical envelope and original member-record bytes at the explicit handoff barrier'],
    exclusions: ['Provider/model/account/credential use', 'Rosetta and mixed-workload profiles',
      'A single held TLS connection surviving membership changes', 'Unrelated host/LAN/network isolation campaign',
      ...(live ? ['Controller crash recovery in this live lifecycle row'] : ['A successful live continuation after shared-controller authority loss', 'Cleanup/recovery success before its separate exact original generation row'])] };
}

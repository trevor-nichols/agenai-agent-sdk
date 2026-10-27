// ------------------------------------------------------------------------------------------------
//                entry.ts - Explicit fixed helper invocation; module import has no runtime effects
// ------------------------------------------------------------------------------------------------

import { runEgressControl } from './control.js';
import { startEgressBroker } from './broker.js';
import { startEgressRelay } from './relay.js';
import { EGRESS_CONFIG_ENV, parseEgressHelperConfiguration, type EgressHelperRole } from './protocol.js';

export async function runEgressHelper(role: EgressHelperRole): Promise<void> {
  const raw = process.env[EGRESS_CONFIG_ENV];
  if (raw === undefined || Buffer.byteLength(raw) > 65536) throw new TypeError('Missing bounded helper configuration.');
  const configuration = parseEgressHelperConfiguration(JSON.parse(raw));
  if (configuration.role !== role) throw new TypeError('Helper configuration role differs from its fixed invocation.');
  await runEgressControl({ input: process.stdin, output: process.stdout, role, leaseTimeoutMs: configuration.leaseTimeoutMs,
    start: (signal) => configuration.role === 'broker' ? startEgressBroker(configuration, signal) : startEgressRelay(signal) });
}

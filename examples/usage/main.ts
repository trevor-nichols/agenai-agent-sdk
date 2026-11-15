import { AGENT_PROTOCOL_VERSION } from '@agen-ai/agent-protocol';
import { runAccountingScenarios } from './accounting.js';
import { runLifecycleScenario } from './lifecycle.js';

// Synthetic token-usage walkthrough: no provider, credential, network or native evidence.
const report = {
  example: 'usage',
  evidence: 'synthetic',
  protocolVersion: AGENT_PROTOCOL_VERSION,
  scenarios: [...runAccountingScenarios(), await runLifecycleScenario()],
};
console.log(JSON.stringify(report));

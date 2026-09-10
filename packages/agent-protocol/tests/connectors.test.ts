import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentIntegrationCatalog, safeParseAgentIntegrationCatalog } from '../src/integrations/index.js';

const connector = {
  integrationId: 'connector:a',
  revision: 1,
  kind: 'connector',
  name: 'Workspace connector',
  source: { scope: 'remote', origin: 'remote' },
  installation: { kind: 'known', value: true },
  enablement: { kind: 'known', value: true },
  authentication: { kind: 'unknown' },
  health: 'starting',
  callability: { kind: 'unknown' },
};

function catalog(integration: unknown) {
  return { revision: 1, observedAt: '2026-09-08T12:00:00.000Z', integrations: [integration] };
}

test('connector installation does not imply authentication or callability', () => {
  assert.deepEqual(parseAgentIntegrationCatalog(catalog(connector)), catalog(connector));
  for (const field of ['installation', 'enablement', 'authentication']) {
    const contradictory = { ...connector, [field]: { kind: 'known', value: false }, callability: { kind: 'known', value: true } };
    assert.equal(safeParseAgentIntegrationCatalog(catalog(contradictory)).success, false);
  }
});

test('connector contracts reject configuration URLs, credentials and MCP-only fields', () => {
  for (const extra of [{ servers: [] }, { endpoint: 'https://private.invalid/mcp' }, { token: 'not-a-real-token' }]) {
    assert.equal(safeParseAgentIntegrationCatalog(catalog({ ...connector, ...extra })).success, false);
  }
  assert.equal(safeParseAgentIntegrationCatalog(catalog({ ...connector, tools: [
    { toolId: 'tool:a', name: 'First' },
    { toolId: 'tool:a', name: 'Duplicate' },
  ] })).success, false);
});

test('integration contribution and UTF-8 bounds apply across the entire catalog', () => {
  const integrations = Array.from({ length: 42 }, (_, index) => ({
    ...connector,
    integrationId: `connector:${String(index).padStart(3, '0')}`,
    tools: Array.from({ length: 100 }, (_, toolIndex) => ({ toolId: `tool:${String(toolIndex).padStart(3, '0')}`, name: 'Tool' })),
  }));
  const large = { revision: 1, observedAt: '2026-09-08T12:00:00.000Z', integrations };
  assert.equal(safeParseAgentIntegrationCatalog(large).success, false);
  assert.equal(safeParseAgentIntegrationCatalog({ ...large, integrations: integrations.slice(0, 40) }).success, true);
});

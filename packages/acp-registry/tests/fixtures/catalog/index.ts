import type { AcpRegistrySource } from '../../../src/catalog/contracts.js';

export const catalogSource: AcpRegistrySource = Object.freeze({ namespace: 'fixture-registry', kind: 'local',
  channel: 'stable', location: 'fixture:catalog', profile: 'published-v1' });

export function catalogAgent(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { id: 'fixture-agent', name: 'Fixture Agent', version: '1.2.3', description: 'An ACP registry fixture.',
    license_url: 'https://example.com/license', distribution: { npx: { package: 'fixture-agent@1.2.3' } }, ...overrides };
}

export function catalogContent(agents: readonly unknown[] = [catalogAgent()]): string {
  return JSON.stringify({ version: '1.0.0', agents, extensions: [] });
}

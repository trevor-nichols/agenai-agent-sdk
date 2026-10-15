export function sessionDecisionFixture() {
  return {
    kind: 'decision',
    requestId: 'decision:1',
    sessionId: 'session:1',
    title: 'Allow workspace configuration?',
    description: 'Project tool servers and hooks are gated.\nThe grant covers future configuration too.',
    target: { kind: 'workspace', path: '/workspace/project' },
    expiresAt: '2026-10-13T12:00:00.000Z',
    choices: [
      {
        choiceId: 'grant',
        label: 'Allow workspace configuration',
        description: 'The provider may persist the workspace grant and apply it in later sessions.',
        consequence: {
          kind: 'grant',
          scope: 'workspace',
          persistence: {
            kind: 'provider_managed',
            duration: 'persistent',
            mayAffectOtherSessions: true,
          },
        },
      },
      {
        choiceId: 'decline',
        label: 'Keep configuration gated',
        description: 'Keep configuration gated without revoking existing grants.',
        consequence: { kind: 'decline', configuration: 'remains_gated' },
      },
    ],
  };
}

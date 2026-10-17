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

export function sessionFormFixture() {
  return {
    kind: 'form',
    requestId: 'form:1',
    sessionId: 'session:1',
    title: 'Configure the workspace',
    fields: [
      { kind: 'text', fieldId: 'name', label: 'Name', required: true, sensitivity: 'ordinary', multiline: false, maxLength: 40 },
      {
        kind: 'single_select', fieldId: 'region', label: 'Region', required: true, sensitivity: 'ordinary', allowOther: false,
        options: [{ value: 'east', label: 'East' }, { value: 'west', label: 'West' }],
      },
      {
        kind: 'multi_select', fieldId: 'features', label: 'Features', required: false, sensitivity: 'ordinary', allowOther: true, maxSelections: 2,
        options: [{ value: 'search', label: 'Search' }, { value: 'reports', label: 'Reports' }],
      },
      { kind: 'boolean', fieldId: 'private', label: 'Private', required: false, sensitivity: 'ordinary' },
      { kind: 'confirmation', fieldId: 'confirmed', label: 'Confirm', confirmLabel: 'Confirmed', required: false, sensitivity: 'ordinary' },
    ],
    choices: [
      { choiceId: 'submit', action: 'submit', label: 'Submit' },
      { choiceId: 'cancel', action: 'cancel', label: 'Cancel' },
    ],
  };
}

export function sessionFormResponseFixture() {
  return {
    kind: 'form', action: 'submit', choiceId: 'submit',
    answers: [
      { kind: 'text', fieldId: 'name', value: 'Example workspace' },
      { kind: 'single_select', fieldId: 'region', value: 'east' },
      { kind: 'multi_select', fieldId: 'features', values: ['search'], other: 'Custom feature' },
      { kind: 'boolean', fieldId: 'private', value: false },
      { kind: 'confirmation', fieldId: 'confirmed', confirmed: false },
    ],
  };
}

export function sessionPlanReviewFixture() {
  return {
    kind: 'plan_review',
    requestId: 'plan-review:1',
    sessionId: 'session:1',
    title: 'Review the implementation plan',
    plan: {
      planId: 'plan:1', revision: 'revision:1', title: 'Workspace implementation',
      content: { kind: 'text', format: 'markdown', text: '# Implementation\n\n1. Inspect the workspace.\n2. Apply the approved changes.\n' },
    },
    choices: [
      { choiceId: 'approve', action: 'approve', label: 'Approve' },
      { choiceId: 'revise', action: 'revise', label: 'Request changes' },
      { choiceId: 'abandon', action: 'abandon', label: 'Abandon' },
    ],
  };
}

export function sessionPlanReviewResponseFixture() {
  return { kind: 'plan_review', action: 'revise', choiceId: 'revise', planId: 'plan:1', revision: 'revision:1', feedback: 'Inspect error handling before applying changes.' };
}

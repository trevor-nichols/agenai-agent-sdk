// ------------------------------------------------------------------------------------------------
//                itemSnapshots.test.ts - V7 item-union strictness and bounds coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ITEM_KINDS,
  parseAgentItemSnapshot,
  safeParseAgentItemSnapshot,
} from '../src/public/index.js';

// ------------------------------------------------------------------------------------------------
//                Valid Variant Corpus
// ------------------------------------------------------------------------------------------------

const validItemSnapshots = [
  { itemId: 'item:user', itemKind: 'user_message', status: 'completed' },
  {
    itemId: 'item:assistant',
    itemKind: 'assistant_message',
    status: 'in_progress',
  },
  { itemId: 'item:reasoning', itemKind: 'reasoning', status: 'completed' },
  { itemId: 'item:plan', itemKind: 'plan', status: 'in_progress' },
  {
    itemId: 'item:command',
    itemKind: 'command_execution',
    status: 'completed',
    details: {
      commandSummary: 'Run the focused test suite',
      workingPath: 'packages/ai/agent-protocol',
      exitCode: 0,
      durationMs: 412,
    },
  },
  {
    itemId: 'item:file',
    itemKind: 'file_change',
    status: 'completed',
    details: {
      changes: [
        { path: 'docs/architecture.md', changeKind: 'created' },
        { path: 'src/index.ts', changeKind: 'modified' },
      ],
    },
  },
  {
    itemId: 'item:mcp',
    itemKind: 'mcp_tool_call',
    status: 'completed',
    details: {
      serverName: 'github',
      toolName: 'read_pull_request',
      durationMs: 80,
    },
  },
  {
    itemId: 'item:dynamic',
    itemKind: 'dynamic_tool_call',
    status: 'completed',
    details: { toolName: 'ask_question', success: true },
  },
  {
    itemId: 'item:collaboration',
    itemKind: 'collaboration_tool_call',
    status: 'completed',
    details: { actionSummary: 'Asked a bounded research agent for input' },
  },
  {
    itemId: 'item:web',
    itemKind: 'web_search',
    status: 'completed',
    details: { querySummary: 'Official protocol documentation' },
  },
  {
    itemId: 'item:browser',
    itemKind: 'browser_action',
    status: 'completed',
    details: { actionSummary: 'Opened the official documentation page' },
  },
  {
    itemId: 'item:computer',
    itemKind: 'computer_action',
    status: 'completed',
    details: { actionSummary: 'Selected the workspace terminal' },
  },
  {
    itemId: 'item:image',
    itemKind: 'image_view',
    status: 'completed',
    details: { filePath: 'artifacts/preview.png' },
  },
  {
    itemId: 'item:review',
    itemKind: 'review',
    status: 'in_progress',
    details: { phase: 'entered', target: 'Review the current working tree' },
  },
  {
    itemId: 'item:compaction',
    itemKind: 'context_compaction',
    status: 'completed',
    details: {
      trigger: 'manual',
      beforeTokens: 84_000,
      afterTokens: 31_000,
      durationMs: 1_250,
      summaryPreview: 'Earlier context was compacted for continued work.',
    },
  },
  { itemId: 'item:unknown', itemKind: 'unknown', status: 'unknown' },
] as const;

test('V7 item fixtures cover and round-trip every item discriminant', () => {
  assert.deepEqual(
    validItemSnapshots.map((item) => item.itemKind).sort(),
    [...AGENT_ITEM_KINDS].sort(),
  );

  for (const fixture of validItemSnapshots) {
    const parsed = parseAgentItemSnapshot(fixture);
    assert.deepEqual(parsed, fixture, fixture.itemKind);
    assert.deepEqual(
      parseAgentItemSnapshot(JSON.parse(JSON.stringify(parsed))),
      fixture,
      fixture.itemKind,
    );
  }
});

// ------------------------------------------------------------------------------------------------
//                Strict Shape and Cross-Field Rejection
// ------------------------------------------------------------------------------------------------

test('item variants reject retired bags, cross-kind details, and unknown fields', () => {
  const invalidItems = [
    {
      itemId: 'item:command',
      itemKind: 'command_execution',
      status: 'completed',
      attributes: { commandSummary: 'Retired bag' },
    },
    {
      itemId: 'item:assistant',
      itemKind: 'assistant_message',
      status: 'completed',
      details: { actionSummary: 'Not legal on a message' },
    },
    {
      itemId: 'item:command',
      itemKind: 'command_execution',
      status: 'completed',
      details: { changes: [{ path: 'src/index.ts', changeKind: 'modified' }] },
    },
    {
      itemId: 'item:file',
      itemKind: 'file_change',
      status: 'completed',
      details: { commandSummary: 'Not legal on a file change' },
    },
    {
      itemId: 'item:mcp',
      itemKind: 'mcp_tool_call',
      status: 'completed',
      details: { toolName: 'read', arguments: { path: '/private' } },
    },
    {
      itemId: 'item:unknown',
      itemKind: 'unknown',
      status: 'unknown',
      metadata: { nativeType: 'provider.event' },
    },
  ];

  for (const invalidItem of invalidItems) {
    assert.equal(safeParseAgentItemSnapshot(invalidItem).success, false);
  }
});

test('optional detail objects require their semantic identifying fields', () => {
  const invalidDetailsByKind = [
    ['command_execution', {}],
    ['command_execution', { truncated: true }],
    ['mcp_tool_call', { durationMs: 1 }],
    ['dynamic_tool_call', { success: true }],
    ['collaboration_tool_call', {}],
    ['web_search', {}],
    ['browser_action', {}],
    ['computer_action', {}],
    ['image_view', {}],
  ] as const;

  for (const [itemKind, details] of invalidDetailsByKind) {
    assert.equal(
      safeParseAgentItemSnapshot({
        itemId: `item:${itemKind}`,
        itemKind,
        status: 'in_progress',
        details,
      }).success,
      false,
      itemKind,
    );
  }
});

test('review details are required and enforce phase-exclusive canonical text', () => {
  const common = {
    itemId: 'item:review',
    itemKind: 'review',
    status: 'completed',
  } as const;
  const invalidReviews = [
    common,
    { ...common, details: {} },
    { ...common, details: { phase: 'entered' } },
    {
      ...common,
      details: { phase: 'entered', target: 'target', report: 'report' },
    },
    { ...common, details: { phase: 'exited' } },
    {
      ...common,
      details: { phase: 'exited', report: 'report', target: 'target' },
    },
    { ...common, details: { phase: 'entered', target: ' target ' } },
    { ...common, details: { phase: 'exited', report: 'x'.repeat(4_001) } },
    {
      ...common,
      details: { phase: 'exited', report: 'report', truncated: false },
    },
  ];

  for (const invalidReview of invalidReviews) {
    assert.equal(safeParseAgentItemSnapshot(invalidReview).success, false);
  }

  assert.equal(
    safeParseAgentItemSnapshot({
      ...common,
      details: { phase: 'exited', report: 'Review passed.', truncated: true },
    }).success,
    true,
  );
});

// ------------------------------------------------------------------------------------------------
//                Path, Ordering, Integer, and Bound Enforcement
// ------------------------------------------------------------------------------------------------

test('display paths reject empty, rooted, traversal, noncanonical, and oversized values', () => {
  const invalidPaths = [
    '',
    '/etc/passwd',
    '\\private',
    'C:\\private',
    '../secret',
    'src/../secret',
    ' leading/path',
    'trailing/path ',
    'line\nbreak',
    'x'.repeat(501),
  ];

  for (const workingPath of invalidPaths) {
    assert.equal(
      safeParseAgentItemSnapshot({
        itemId: 'item:command',
        itemKind: 'command_execution',
        status: 'completed',
        details: { workingPath },
      }).success,
      false,
      workingPath,
    );
  }
});

test('file details require unique paths in ascending code-point order within the bound', () => {
  const common = {
    itemId: 'item:file',
    itemKind: 'file_change',
    status: 'completed',
  } as const;
  const invalidChangeLists = [
    [],
    [
      { path: 'b.ts', changeKind: 'modified' },
      { path: 'a.ts', changeKind: 'modified' },
    ],
    [
      { path: 'a.ts', changeKind: 'created' },
      { path: 'a.ts', changeKind: 'modified' },
    ],
    Array.from({ length: 101 }, (_, index) => ({
      path: `${String(index).padStart(3, '0')}.ts`,
      changeKind: 'modified',
    })),
  ];

  for (const changes of invalidChangeLists) {
    assert.equal(
      safeParseAgentItemSnapshot({ ...common, details: { changes } }).success,
      false,
    );
  }
});

test('numeric and truncation fields enforce safe integers and literal true', () => {
  const common = {
    itemId: 'item:command',
    itemKind: 'command_execution',
    status: 'completed',
  } as const;
  const invalidDetails = [
    { exitCode: Number.MAX_SAFE_INTEGER + 1 },
    { exitCode: 1.5 },
    { durationMs: -1 },
    { durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { commandSummary: 'Run tests', truncated: false },
    { commandSummary: ' Run tests ' },
    { commandSummary: 'x'.repeat(2_001) },
  ];

  for (const details of invalidDetails) {
    assert.equal(
      safeParseAgentItemSnapshot({ ...common, details }).success,
      false,
    );
  }
});

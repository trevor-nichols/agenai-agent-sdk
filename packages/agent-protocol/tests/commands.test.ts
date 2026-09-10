import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_COMMAND_CATALOG_MAX_LENGTH,
  parseAgentCommandCatalog,
  parseAgentCommandDescriptor,
  safeParseAgentCommandCatalog,
  safeParseAgentCommandDescriptor,
} from '../src/commands/index.js';

const observedAt = '2026-09-08T12:00:00.000Z';

const commandA = {
  commandId: 'command:a',
  revision: 1,
  name: 'Open command palette',
  summary: 'A canonical user command.',
  source: { scope: 'workspace', origin: 'bundled' },
  availability: { kind: 'known', value: true },
  operation: { operationId: 'operation:open-palette', revision: 2, catalogRevision: 3 },
} as const;

const commandB = {
  commandId: 'command:b',
  revision: 1,
  name: 'Inspect command',
  source: { scope: 'project', origin: 'plugin' },
  availability: { kind: 'unknown' },
} as const;

const catalog = {
  revision: 4,
  observedAt,
  commands: [commandA, commandB],
} as const;

test('commands preserve display facts and qualified operation identity', () => {
  const parsedDescriptor = parseAgentCommandDescriptor(commandA);
  const parsedCatalog = parseAgentCommandCatalog(catalog);

  assert.deepEqual(parsedDescriptor, commandA);
  assert.deepEqual(parsedCatalog, catalog);
  assert.equal(parsedCatalog.commands[0]?.operation?.catalogRevision, 3);
  assert.ok(Object.isFrozen(parsedDescriptor));
  assert.ok(Object.isFrozen(parsedCatalog));
  assert.ok(Object.isFrozen(parsedCatalog.commands));
  assert.ok(Object.isFrozen(parsedCatalog.commands[0]));
});

test('commands use strict availability/source and operation shapes', () => {
  assert.equal(
    safeParseAgentCommandDescriptor({
      ...commandA,
      availability: { kind: 'unknown', value: false },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({
      ...commandA,
      source: { scope: 'workspace', origin: 'native-config' },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({
      ...commandA,
      operation: {
        ...commandA.operation,
        nativeCommand: '/private/provider-command',
      },
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({
      ...commandA,
      native: { executable: '/private/provider-command' },
    }).success,
    false,
  );
});

test('command catalogs require canonical unique IDs', () => {
  assert.equal(
    safeParseAgentCommandCatalog({
      ...catalog,
      commands: [commandB, commandA],
    }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandCatalog({
      ...catalog,
      commands: [commandA, { ...commandA, revision: 2 }],
    }).success,
    false,
  );
});

test('command catalogs enforce UTF-8 bytes, entry count, cycles and accessors before parsing', () => {
  const oversizedByUtf8 = Array.from({ length: 100 }, (_, index) => ({
    ...commandA,
    commandId: `command:${String(index).padStart(3, '0')}`,
    summary: '界'.repeat(2_000),
  }));
  assert.equal(
    safeParseAgentCommandCatalog({
      ...catalog,
      commands: oversizedByUtf8,
    }).success,
    false,
  );

  const tooManyEntries = Array.from(
    { length: AGENT_COMMAND_CATALOG_MAX_LENGTH + 1 },
    (_, index) => ({
      ...commandA,
      commandId: `command:${String(index).padStart(4, '0')}`,
    }),
  );
  assert.equal(
    safeParseAgentCommandCatalog({ ...catalog, commands: tooManyEntries }).success,
    false,
  );

  const cyclic: Record<string, unknown> = { ...catalog };
  cyclic.commands = [cyclic];
  assert.equal(safeParseAgentCommandCatalog(cyclic).success, false);

  let getterCalls = 0;
  const accessor = {
    ...catalog,
    get revision() {
      getterCalls += 1;
      return 4;
    },
  };
  assert.equal(safeParseAgentCommandCatalog(accessor).success, false);
  assert.equal(getterCalls, 0);
});

test('command bounds reject invalid text and operation revisions', () => {
  assert.equal(
    safeParseAgentCommandDescriptor({ ...commandA, name: 'x'.repeat(201) }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({ ...commandA, summary: 'x'.repeat(2_001) }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({ ...commandA, revision: Number.POSITIVE_INFINITY }).success,
    false,
  );
  assert.equal(
    safeParseAgentCommandDescriptor({
      ...commandA,
      operation: { operationId: 'operation:open-palette', revision: 0, catalogRevision: 1 },
    }).success,
    false,
  );
});

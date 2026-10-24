// ------------------------------------------------------------------------------------------------
//                contracts.typecheck.ts - Branded parsed values and ergonomic public inputs
// ------------------------------------------------------------------------------------------------

import { parseSandboxId, parseSandboxNamespace, parseSandboxRelativePath } from '../src/index.js';
import type { Sandbox, SandboxId, SandboxInputTreeSelection, SandboxNamespace, SandboxProcessExit, SandboxRelativePath, SandboxWorkspaceDiskQuota } from '../src/index.js';

const namespace: SandboxNamespace = parseSandboxNamespace('caller-1');
const sandbox: SandboxId = parseSandboxId('sandbox-1');
const relativePath: SandboxRelativePath = parseSandboxRelativePath('result.txt');
void namespace;
void sandbox;
void relativePath;

// @ts-expect-error Plain strings have not crossed the namespace validation boundary.
const uncheckedNamespace: SandboxNamespace = 'caller-1';
// @ts-expect-error A sandbox identifier does not convey namespace authority.
const wrongNamespace: SandboxNamespace = sandbox;
// @ts-expect-error An unchecked string is not a safe relative path.
const uncheckedPath: SandboxRelativePath = '../host';
void uncheckedNamespace;
void wrongNamespace;
void uncheckedPath;
const unavailableExit: SandboxProcessExit = { kind: 'unavailable', reason: 'sandbox_stopped' };
// @ts-expect-error An unavailable leader receipt cannot fabricate an observed exit code.
const fabricatedExit: SandboxProcessExit = { kind: 'unavailable', reason: 'sandbox_stopped', code: 0 };
void unavailableExit;
void fabricatedExit;

const noQuota: SandboxWorkspaceDiskQuota = { kind: 'not_requested' };
const requiredQuota: SandboxWorkspaceDiskQuota = { kind: 'required', bytes: 1024, accounting: 'allocated_blocks' };
// @ts-expect-error A policy with no quota request cannot claim enforcement bytes.
const contradictoryQuota: SandboxWorkspaceDiskQuota = { kind: 'not_requested', bytes: 1024 };
// @ts-expect-error A required quota names its allocated-block accounting contract.
const ambiguousQuota: SandboxWorkspaceDiskQuota = { kind: 'required', bytes: 1024 };
void noQuota;
void requiredQuota;
void contradictoryQuota;
void ambiguousQuota;

function acceptInlinePublicInputs(sandboxHandle: Sandbox): void {
  void sandboxHandle.importTree([{ kind: 'file', path: 'src/main.ts', byteLength: 1, executable: false,
    open: () => [Uint8Array.of(65)] }], { quotas: { maxTotalBytes: 20n * 1024n ** 3n } });
  const process = sandboxHandle.reserveProcess({ executable: '/usr/bin/agent', args: ['--stdio'], env: {}, cwd: '/workspace/work' });
  void process;
  void sandboxHandle.exportTree({ kind: 'files', paths: ['artifacts/result.json'] }, async (entry) => {
    if (entry.kind === 'file') for await (const chunk of entry.bytes) void chunk;
  });
  void sandboxHandle.exportTree({ kind: 'subtree', path: 'artifacts' }, async (entry) => {
    if (entry.kind === 'file') for await (const chunk of entry.bytes) void chunk;
  });
  // @ts-expect-error A subtree selects one root and cannot carry a multiple-file selection.
  void sandboxHandle.exportTree({ kind: 'subtree', path: 'artifacts', paths: ['other'] }, async () => {});
  // @ts-expect-error A validated backend subtree path must cross canonical relative-path admission.
  const uncheckedSubtree: SandboxInputTreeSelection = { kind: 'subtree', path: 'artifacts' };
  void uncheckedSubtree;
  // @ts-expect-error A directory cannot carry a body or file length.
  void sandboxHandle.importTree([{ kind: 'directory', path: 'src', byteLength: 1 }]);
  // @ts-expect-error Retired arrays of complete file buffers are not the transfer boundary.
  void sandboxHandle.importFiles([]);
}
void acceptInlinePublicInputs;

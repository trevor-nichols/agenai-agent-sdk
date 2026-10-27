// ------------------------------------------------------------------------------------------------
//                contracts.typecheck.ts - Branded parsed values and ergonomic public inputs
// ------------------------------------------------------------------------------------------------

import { parseSandboxId, parseSandboxNamespace, parseSandboxRelativePath } from '../src/index.js';
import type { Sandbox, SandboxFiles, SandboxFileWriteResult, SandboxId, SandboxInputTreeSelection, SandboxNamespace, SandboxNetworkPolicy, SandboxProcessExit, SandboxRelativePath, SandboxTreeEntry, SandboxTransferSummary, SandboxWorkspaceDiskQuota } from '../src/index.js';
import type { SandboxDriverStartOptions } from '../src/backend/index.js';

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

const restricted: SandboxNetworkPolicy = { kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] };
// @ts-expect-error Restricted HTTPS must carry its complete explicit destination catalog.
const emptyAuthority: SandboxNetworkPolicy = { kind: 'restricted_https' };
// @ts-expect-error Baseline outbound mode cannot carry an unenforced destination restriction.
const ambiguousAuthority: SandboxNetworkPolicy = { kind: 'outbound', destinations: [{ hostname: 'api.example.com', port: 443 }] };
// @ts-expect-error Driver opening requires the neutral infrastructure-failure owner callback.
const missingInfrastructureOwner: SandboxDriverStartOptions = { checkpoint: async () => {} };
void restricted;
void emptyAuthority;
void ambiguousAuthority;
void missingInfrastructureOwner;

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

function acceptOnlyGrantedFiles(files: SandboxFiles): void {
  // @ts-expect-error A disabled capability cannot be dispatched before narrowing its grant.
  void files.stat('.');
  if (files.kind === 'disabled') return;
  void files.readFile('result.bin', async ({ entry, chunks }) => {
    const kind: 'file' = entry.kind;
    void kind;
    for await (const chunk of chunks) void chunk;
  });
  if (files.kind === 'read_only') {
    // @ts-expect-error Read-only handles do not expose write authority.
    void files.writeFile('result.bin', [], { mode: 'replace' });
  } else {
    void files.writeFile('result.bin', [Uint8Array.of(1)], { mode: 'create' });
    // @ts-expect-error A write cannot silently select replacement or exclusive-create semantics.
    void files.writeFile('result.bin', [Uint8Array.of(1)], {});
    // @ts-expect-error Live writes do not grant chmod or permission mutation.
    void files.writeFile('result.bin', [], { mode: 'replace', permissions: 0o777 });
  }
}
void acceptOnlyGrantedFiles;
// @ts-expect-error A completed publication must carry confirmed bytes and permissions.
const unconfirmedComplete: SandboxFileWriteResult = { kind: 'completed', effect: 'published', bytes: null };
// @ts-expect-error Rejection proves no publication and cannot carry unknown effects.
const contradictoryWrite: SandboxFileWriteResult = { kind: 'rejected', reason: 'already_exists', effect: 'unknown', bytes: 1n };
void unconfirmedComplete;
void contradictoryWrite;
const preservedLink: SandboxTreeEntry = { kind: 'symlink', path: 'alias', target: '../data.bin' };
// @ts-expect-error A symbolic link cannot carry a regular file payload.
const linkBody: SandboxTreeEntry = { kind: 'symlink', path: 'alias', target: 'data.bin', open: () => [] };
// @ts-expect-error Regular-file counts do not silently include symbolic links.
const missingLinkCount: SandboxTransferSummary = { files: 1n, directories: 0n, payloadBytes: 1n, archiveBytes: 512n };
void preservedLink;
void linkBody;
void missingLinkCount;

// ------------------------------------------------------------------------------------------------
//                filesystem.ts - Credential-free directory round trip through a borrowed sandbox
// ------------------------------------------------------------------------------------------------

import type { Sandbox, SandboxTransferOptions } from "@agen-ai/sandbox";
import { exportSandboxDirectory, importSandboxDirectory } from "@agen-ai/sandbox/node";

/** Uses default directory-source chunks and leaves sandbox/storage cleanup with its caller. */
export async function roundTripSandboxDirectory(sandbox: Sandbox, sourceRoot: string, destination: string,
  options?: SandboxTransferOptions) {
  const imported = await importSandboxDirectory(sandbox, sourceRoot, options);
  await sandbox.stop();
  const exported = await exportSandboxDirectory(sandbox, { kind: "workspace" }, destination, options);
  return Object.freeze({ directory: exported.directory, imported, exported: exported.summary });
}

/** Preserves the selected root and descendants under their workspace-relative paths. */
export async function exportSandboxSubtree(sandbox: Sandbox, path: string, destination: string,
  options?: SandboxTransferOptions) {
  await sandbox.stop();
  return exportSandboxDirectory(sandbox, { kind: "subtree", path }, destination, options);
}

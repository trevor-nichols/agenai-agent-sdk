// ------------------------------------------------------------------------------------------------
//                index.ts - Explicit Node filesystem capabilities - No ambient directory selection
// ------------------------------------------------------------------------------------------------

export { createSandboxSpillStore, SandboxSpillCleanupError } from './spill.js';
export type { SandboxSpillStoreOptions } from './spill.js';
export { parseSandboxSpillDirectory, verifySandboxSpillDirectory } from './spillDirectory.js';
export { importSandboxDirectory } from './directories/import.js';
export { exportSandboxDirectory } from './directories/export.js';
export { SandboxDirectoryCleanupError } from './directories/types.js';
export type { SandboxDirectoryImportOptions, SandboxDirectoryExportResult } from './directories/types.js';
export { readSandboxCredentialFile } from './credentials/source.js';
export { prepareSandboxCredentialBootstrap } from './credentials/prepare.js';
export { reserveSandboxCredentialProcess } from './credentials/process.js';
export type {
  SandboxCredentialFileReadOptions, SandboxCredentialProcessInput,
  SandboxCredentialBootstrapPreparationOptions, SandboxCredentialBootstrapPreparation,
} from './credentials/types.js';

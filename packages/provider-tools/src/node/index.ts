// ------------------------------------------------------------------------------------------------
//                index.ts - Node-only owned-tool entry: workspace preparation, owner and tool definitions
// ------------------------------------------------------------------------------------------------

export { prepareNodeProviderWorkspace } from './workspace.js';
export { openNodeProviderToolOwner } from './owner.js';
export type { NodeProviderNativeExecutable, NodeProviderToolOwner } from './owner.js';
export { nodeProviderToolDefinitions } from './catalog.js';
export type { NodeProviderToolDefinition } from './catalog.js';
export type { NodeProviderPlatform } from './identity.js';
export type {
  NodeProviderEditApproval,
  NodeProviderToolApprovalRequest,
  NodeProviderToolCallInput,
  NodeProviderToolCommandReceipt,
  NodeProviderToolFileChange,
  NodeProviderToolObserver,
  NodeProviderToolRefusal,
  NodeProviderToolResult,
  NodeProviderToolSession,
  NodeProviderToolStart,
  NodeProviderToolStatus,
} from './contracts.js';

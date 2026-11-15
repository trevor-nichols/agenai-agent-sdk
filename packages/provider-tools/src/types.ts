// ------------------------------------------------------------------------------------------------
//                types.ts - Plain owned-tool, workspace and credential contracts - Dependencies: none
// ------------------------------------------------------------------------------------------------

export const NODE_PROVIDER_TOOL_NAMES = Object.freeze(['read', 'glob', 'grep', 'write', 'edit', 'patch', 'bash'] as const);
export type NodeProviderToolName = (typeof NODE_PROVIDER_TOOL_NAMES)[number];

/** A prepared private store outside command-visible system paths; only `work/` is the provider workspace. */
export interface NodeProviderWorkspace {
  readonly storeDirectory: string;
  readonly workspaceDirectory: string;
}

/**
 * Workspace-relative selectors: literal characters plus `*` and `?` within one path segment and `**`
 * across segments. Deny wins over ask; read restrictions also restrict edits; edit-only restrictions
 * never hide readable content. At most 64 selectors per field and 512 UTF-8 bytes per selector.
 */
export interface NodeProviderFileRestrictions {
  readonly denyRead?: readonly string[];
  readonly askRead?: readonly string[];
  readonly denyEdit?: readonly string[];
  readonly askEdit?: readonly string[];
}

/** Caller limits may only reduce the documented package maxima. */
export interface NodeProviderToolLimits {
  /** Default 60,000 ms; maximum 600,000 ms. */
  readonly commandTimeoutMs?: number;
  /** Captured command output. Default 65,536 bytes; maximum 1,048,576 bytes. */
  readonly outputBytes?: number;
  /** Largest file read or written by a structured tool. Default 1,048,576 bytes; maximum 8,388,608 bytes. */
  readonly fileBytes?: number;
  /** Entries visited by one search. Default 2,000; maximum 20,000. */
  readonly searchEntries?: number;
  /** Calls admitted to the serial queue, including the entered call. Default 8; maximum 64. */
  readonly pendingCalls?: number;
}

export interface NodeProviderToolOptions {
  readonly workspace: NodeProviderWorkspace;
  /** An existing private directory outside command-visible system paths; receives one transient directory per materialization. */
  readonly stateParentDirectory: string;
  readonly bubblewrapPath: string;
  readonly filesystemHelperPath: string;
  readonly restrictions?: NodeProviderFileRestrictions;
  readonly limits?: NodeProviderToolLimits;
}

/** The initial explicit credential route. The secret is never serialized into evidence or errors. */
export interface NodeProviderApiCredential {
  readonly kind: 'api_key';
  readonly value: string;
}

/** The only runtime driver configuration field. Secrets and containment stay in factory options. */
export interface NodeNativeProviderConfiguration {
  readonly model: string;
}

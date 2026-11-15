// ------------------------------------------------------------------------------------------------
//                owner.ts - Materialized owned-tool resources: lease, private state, verified launchers
// ------------------------------------------------------------------------------------------------

import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { NodeProviderCleanupError, NodeProviderToolsError } from '../errors.js';
import type { NodeProviderToolOptions, NodeProviderWorkspace } from '../types.js';
import { ToolSession } from './broker.js';
import { runCommand } from './command.js';
import type { NodeProviderEditApproval, NodeProviderToolSession } from './contracts.js';
import { startHelper } from './helper.js';
import { admitProcess, assertExecutableUnchanged, toolPins, verifyExecutable, type NodeProviderPlatform, type VerifiedExecutable } from './identity.js';
import { acquireWorkspaceLease, type WorkspaceLease } from './lease.js';
import { COMMAND_SYSTEM_ROOT } from './namespace.js';
import { absolutePath, parseToolOptions, type ParsedToolOptions } from './options.js';
import { createFileRestrictions } from './restrictions.js';
import { validateWorkspaceLayout } from './workspace.js';

const LAUNCHER_BYTES = 16 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 10_000;

/** The driver's own native executable, verified against the driver package's exact per-platform pins. */
export interface NodeProviderNativeExecutable {
  readonly path: string;
  readonly sha256: Readonly<Record<NodeProviderPlatform, string>>;
  readonly maxBytes: number;
}

export interface NodeProviderToolOwner {
  readonly platform: NodeProviderPlatform;
  readonly uid: number;
  readonly gid: number;
  readonly workspace: NodeProviderWorkspace;
  /** Private transient directory for the provider process's own home, configuration and temporary files. */
  readonly stateDirectory: string;
  /** The verified native executable path; call `assertNativeUnchanged` immediately before each launch. */
  readonly nativeExecutablePath: string;
  assertNativeUnchanged(): Promise<void>;
  /** One live tool session at a time, each with a fresh filesystem helper. */
  openSession(input: Readonly<{ editApproval: NodeProviderEditApproval }>): Promise<NodeProviderToolSession>;
  /** Closes the session, the lease and the state directory; a failure keeps every resource retained. */
  dispose(): Promise<void>;
}

async function privateParent(path: string, uid: number, gid: number, store: string): Promise<void> {
  const info = await lstat(path).catch((cause: unknown) => {
    throw new NodeProviderToolsError('invalid_options', 'The state parent directory does not exist.', { cause });
  });
  if (!info.isDirectory() || info.uid !== uid || info.gid !== gid || (info.mode & 0o077) !== 0 || await realpath(path) !== path
    || path === store || path.startsWith(`${store}/`)) {
    throw new NodeProviderToolsError('invalid_options', 'The state parent must be a physical caller-owned directory closed to other users and outside the store.');
  }
}

/**
 * Unproven processes kept by the owner. The handle given to a caller and the owner's own release run
 * the same single-flight retry, and each removes itself only once its process is proven gone.
 */
function retainedProcesses() {
  const owned = new Set<() => Promise<void>>();
  return {
    get size() { return owned.size; },
    retain(retry: () => Promise<void>): () => Promise<void> {
      const handle = async () => { await retry(); owned.delete(handle); };
      owned.add(handle);
      return handle;
    },
    async settle(): Promise<void> {
      const errors: unknown[] = [];
      for (const handle of [...owned]) await handle().catch((error: unknown) => { errors.push(error); });
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Provider tool processes remain unjoined.');
    },
  };
}

type Retained = ReturnType<typeof retainedProcesses>;

/** Keeps a helper launch that failed with an unproven namespace, rethrowing with the shared retry. */
function retainHelperFailure(retained: Retained) {
  return (error: unknown): never => {
    if (!(error instanceof NodeProviderCleanupError)) throw error;
    throw new NodeProviderCleanupError({ message: error.message, cause: error.cause, cleanupError: error.cleanupError, retryCleanup: retained.retain(error.retryCleanup) });
  };
}

/** Proves before any inference that a networkless command namespace both runs and joins. */
async function preflight(bubblewrap: VerifiedExecutable, options: ParsedToolOptions, retained: Retained): Promise<void> {
  const result = await runCommand({
    bubblewrap, workspace: options.workspaceDirectory, command: 'exit 0', timeoutMs: PREFLIGHT_TIMEOUT_MS, outputBytes: 4_096, signal: new AbortController().signal,
  });
  if (result.unsettled) retained.retain(result.unsettled);
  if (result.reason !== 'exited' || result.exitCode !== 0 || !result.started || !result.joined) {
    throw new NodeProviderToolsError('namespace_unavailable', `Command namespaces are unavailable (${result.reason}, exit ${result.exitCode ?? result.signal}): ${result.stderr.trim().slice(0, 400)}`);
  }
}

/**
 * Materializes owned tools for one prepared workspace. Verification, preflight and lease all
 * complete before this resolves; partial acquisition is released or surfaced with a retry handle.
 */
export async function openNodeProviderToolOwner(input: NodeProviderToolOptions, native: NodeProviderNativeExecutable): Promise<NodeProviderToolOwner> {
  const options = parseToolOptions(input);
  const identity = admitProcess();
  const pins = toolPins(identity.platform);
  const nativeSha256 = native.sha256[identity.platform];
  if (!absolutePath.safeParse(native.path).success || typeof nativeSha256 !== 'string' || !Number.isSafeInteger(native.maxBytes) || native.maxBytes < 1) {
    throw new NodeProviderToolsError('invalid_options', 'The native executable must be a canonical absolute path with a pin for this platform.');
  }
  const [bubblewrap, helper, executable] = await Promise.all([
    verifyExecutable(options.bubblewrapPath, pins.bubblewrap, LAUNCHER_BYTES, identity.uid),
    verifyExecutable(options.filesystemHelperPath, pins.helper, LAUNCHER_BYTES, identity.uid),
    verifyExecutable(native.path, nativeSha256, native.maxBytes, identity.uid),
  ]);
  if (await realpath(COMMAND_SYSTEM_ROOT) !== COMMAND_SYSTEM_ROOT) {
    throw new NodeProviderToolsError('namespace_unavailable', 'The command system mount must be a physical /usr directory.');
  }
  await validateWorkspaceLayout(options.storeDirectory, identity.uid, identity.gid);
  await privateParent(options.stateParentDirectory, identity.uid, identity.gid, options.storeDirectory);
  const restrictions = createFileRestrictions(options.restrictions);
  const lease: WorkspaceLease = await acquireWorkspaceLease(options.storeDirectory, identity.uid, identity.gid);
  const retained = retainedProcesses();
  const launch = () => startHelper({ bubblewrap, helper, storeDirectory: options.storeDirectory, uid: identity.uid, gid: identity.gid })
    .catch(retainHelperFailure(retained));
  let stateDirectory: string | undefined;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releasing ??= (async () => {
      await retained.settle();
      if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
      stateDirectory = undefined;
      await lease.release();
    })().finally(() => { releasing = undefined; });
    return releasing;
  };
  try {
    stateDirectory = await mkdtemp(`${options.stateParentDirectory}/agenai-provider-`);
    await preflight(bubblewrap, options, retained);
    const probe = await launch();
    await probe.close().catch(async (cause: unknown) => {
      await probe.close().catch((cleanupError: unknown) => {
        retained.retain(() => probe.close());
        throw new NodeProviderToolsError('helper_unavailable', 'The probe filesystem helper did not settle.', { cause: new AggregateError([cause, cleanupError]) });
      });
      throw cause;
    });
  } catch (cause) {
    await release().catch((cleanupError: unknown) => {
      throw new NodeProviderCleanupError({ message: 'Provider tools failed to open and their resources could not be released.', cause, cleanupError, retryCleanup: release });
    });
    throw cause;
  }
  const state = stateDirectory;
  let session: ToolSession | undefined;
  let disposed = false;
  let opening: Promise<unknown> | undefined;
  let disposal: Promise<void> | undefined;

  const settle = async (): Promise<void> => {
    disposed = true;
    await opening?.catch(() => {});
    if (session) {
      await session.close();
      session = undefined;
    }
    await release();
  };
  const dispose = (): Promise<void> => {
    disposal ??= settle().catch((cleanupError: unknown) => {
      disposal = undefined;
      throw new NodeProviderCleanupError({ message: 'Provider tool resources did not settle.', cleanupError, retryCleanup: dispose });
    });
    return disposal;
  };

  return Object.freeze({
    platform: identity.platform,
    uid: identity.uid,
    gid: identity.gid,
    workspace: Object.freeze({ storeDirectory: options.storeDirectory, workspaceDirectory: options.workspaceDirectory }),
    stateDirectory: state,
    nativeExecutablePath: executable.path,
    assertNativeUnchanged: () => assertExecutableUnchanged(executable),
    async openSession(request: Readonly<{ editApproval: NodeProviderEditApproval }>): Promise<NodeProviderToolSession> {
      if (disposed) throw new NodeProviderToolsError('closed', 'The provider tool owner is disposed.');
      if (session || opening) throw new NodeProviderToolsError('session_active', 'The provider tool owner already has a live session.');
      if (retained.size > 0) throw new NodeProviderToolsError('session_active', 'A failed session helper is still owned; settle its retry first.');
      if (request.editApproval !== 'automatic' && request.editApproval !== 'host') {
        throw new NodeProviderToolsError('invalid_options', 'Edit approval must be automatic or host.');
      }
      const attempt = (async () => {
        const helperProcess = await launch();
        session = new ToolSession({ helper: helperProcess, bubblewrap, restrictions, options, editApproval: request.editApproval });
        return session;
      })();
      opening = attempt;
      let opened: ToolSession;
      try { opened = await attempt; } finally { opening = undefined; }
      if (disposed) throw new NodeProviderToolsError('closed', 'The provider tool owner was disposed while the session opened.');
      return Object.freeze({
        call: opened.call.bind(opened),
        get fence() { return opened.fence; },
        idle: opened.idle.bind(opened),
        async close() {
          await opened.close();
          if (session === opened) session = undefined;
        },
      });
    },
    dispose,
  });
}

# Combine sandbox capabilities

[`runCombinedSandboxWorkflow`](workflow.ts) is a concrete, credential-free example using only
public sandbox entrypoints. Importing it performs no preparation or sandbox operation. The
installed platform consumer compiles the same entrypoint to
`platform-dist/examples/sandbox/combined/index.js`; the generic platform `combined` row invokes
that installed code. Desktop MS006 native N2 and AVF/Rosetta R1 each passed thirteen installed
cases with 62 final-empty scopes on packed-ms006-r3; real Linux x64 R1 passed eleven combined
cases, plus fresh eighteen-case live-file and 68-case preserving-transfer rows, with complete row
cleanup. Fresh Linux network R1 separately passed all 46 network/recovery cases and 378 independent
absence observations against the current installed candidate. Exact artifacts, tuples
and earlier individual capability results are in [the handoff](../HANDOFF.md#desktop-and-linux-combined-native-campaigns-2026-10-27).

The example imports a fixed tree into an actually empty workspace: `source.txt`, its raw relative
link `source-link.txt`, an executable `tool.sh`, `live.txt` and the controlled `program.mjs`. One
Node process checks the link and executable. While that process remains active, the controller
reads and atomically replaces `live.txt`, then the program verifies the replacement and requests
the explicitly selected HTTPS response through CONNECT with certificate verification. The
controller checks its status, exact body length and SHA-256. A second explicit target must reject
direct TCP establishment and CONNECT. The caller independently proves that same forbidden
address/port/probe/marker reachable and observes its listener counters; an unreachable fixture
does not establish isolation.

`mode: 'normal'` ends program input and requires exit code zero, then joins whole-sandbox stop.
`mode: 'cancel'` keeps the process active, aborts an entered provisional live write, retains its
`effect: 'unknown'`/null-byte receipt, then stops the whole sandbox while joining the source
exactly once. It never retries the write. Both modes preserve the original relative link during
final workspace export **after stop**. The example checks every published name, byte, mode,
raw target and summary count: five regular files and one link; the provisional cancellation name
must be absent. Destruction follows export, and the caller retains the published host directory.
The controlled Docker import uses mode `0700` for `tool.sh` and `0600` for ordinary files;
replacing `live.txt` preserves its observed `0600`. Host directory publication preserves executable
intent and deliberately creates executable files with `0700` and ordinary files with `0600`.
It does not reproduce every guest permission bit.

## Select the caller's inputs

Prepare the workload, native filesystem and egress helpers, and the platform's route authority
explicitly using the [Docker construction guide](../../../packages/sandbox-docker/README.md).
On Desktop, also prepare the exact Darwin executable and arm64 VM route-observer image and
capture the required settings assertions. The workload image must contain `/usr/local/bin/node`
and the ordinary admitted shell tools. No image is pulled, built or selected by this example.
Backend `spillDirectory`, namespace, image IDs, user, helper/control budgets and opaque original
authority handles belong to the caller. Keep their storage and topology quiescent through cleanup.

Supply a complete request selecting `files: { kind: 'read_write' }`, `restricted_https` with the
positive hostname/port explicitly listed, and your own CPU/RAM/PID/tmpfs, stream, transfer,
startup/cleanup and execution policies. The forbidden CONNECT target must be omitted. The
fixture is deliberately IPv4; this example makes no IPv6 connectivity claim. Select a finite
`operationTimeoutMs` for each program observation; it does not change the execution lifetime.
The positive response is bounded to 256 KiB. Both fixture commands and process output are bounded.

Choose a new canonical host `destination` beneath an existing physical directory under your
exclusive ownership. Directory publication reserves that namespace and returns its `files` child.
The controller needs filesystem permission for preserving symlinks; Node 24.18.0 requires full
filesystem read/write permission for `fs.symlink`, beyond path-scoped permission grants. It also
needs its deliberately configured Engine/native-observer authority. Neither authority enters the
guest. A successful returned path is retained output, never automatically removed scratch.

From copied example source, after constructing and inspecting these explicit inputs:

```ts
import { runCombinedSandboxWorkflow, CombinedSandboxWorkflowError } from './combined/index.js';

try {
  const result = await runCombinedSandboxWorkflow({
    backend: preparedBackend,
    request: selectedRequest,
    recovery: { kind: 'persisted', persist: persistOriginalCheckpoint },
    mode: selectedMode, // 'normal' or 'cancel'
    operationTimeoutMs: selectedObservationBudget,
    positive: inspectedHttpsFixture, // hostname, port, path, status, bodyBytes, bodySha256
    forbidden: ownedReachableFixture, // hostname, address, port, probe, marker
    destination: freshOwnedDestination,
    transferOptions: selectTransferOptions,
    onObservation: persistAuditObservation,
  });
  console.log(result.directory, result.exported, result.cancellation);
} catch (error) {
  if (error instanceof CombinedSandboxWorkflowError) {
    // Keep this live error/owner and the original checkpoints until explicit cleanup succeeds.
    retainFailureAndCleanupOwner(error);
  }
  throw error;
}
```

Every identifier above is an explicit caller input or caller-owned persistence function. The
example supplies no endpoint, account, provider, credentials, model, business duration, default
resource policy or persistence location. `transferOptions(operation)` may provide fresh transfer
deadlines/cancellation/quotas; preserving-link policy is fixed by this example. `onObservation`
is awaited audit delivery of actual phases and sandbox identity, without a success override or
callback that executes a replacement workload. Its failure stops progression and is retained.

`CombinedSandboxWorkflowError` preserves the primary failure separately from cleanup failures,
any additional joined reader errors, the original reservation and an explicit `retryCleanup()`.
Unexpected stderr remains an operation failure after its readers settle, including when an
earlier stdout closure was observed first. A destroyed owner has completed its sandbox cleanup;
historical reader errors do not make `retryCleanup()` fail again. It never automatically replays the
program, write or failed cleanup. A directory cleanup error remains in `primaryFailure.error`
and is also joined by that retry. Published output remains caller-owned after either success or
a later failure. For controller death, first quiesce the original controller and entered operations,
then reconcile the complete original trusted checkpoint using the matching backend configuration.
Recovery restores cleanup ownership; it does not resume this example or reconstruct an agent session.

# Administrative Desktop uncertain-create recovery

This runbook describes the public `/node` recovery API introduced in published `0.4.10`; published `0.4.9` does not expose it. The administrative recovery campaign qualified one exact installed development candidate. Current source prepares an unpublished coordinated `0.4.11` candidate; publication remains separate. The [public qualification record](../HANDOFF.md#administrative-uncertain-create-recovery-2026-11-02) records the original archive, observer, cleanup and fresh-process confirmation. A later package must establish its applicability to those qualified runtime and native bytes before using that evidence.

The operation grants cleanup of one original coordinated generation. It cannot resume sandbox execution. Importing the API and constructing a controller are inert; `open()` acquires authority. The SDK never runs Docker Desktop stop/start, resets the Engine or builds its helper implicitly.

## Supported composition

Use the exact `stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1` profile:

- Native-arm64 macOS controller and observer, with the fixed `/Applications/Docker.app` installation. Installed MS004 proof used M3/macOS 26.5.1 and Node 24.18.0.
- Stock Docker Desktop 4.54.0/build 212467, Engine 29.1.2 (`de45c2a`), API 1.52 and Linux 6.12.54-linuxkit. Admission pins the packaged executable/code-signing identities as well as component versions; matching version strings alone do not admit a different installation.
- Apple Virtualization, the admitted native-arm64 VM, unchanged persistent Engine/store identity, original same-user Unix endpoint and original OS account. The recorded store uses overlayfs with the containerd snapshotter and `/var/lib/docker` root.
- Caller quiescence across the shared Engine: no sandbox writers, member operations, running/paused/restarting/removing containers or competing lifecycle/topology actors before arming. Join original operations and take a fresh complete census. A responsive Engine endpoint alone does not prove the required live virtualization producer exists.

Docker upgrades, Rosetta recovery, alternate stores, arbitrary native profiles and reset recovery are outside this qualification. If admission refuses the installation or producers, retain the failure and investigate it; do not substitute a profile, weaken a guard or repeatedly restart Desktop.

## Retain the original inputs

Keep these inputs and their verified identities throughout preparation, recovery and confirmation:

| Input | Required identity |
| --- | --- |
| Original coordinator options | The original `DockerDesktopCoordinatorOptions`, including its reconstructed explicit route authority and original coordinator helper protocol, source digest, executable path and SHA-256. |
| Original generation | The exact `expectedGeneration`, canonical journal and original exclusive claim. The previous controller and all entered operations must be quiescent before recovery takes that claim. |
| Member configurations | Each member's own `DockerDesktopCoordinatorMemberConfiguration`, excluding the live coordinator capability. Preserve its original endpoint/profile, configuration revision, images, user, namespaces, storage, helper and network configuration. A member revision need not equal the coordinator's revision. |
| Recovery records | Trusted complete original checkpoints and every later SDK-returned settled record. Select the current record from `controller.members`; do not replace it with an older external checkpoint. |
| Recovery observer | A separately prepared descriptor with protocol, source digest, final immutable absolute executable path and verified binary SHA-256 matching the selected SDK. |

Live route-authority objects are explicitly reconstructed through the public constructor from the original retained data; serializing a function or inventing a new configuration does not restore authority. The original prepared coordinator executable remains part of the binding even though the recovery observer is a separate executable.

Canonical storage is under `Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1` in the home directory returned by the OS account database, keyed by the actual Engine identity. Neither `HOME` nor an API option relocates it. Preserve canonical bytes, original origin archive, receipt store and claim files. Copies are evidence only. Do not initialize a replacement generation, copy authority, edit a journal or translate a record manually.

## Prepare and explicitly build the observer

Use installed ESM exports. This fragment supplies caller-inspected toolchain values; it performs only preparation writes to a fresh private build directory:

```ts
import { prepareDockerDesktopRecoveryHelper } from '@agen-ai/sandbox-docker/node';
import type { DockerDesktopRecoveryPreparationOptions } from '@agen-ai/sandbox-docker/node';

declare const options: DockerDesktopRecoveryPreparationOptions;
// options.directory: fresh canonical absolute build directory.
// options.toolchain: compiler { path, sha256 }, sdk { path, version }, deploymentTarget.
const preparation = await prepareDockerDesktopRecoveryHelper(options);
```

Preparation writes thirteen fixed C/header assets, `manifest.json`, `commands.json` and the offline recipe. It does not execute the compiler, observer, Docker or any download. Inspect the manifest, compare the compiler hash and SDK/deployment selection, then explicitly execute each `preparation.commands` executable/argument array in order with `cwd: preparation.directory`. Join each child and both output streams before continuing, and stop on any failed command. Do not concatenate the arguments into a shell command.

The recipe compiles for Darwin arm64, repeats the build at the same output path, requires byte equality, hashes the resulting binary and reports its code signature. Retain command outcomes and compiler, source and binary hashes. MS004 used the recorded Command Line Tools compiler, macOS 26.5 SDK and deployment target 13.0; the qualification record retains the exact identities.

Choose the final helper path before opening recovery. Install verified bytes beneath canonical, root- or same-account-owned physical ancestry, without symlink or unsafe writable components. Retain the admitted executable and its path unchanged. In particular, a user-owned group-writable external-volume ancestor is unsuitable even if the executable itself is private. Construct the descriptor with `preparation.protocol`, `preparation.sourceDigest` and the final executable `{ path, sha256 }`; the executable hash is lowercase hexadecimal, while `sourceDigest` includes `sha256:`. Native opening independently verifies these inputs. An offline recipe or descriptor alone is not native admission.

## Keep one controller alive

Construct it with original coordinator options and the separately verified recovery helper:

```ts
import { createDockerDesktopRecoveryController } from '@agen-ai/sandbox-docker/node';
import type { DockerDesktopRecoveryControllerOptions } from '@agen-ai/sandbox-docker/node';

declare const original: DockerDesktopRecoveryControllerOptions['original'];
declare const helper: DockerDesktopRecoveryControllerOptions['helper'];
declare const expectedGeneration: string;

const recovery = createDockerDesktopRecoveryController({
  original,
  helper,
  desktop: {
    profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1',
    applicationPath: '/Applications/Docker.app',
  },
});
const wait = { timeoutMs: 60_000 };
await recovery.open({ expectedGeneration }, wait);
```

Retain this controller across every phase and failure. Do not launch a separate process for each method. `open()` validates original identities, preserves the original payload and claims the original journal; it may resume a durable acceptance or terminal publication. Read the returned state before deciding the next action:

| State after open | Next action |
| --- | --- |
| `ready`, `barrier: 'required'` | Inspect current members and resolve any entered operations. A missing no-ID container remains uncertain until an actual observation is accepted. Follow the explicit observation below if that proof is needed. |
| `ready`, `barrier: 'accepted'` | Resume exact member cleanup. Do not start another observation or lifecycle. |
| `terminal_ready` | Join `settle()` and `close()` to finish durable terminal publication; do not repeat lifecycle or resource operations. |
| `closed`, `result: 'clean'` | The original clean handback is complete. Retain the final records and independently verify absence. |
| Failure or any incompatible state | Stop progression and follow the retained-owner procedure below. |

Known-ID resources can be cleaned through their original owners before a barrier. An absent name for a container create that lost its returned ID is still uncertain, not permission to declare it absent. Unresolved non-container creation without an original ID is unsupported and leaves the original journal unchanged. Do not create a placeholder resource to resolve uncertainty.

## Observe one explicitly authorized graceful lifecycle

Before entry, quiesce all original member activity, join its owners and take a fresh zero-running census of the actual shared Engine. Other users' stopped resources remain borrowed. Keep a separate record of unrelated containers, volumes, custom networks and images for the final comparison.

The caller owns the normal lifecycle actions. In this sequence, `stopDesktopAndJoin` and `startDesktopAndJoin` are caller-provided functions, **not SDK exports**. They enter only the reviewed stock graceful operation and retain its actual child and readers. For an entered child, they settle only after its close and both streams join. The stop helper calls `onEntered` exactly once from the child's successful `spawn` event, before awaiting its exit; it must not call it merely because the helper was invoked or a spawn was requested. A pre-entry spawn failure leaves the flag false and does not trigger a start. They do not force, kill, reset, retry lifecycle automatically or substitute a CLI timeout for a joined child.

```ts
declare const stopDesktopAndJoin: (onEntered: () => void) => Promise<void>;
declare const startDesktopAndJoin: () => Promise<void>;

await recovery.beginObservation(wait);
const armed = recovery.state;
if (armed.kind !== 'observing' || armed.phase !== 'armed') {
  throw new Error('Recovery did not acknowledge the armed observation.');
}

const failures: unknown[] = [];
let stopEntered = false;
try {
  await stopDesktopAndJoin(() => { stopEntered = true; });
  await recovery.observeStopped(wait); // Desktop must still be fully stopped.
} catch (error) {
  failures.push(error);
} finally {
  if (stopEntered) {
    try {
      await startDesktopAndJoin(); // Restore availability after any entered-stop failure.
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length) throw new AggregateError(failures, 'Recovery lifecycle did not settle successfully.');

await recovery.finishObservation(wait);
```

Run this sequence only from `ready` / `required`, after the actual `beginObservation()` acknowledgement. If any step rejects, preserve its original failure and every cleanup/start failure separately, restore availability after an entered stop, and stop progression. Never proceed to member destruction on the strength of an earlier state read. A failed normal start remains a caller-owned availability obligation; it cannot be hidden by releasing the SDK controller.

The observer must join the original producer lifetimes, establish the complete stopped interval and validate fresh VM boot, persistent Engine/store restoration and native-covered startup bytes. Init records are classified; console bytes remain opaque but are still fully covered by the bounded native span/digest manifest. Neither copied logs, matching Engine IDs, a fixed sleep nor a caller readiness hint grants an accepted barrier. `finishObservation()` must succeed and report `ready` / `accepted` before using its absence proof.

## Reconcile and close the original generation

Reread `recovery.members` after acceptance and after any settled change. For each original member, use its current SDK-returned record with **that member's** original configuration. `reconcile()` returns `matched` or `uncertain` with an original cleanup owner, `conflict` with a reason, or `absent` with a record. A conflict stops cleanup; uncertainty retains ownership and does not grant execution.

This fragment shows the owner-bearing result. The checkpoint callback is caller storage, not an SDK export. Keep `result.owner` reachable if any write or cleanup step fails:

```ts
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerDesktopCoordinatorMemberConfiguration } from '@agen-ai/sandbox-docker';

declare const record: SandboxRecoveryRecord; // Selected from the latest recovery.members.
declare const configuration: DockerDesktopCoordinatorMemberConfiguration;
declare const persistCheckpoint: (record: SandboxRecoveryRecord) => Promise<void>;

const result = await recovery.reconcile({ configuration, record });
if (result.kind === 'matched' || result.kind === 'uncertain') {
  const owner = result.owner;
  await persistCheckpoint(owner.recoveryRecord);
  await owner.stop();
  await persistCheckpoint(owner.recoveryRecord);
  await owner.destroy();
  await persistCheckpoint(owner.recoveryRecord);
}
```

Handle `conflict` and `absent` explicitly in the caller; do not let either silently skip an original member. Preserve exact terminal records after retirement. Reconciliation can advance an inspected identity; persist the returned record before a later cleanup action. Destruction is limited to the original exact resource inventory, never label discovery or a broad sweep.

After every original member has settled, call `await recovery.settle(wait)` and `await recovery.close(wait)`. Only successful `closed` / `clean` handback permits an ordinary coordinator to use the generation again. `close()` independently checks every original name and known ID before committing clean. Completed durable terminal manifests allow interrupted final publication to join offline without another lifecycle.

Independently inspect every original resource name and known ID, including planned/previously absent roles, and retain the exact absence results. Compare unrelated application resources exactly. A normal Desktop restart can replace the Unix socket and built-in bridge network ID; record that specific platform change separately rather than ignoring networks generally. A fresh controller process can `open({ expectedGeneration })` and `close()` on the completed original generation, rediscovering its archived records without another lifecycle. Use the same explicit replacement intent if it was required for that completed binding.

## Failures retain their original owners

Controller waits default to 30 seconds and accept explicit bounds from 1 to 60,000 milliseconds. Their timeout or signal interrupts the **wait**, not necessarily the entered operation. Repeating the same phase on the same controller joins its actual work; another phase can report `busy`. Retain the controller and original error, and use a fresh non-aborted wait. Do not infer settlement from a rejected promise or open a competing holder to bypass it.

`DockerDesktopRecoveryError` exposes its closed `failure` and original `owner`. Cleanup failures retain the original `SandboxCleanupError.owner`; join or retry that owner's same `stop()` or `destroy()` rather than reconstructing cleanup from a stale record. If a settled authority failure fenced the controller, explicitly reopen the **same** controller with the same generation/intent and require current `ready` admission before retrying cleanup. If the accepted barrier is no longer current, stop and retain ownership; do not silently begin another lifecycle.

`settle()` observes the entered work and can itself report its retained failure. It does not mark resources clean. When stopping unfinished recovery, explicitly join `settle()` and `release()`, recording their outcomes separately so a settlement error does not prevent the release attempt. A failed release still retains obligations and must be rejoined through the same owner; do not drop the process merely because private evidence persistence failed. Restore Desktop availability independently of SDK settlement/release, and retain child/output ownership until joined.

Successful `release()` durably retains unfinished recovery and releases the original claim. It does not delete resources, accept absence or reset failure history. A later explicit fresh controller may reopen that same generation. A passive attempt has a ten-minute continuous-clock bound and at most three minutes of restoration collection. Missed watches or a failed observation are not reconstructed: settle/release, then explicitly review and start a fresh attempt if warranted. No automatic lifecycle retry or command replay belongs in this runbook.

## Reviewed helper replacement only

Do not overwrite an observer already bound to a recovery generation. A corrected helper needs a new immutable path, a separately verified descriptor and explicit reviewed replacement support in the selected SDK. Current code supports only the bounded historical v1-to-v2 and v2-to-v3 successions; it is not a general migration registry, and v3 does not admit an additional replacement.

Construct the controller with the **new** helper. The replacement intent names the exact **immediate previously active** helper, including its original path and binary hash:

```ts
import type { DockerDesktopRecoveryHelper } from '@agen-ai/sandbox-docker/node';

declare const previousHelper: DockerDesktopRecoveryHelper;
await recovery.open({
  expectedGeneration,
  replaceHelper: { expected: previousHelper },
}, wait);
```

For the supported v1 predecessor, the old helper comes from immutable original preparation. For v2, use its active helper, not the older helper still retained in preparation. Supported historical source/profile pairs are fixed in the SDK; the caller cannot assert an arbitrary profile. The new descriptor must match the current packaged sources. Omitted intent preserves strict mismatch refusal, and conflicting intent cannot change an in-flight open.

Adoption requires the exact released closed-failure state, complete old receipt history and original origin archive, with no accepted barrier, queued/entered/owned work, absence settlement or member terminal. The new verified observer takes the same original claim; the SDK validates the old graph before its one durable conversion. Original resources, preparation, origin and issuer cutoffs remain unchanged. Receipts are checked against their exact attempt issuer, never against either helper indiscriminately. Preserve every old helper and receipt; do not copy or rewrite authority to obtain adoption.

After an interrupted conversion or a completed clean handback, repeating the same exact supported replacement intent is an idempotent join. It does not append another succession or advance an issuer cutoff. A matching current helper can reopen without repeating intent once the binding is durable. Stop on a different predecessor/successor, unreviewed format or unsupported chain; no reset, prune, manual journal translation or automatic repair fallback is provided.

# Upgrading to 0.4.8

`0.4.8` is an unpublished coordinated ten-package candidate; npm `latest` and `beta` remain
`0.4.7`. Agent Protocol V13 and recovery v3 are unchanged. Existing callers of
`createDockerSandboxBackend` keep their behavior and recovery identities. Keep every SDK package
at `0.4.8` together when testing the candidate.

## Concurrent restricted Desktop members

A restricted Desktop owner created with `createDockerSandboxBackend` still seals the shared Engine
and VM topology on its own, so a second restricted owner on the same Engine fences the first. To
run several restricted members at once, host one coordinator per physical Engine and OS user in a
single application process:

1. Prepare the coordinator helper with `prepareDockerDesktopCoordinatorHelper` from
   `@agen-ai/sandbox-docker/node`, build it with the emitted recipe and pass
   `{ protocol, sourceDigest, executable: { path, sha256 } }` as `helper` to
   `createDockerDesktopCoordinator`, together with an original prepared Desktop route authority.
2. Call `initialize()` once per OS user and Engine identity as a separate first-install step. It
   creates the canonical journal and no Docker resource. A Desktop reset that changes the Engine
   identity requires it again; until then `activate()` fails with `journal_invalid`.
3. Call `activate()` and pass the returned authority as `coordinator` to
   `createCoordinatedDockerSandboxBackend`, one backend per member. Each member keeps its own
   route authority, restricted-HTTPS configuration, namespace, spill directory and recovery
   persistence. Native arm64 and Rosetta amd64 members can share one generation.
4. Reserve, start, stop, export and destroy each member through its own sandbox owner. Members
   never stop or destroy peers.
5. Call `closeAdmission()`, destroy the remaining members, then `close()`. `close()` rejects with
   `retained_ownership` while any member or effect remains.

The coordinator admits at most four members and queues at most sixteen topology requests, four of
which are reserved for cleanup. The death of the hosting process fences the whole group;
independent controller-process survival is not supported. Coordinator methods and coordinated
`reserve()` throw `DockerDesktopCoordinatorError`, exported from `@agen-ai/sandbox-docker`. A group
fence reports `SandboxOperationError` `driver_failure` to every live member with that retained
error as `cause`; the operation that detected the loss rejects with its own original error.
Keep the Desktop host, VM, Engine, socket,
proxy and interception configuration stable until every member is destroyed. The
[Docker package guide](packages/sandbox-docker/README.md#concurrent-desktop-members) and the
[concurrency example](examples/sandbox/concurrency/README.md) describe failure domains, bounds and
cleanup in full.

After a crash, create a fresh inert coordinator with the original options once the old process is
gone, and call `reopenCleanup({ expectedGeneration })`. Reconcile each record in
`recovery.members` with its original member configuration, destroy each returned owner and
`close()`. Recovery grants no execution, never adopts resources by label and never forces a clean
receipt.

## Drain before switching modes

Coordinated members use backend revision `engine-1.52-v7-<profile>`; existing Desktop owners keep
`engine-1.52-v6-<profile>` and Linux keeps `engine-1.52-v5-linux-x64`. Records are never
translated. Before adopting coordinated mode on an Engine, stop and destroy every existing restricted
owner with its original controller and verify absence. To back out, close admission, destroy every
coordinated member with its original coordinator or through `reopenCleanup()`, confirm `close()`
succeeds, then return to the single-owner factory.

## Typed stream closure on stop

When `stop()` begins, open `stdout` and `stderr` readers now fail with `SandboxOperationError` code
`cancelled`, or with the infrastructure failure the owner recorded before stop. Earlier releases
ended them with Node's `ERR_STREAM_PREMATURE_CLOSE`. Update stop-time error filters to accept the
typed `cancelled` error and keep treating other errors as failures. The closure reason is fixed when
stop begins, so SDK-initiated stops (execution deadline, uncertain live writes, failed imports) also
reach readers as `cancelled`. Output not yet consumed when stop begins is discarded. A `stdin` write
after stop still gets Node's `ERR_STREAM_DESTROYED`. A backend output that fails before EOF reaches
readers as `stream_failure`.

## Known limits

- A member helper that dies on its own can change Engine or VM facts before its control loss is
  observed; the group then fences instead of staying member-local. This fails safe.
- Losing a member's broker, relay or filesystem control also quarantines that member's observer. If
  it was the group's only running observer, the group fences.
- A retirement stage observed out of order is accepted but never settles; the topology settlement
  timeout then fences the group.
- A member helper that Docker lists only under an `ep-<endpoint>` key before the coordinator has
  recorded its membership is not attributed to that member; acquisition then fails closed.

The [coordination record](examples/sandbox/HANDOFF.md#concurrent-desktop-coordination-native-campaigns-2026-10-31)
retains the native campaigns, their exact tuple and the results carried from earlier development
archives.

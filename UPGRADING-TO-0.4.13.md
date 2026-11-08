# Upgrading to 0.4.13

`0.4.13` is a coordinated ten-package patch for the Docker Desktop coordinator in
`@agen-ai/sandbox-docker`. Install the complete package family together. Agent Protocol V13,
neutral sandbox recovery v3, the coordinator journal format, public types and existing backend
identities are unchanged.

## `missing` proves an absent coordinator store

`initialize()`, `activate()` and `reopenCleanup()` reject with `journal_invalid` when the
coordinator's on-disk store cannot be used. Before this release, reason `missing` covered four
on-disk situations, and only two of them meant that nothing exists:

| What is on disk | 0.4.12 | 0.4.13 |
| --- | --- | --- |
| The store directories do not exist | `missing` | `missing` |
| The store directory holds no file for this Engine | `missing` | `missing` |
| Only some of this Engine's journal files exist | `missing` | `corrupt` |
| A store directory cannot be opened for another reason | `missing` | `corrupt` |

`missing` now means that no coordinator store exists for the Engine under the current macOS
account. It proves that the coordinator holds no record, not that no generation ever began,
because a store deleted after `activate()` looks the same. An application that records its own
activation can decide from that record; the
[Docker package README](packages/sandbox-docker/README.md#concurrent-desktop-members) gives the
rule and its preconditions. `corrupt` still means the store exists but is incomplete or unreadable,
and the SDK never repairs it. `reopenCleanup()` never reports `{ kind: 'absent' }` for a missing
store. Applications that refuse every `journal_invalid` reason need no change.

`DockerDesktopCoordinatorError` messages now name the failure's reason, scope, source or resource,
for example `Docker Desktop coordinator journal invalid (missing): no coordinator store exists for
this Engine and macOS account.` Match on `error.failure`, not on the message.

## Prepare the coordinator helper again

The coordinator helper now recognizes an absent store itself, so its source digest changes from
`sha256:db02b507a84eecf86eeaf36bdd665f3ff89d94a64b63190089a4c3407b161760` to
`sha256:314ce150f0f29757fabf30f4890e134110b5c3752e7544517f1f995244a506eb`. The coordinator
rejects a configured `helper.sourceDigest` that differs from the installed sources with
`preparation_invalid`. Run `prepareDockerDesktopCoordinatorHelper` from `0.4.13`, compile the
emitted sources with its recipe, and update `helper.sourceDigest` and `helper.executable.sha256`
together. The executable is checked only against its own configured hash, so an old binary with a
new digest still runs; it reports an absent store as `corrupt`, never as `missing`.

The administrative recovery helper is unchanged; its source digest remains
`sha256:308724c76940ccfaa66796b80d9cd9e83c159e7153115dd9d4b61145a5038d5b`. No egress helper source
changed. Applications already running the `0.4.11` egress helper keep it; applications upgrading
from an earlier release still follow the
[0.4.11 helper rebuild steps](UPGRADING-TO-0.4.11.md#rebuild-and-select-the-egress-helper).

## Qualification

The change qualified natively on Apple silicon with Docker Desktop 4.98.0 (build 245422) and
Engine 29.9.2, against a packed candidate of this source before its version change. A coordinator
helper built by the installed recipe, with the source digest above, passed the installed lifecycle
proof against the real Engine and the crash proof against a synthetic Engine. It reported every
store state in the real home as described above, and opened successfully in `open` and `cleanup`
modes. Directory-level states ran on a diagnostic build of the same sources. `reopenCleanup()` over
a dirty generation is covered by hermetic tests; its native helper paths are unchanged.

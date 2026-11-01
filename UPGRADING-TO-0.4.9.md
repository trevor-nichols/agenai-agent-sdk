# Upgrading to 0.4.9

The coordinated ten-package `0.4.9` source is a cleanup correction to `0.4.8`. It is a release
candidate until npm publication and stable promotion are independently verified. Upgrade the
complete package family together after publication. Agent Protocol V13, recovery v3, coordinator
journal format, native helpers, dependencies and backend identities are unchanged.

## Retain original cleanup owners

An entered coordinated Desktop delete or helper shutdown could reject while leaving its canonical
receipt pending. A subsequent original-owner retry then failed retained ownership validation.
The correction fences that exact entered effect before releasing its physical operation slot.
Original owners can inspect and settle their resource state after failed dispatch, a lost deletion
response or repeated failure without replaying an uncertain deletion.

A fence still removes execution admission from the group. Keep every original cleanup owner.
Join already-entered peer stop attempts, settle the failed member through its original owner, then
retry peer cleanup and close the coordinator. A rejected peer stop does not retire its obligation.
Do not translate records, force a clean journal, or replay provider execution. Existing crash
recovery still uses a fresh coordinator and `reopenCleanup()` with original configurations.

Read [the 0.4.8 upgrade guide](UPGRADING-TO-0.4.8.md) for coordinator adoption, mode draining,
shared failure domains and typed stream closure. The cleanup correction adds no new constructor,
platform profile, filesystem authority or network policy.

## Evidence and adoption

The [cleanup record](examples/sandbox/HANDOFF.md#original-owner-cleanup-correction-2026-11-01-unreleased)
retains the exact development candidate and failed attempts. Four targeted native arm64 Desktop
runs passed: single-member pre-delete rejection, two-member pre-delete rejection, lost successful
delete response and repeated original-owner rejection. Their 56 independent absence observations
and clean coordinator closes apply to that exact macOS/Node/Desktop/Engine/archive tuple.

Those development archives were labelled `0.4.8`; they are separate from the published `0.4.8`
archives and the newly packed `0.4.9` release. Source and installed-payload comparisons establish
applicability, not a native rerun on published bytes. Control-close rejection has source regression
coverage only. The broader original concurrency campaign, Rosetta/mixed members, Linux native
behavior and Battle Bots application adoption were not rerun for this correction. Consumers must
rerun their interrupted-cleanup adoption gate against final published bytes.

## Publication sequencing

The release retains the original ten-package artifact before the first upload. Uploads remain in
dependency order. Exact archive, manifest, tag and provenance readbacks then run in batches of
three; every started check settles before a failed batch exits. All ten checks, installed-consumer
proof, helper preparation and signature audit must pass before stable promotion. npm propagation
and maintainer 2FA remain external waits.

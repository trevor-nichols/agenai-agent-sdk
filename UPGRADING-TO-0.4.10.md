# Preparing for 0.4.10

`0.4.10` is an unpublished coordinated ten-package candidate. Published npm `latest` and `beta`
remain `0.4.9`. Use a reviewed source export or its identified local archives for this candidate;
do not replace a published archive or infer publication from these instructions.

The candidate adds explicit administrative recovery for a coordinated native-arm64 Desktop
container create whose dispatch entered but whose outcome remained unknown. Ordinary cleanup
continues to preserve uncertainty when no authoritative settlement exists. The new controller
grants cleanup only and never restarts Docker itself or replays the create.

## Existing owners and records

Keep the complete original coordinator/member configuration, prepared executables, canonical
journal and SDK-returned records. Agent Protocol V13, neutral `agenai.sandbox-recovery.v3`,
ordinary coordinator v1 and existing backend identities are unchanged. Administrative recovery
temporarily uses its own separately named envelope; ordinary coordinators refuse it until the
original generation returns clean. Never translate a record or restore an evidence copy over the
canonical journal.

Use the [operator runbook](examples/sandbox/recovery/README.md) only on its exact supported stock
Desktop 4.54.0 / Engine 29.1.2 native-arm64 profile. The original helper path and physical authority
remain part of the binding. A helper correction uses an explicit reviewed predecessor and a new
prepared path; overwriting a pinned executable is not a supported upgrade. The runbook explains
released-attempt continuation and clean terminal verification.

## Qualification and adoption

The [qualification record](examples/sandbox/HANDOFF.md#administrative-uncertain-create-recovery-2026-11-02)
identifies the actual original recovery, seven retained failed attempts, clean generation and
separate-process confirmation. Its local `0.4.9` development archive is distinct from published
`0.4.9`. A new candidate must retain its own export revision, ten archive hashes and a comparison
to those qualified runtime/native bytes. Documentation and version changes do not broaden the
native platform evidence.

Publication requires the separate release workflow and authorization. Consumer adoption then
selects the published or explicitly approved local candidate, preserves the original failure
evidence, verifies the retained incident's clean result and reruns its remaining application
gates. No consumer source or dependency migration is performed by this preparation.

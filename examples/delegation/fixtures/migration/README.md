# Frozen format-one migration fixture

`legacy-v1.json` contains actual rows committed by the old public store-adapter commands and the
old SQLite/inbox examples at `21e972faae5f16038e64d423c840def150dfdebb`, before the format-two
implementation or rebuild. Both runs are settled: one retains the original failed code/message;
the other retains `recovery_required/dispatch_uncertain`. Both inbox entries remain pending, with
real accepted child notification delivery receipts and their historical digests. No native account
or provider dispatch was used.

`provenance.json` records source hashes, fixture and producer hashes, the original frozen build
inventory hash, the exact source/owner/store identities and qualification tuple. Fixed blobs omit
only padding in JSON; `materialize.ts` reconstructs and verifies every original padded blob digest
before inserting the serialized rows. It never constructs a claimed legacy outcome using a current
parser. The test fixture preserves IDs and timestamps rather than regenerating them.

The migration's source decoder in `sqlite/migration/legacy/` closes over the baseline record,
input, scalar, byte-accounting and limit semantics. It imports neither today's protocol schema nor
today's orchestration parser. Zod remains the exact governed 4.4.3 implementation. The additional
operation/header/slot validators enforce the unchanged persisted interfaces and physical identity.
The migration uses current public parsers only to validate target records.

To reproduce a new source sample, check out the exact source commit in an isolated private
location and build its matching public packages there. Keep the old example tree and those
package outputs together so its public package imports resolve to that frozen build. Run the
retained producer with the exact qualified Node runtime and an unused owned output directory:

```sh
node --import tsx legacy-producer.mjs /frozen/examples/delegation /unused/private/store /owned/output
```

The producer checks the old store-port contract and failure parser before opening storage. It
refuses the current implementation. It is an evidence utility, excluded from ordinary test
execution; public consumer tests load the retained fixture and run the explicit migration instead.
Do not replace the committed fixture with newly invented old-shaped values.

Qualification additionally compared the frozen decoder with actual old public parsers and opened
a backup copy with the frozen old SQLite/inbox implementation in separate processes. The matched
old implementation accepted the restored old records and rejected a migrated format-two copy.
Those run-specific reports belong to the MS006 qualification artifact, not a bundled old SDK.

## Retained format-two producer

`legacy-v2.json` was produced through the original `45ffbebd7` example sources and the seven
installed baseline tarballs, whose hashes are in `format-two-provenance.json`. The matched old
store committed two request-resolution operations with disposition `completed`, then settled
their runs and accepted their paired inbox envelopes. No native or parent invocation ran.
`format-two-producer.mjs` must be copied into the isolated baseline consumer before execution so
its imports resolve to those installed public packages; it refuses a different store contract.
Use a new owned store on the qualified `0xEF53` filesystem and a separate output directory.
`materializeFormatTwoStore` reconstructs exact rows and verifies every retained padded blob hash.
The migration tests compare history and backups through actual SQLite and fresh-process reopen,
and SIGKILL the real transaction commit boundary for both supported upgrade steps.

# Retained original format-three writer

`retained-v3.json` contains actual SQLite rows written by the preserved MS001 V10
consumer. Its original public coordinator selected a precise once-only approval,
received `delivered`, consumed the original output stream to terminal success and
closed its registry and store. The producer used the original installed seven
0.4.1 tarballs and original reference sources. No native vendor or migration ran.

`provenance.json` records the exact fixture, producer, tarball, installed manifest,
public entrypoint and reference source hashes, along with the actual Node, SQLite
and filesystem tuple. The listed reference TypeScript files were independently
compared with the recorded git object. That verified source scope is separate
from the package byte identities: the old package set retained no build-commit
field, and the identical old/current 0.4.1 version does not establish identity.

The shared materializer reconstructs the original padded blobs and verifies every
retained blob digest before inserting these serialized rows. It does not create
historical receipts using current parsers. The existing fresh-process request
recovery test opens this format-three store directly with current V11 code, adds
a synthetic explicitly selected remembered approval and loses its receipt before
or after commit. It compares the exact new operation slot and all original
settled rows across opening, SIGKILL and recovery. Only owner fencing and the
interrupted current run may advance; recorded IDs cannot recreate a live handle.

The format-two migration fixture remains the separate owner of historical
`completed` receipt semantics. This format-three fixture retains `delivered` as
answer acceptance and does not reinterpret either receipt.

To reproduce a new sample, retain the original reference source tree and matching
installed packages in a separate consumer. Independently verify the source hash
scope against its full git object, then run the producer with an unused owned
store on ext4 and a new output directory:

```sh
mkdir -p -m 700 /new/private/store
node --import /original-consumer/node_modules/tsx/dist/loader.mjs \
  fixtures/history/format-three-producer.mjs \
  /original-consumer /new/private/store /new/output <verified-source-commit>
```

The producer refuses a current V11 package graph or a store contract other than
3. It is an evidence utility; hermetic tests materialize the retained JSON and do
not need the original package installation.

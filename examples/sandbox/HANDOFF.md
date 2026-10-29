# SDK 0.4.7 candidate platform and consumer handoff

This handoff targets the coordinated, unpublished **0.4.7 candidate**, with Agent Protocol
**V13** unchanged. Use the exact governed source export and its ten locally packed archives.
Published npm **0.4.6** remains a separate release. Earlier platform records below retain their
original source and archive identities. Publication, Docker Desktop configuration and Battle Bots
changes are not performed by this handoff.

## Select one reviewable candidate

Retain `.agenai-export.json` from the export root: its `sourceRevision` identifies the committed
projection input and its owned-file census identifies the delivered source. Retain the installed
consumer's ten archive hashes and dependency lock, the generated helper manifests and image IDs,
and the native executable/SDK hashes. A version string alone does not identify qualified bytes.
Do not copy Linux `node_modules` to a Mac. Build and install fresh on the target platform.

From the standalone source export, with Node 24.18.0 and pnpm 11.7.0:

```sh
pnpm install
pnpm build
pnpm typecheck:packages
pnpm test:sandbox-platform-consumer --output /private/tmp/sdk046-packed-r1
```

The output must be new and its parent physical/canonical. On Linux, choose a caller-owned
physical path with enough disk; on macOS `/tmp` commonly aliases `/private/tmp`. The portable
lane creates independent installations from all ten archives, compiles public examples and
checks neutral files, explicit helper-context preparation and native bridge contracts. Passing
these checks establishes installation and local behavior; actual Docker rows below are separate.
The full `pnpm check` release lane includes the full external consumer and its Linux native-history
composition. Use that complete lane on Linux; the explicit portable lane is the Mac preparation
entrypoint, not a claim that Linux-only native checks ran on macOS.
For the Linux full lane, select an owned disk-backed `TMPDIR` with room for unpacked native
fixtures and check its per-user quota as well as filesystem free space. Select a physical directory
outside ancestors containing native `.grok`, `.cursor` or `.claude` configuration; the full lane
rejects ambient loading inputs. A task-owned directory directly under `/var/tmp` worked for the
recorded Linux run. A large free source/output filesystem does not establish that the process's
default temporary filesystem has capacity.

The source export contains the Docker package's filesystem helper C/header assets, compiled
egress helper closure, explicit `/node` preparation APIs, and `examples/sandbox/{live,combined,grok,claude}`.
The Claude example is an isolated optional workspace with its exact vendor dependency; ordinary
sandbox consumers do not acquire it. Preparation writes only a selected fresh build context.
It does not build/pull an image, execute a compiler or select an Engine.

The earlier Linux capability and paid-account campaign harnesses are **not exported tooling**.
They depend on private evidence and campaign-specific ownership. The exported platform runner
separately includes the installed `live-files` row, with explicit manifests, images and cleanup
ownership; it supplies no provider authentication. A caller building real native integration
must select its own image, account, endpoint, process and cleanup composition. Copying a private
qualification launcher is not a supported public authentication API.

## Current qualification boundary

| Composition | Recorded scope | Target work still required |
| --- | --- | --- |
| 0.4.6 supplied API-key recipes, Linux x64 and Desktop native arm64 | Five providers, normal task and entered-native cancellation on each tuple: twenty accepted rows, with explicit Engine 404 resource checks | Codex saved-auth rows, Rosetta credential routes and changed input tuples; see the separate follow-up record below |
| Linux x64, Node 24.18.0, rootful Engine 29.1.3/API 1.52, same-host route authority | Restricted HTTPS, live files, confined links, recovery, installed bridges and native tool/cancellation cases | Requalify changed SDK/helper/native bytes, daemon/profile or route-authority assumptions |
| Claude Agent SDK 0.3.273 / Code 2.1.273 | Scripted native tools and API-key task/cancellation with `claude-haiku-4-5-20251001` | Other SDK/Code/model/account compositions; browser/subscription and retained refresh |
| Grok Build 1.0.62, revision `1474f9cbdd91`, Linux x86_64 binary SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa` | Modern stable ACP `schema-v1.23.0`, native filesystem callbacks, scripted tools and API-key task/cancellation with `grok-build-0.1` | Other binaries/schema/account/model combinations; native arm64 API-key tasks have the separate 0.4.6 record below |
| M3/macOS 26.5.1, Apple Virtualization native arm64 and Rosetta amd64 | Each passed 30 baseline checks and the installed two-turn controlled ACP example; independent kernel/resource cleanup | Changed platform/artifact tuples, datasets and large-workspace scale; combined behavior has a separate MS006 record |
| Desktop live files, separately packed MS003 r2 | Native N7 and Rosetta R2 each passed 18 cases with complete cleanup and 43 final-empty scopes | Changed tuples need their own proof |
| Desktop preserving transfers, separately packed MS004 r2 | Native N2 and Rosetta R1 each passed 136 cases across both APFS roots and workspace layouts, with complete cleanup and 230 final-empty scopes | Changed archive/controller/helper/platform tuples need their own proof |
| Desktop restricted HTTPS, separately packed MS005 r8 | Native N12 and Rosetta R2 each passed 26 installed cases with complete cleanup and 98 final-empty scopes; exact IPv4-only caller-quiescent composition | MS006 separately records combined behavior; changed tuples need fresh proof |
| Internal and external APFS on that Mac | Each passed all 183 neutral host tests, zero skips, with native representation limits retained | Other filesystems and representations not supported by the observed APFS roots |
| Pinned Grok 1.0.62 under AVF/Rosetta | Exact version/hash and eager ACP initialization, no session/account/model | Native tasks, authentication, tools, cancellation and model behavior on Mac |
| Battle Bots / Electron | Reusable SDK contracts and example mappings | Dependency/config migration, application behavior, renderer grants, artifacts and replay |

The earlier 0.4.5 Linux API-key cases used an explicit guest-loopback admission gateway that forwarded the
selected key to the exact provider over verified TLS through restricted CONNECT. That gateway
was controlled qualification infrastructure. The result is not direct-native-endpoint-only proof,
hidden backend model identification or billing attestation. Credentials remain visible to guest
code, controller memory and Docker exec metadata. No persistent auth home, refresh mechanism,
subscription fallback or secrecy from the guest is claimed. Each workload had a separate private
HOME and writable workspace; ephemeral credential state ended with whole-owner cleanup.

Restricted egress advertises support on explicitly configured Linux x64 and both admitted
Apple Virtualization Desktop profiles. Desktop requires the original platform-matching authority
and explicitly prepared host/VM observers, with separate MS005 qualification below. All three profiles advertise per-transfer `preserve_internal`
with actual empty-workspace admission. The separate MS004 r2 Desktop native record below qualifies
its exact archive/controller/helper tuple across baseline and private-live layouts.
Current candidate source admits live-file grants on either Desktop profile when an exact native
filesystem helper is configured; omitted grants remain disabled and acquire no helper. Their installed native campaigns
have the separate exact-artifact scope recorded below. A baseline Mac pass or cross-built arm64 artifact
alone does not establish live-file, network or preserving-transfer qualification. Do not switch
to broad outbound access, host callbacks or link flattening to satisfy an unsupported requirement.

## Recorded Mac baseline (2026-10-26)

This record qualifies the selected unpublished candidate and baseline compositions. It does not
extend the earlier Linux account/native qualifications or publish 0.4.5.

| Identity | Recorded value |
| --- | --- |
| Host/controller | Apple M3, macOS 26.5.1 (25F80), Darwin arm64 |
| Toolchain | Node 24.18.0, pnpm 11.7.0; image preparation used the host's BSD tar |
| Desktop/daemon | Docker Desktop 4.54.0, rootful Engine 29.1.2 (`de45c2a`), API 1.52, Linux 6.12.54-linuxkit, arm64 |
| Controls/settings | cgroup v2/cgroupfs, builtin default seccomp, private cgroup namespaces; Apple Virtualization and Rosetta enabled, ECI disabled |
| Qualification budget | Four CPUs and 6,144 MiB configured VM memory; no hard workspace disk quota |
| Packed runtime source | `aa1a40ddba7b4854abc4c01cba04de41a6658f46`, exact ten-package `packed-r2` archives below |
| Tested fixture source | `b35c4a4ea3a75cd040d54872f414dfc679eac84b`; test-only corrections, with packaged runtime/declaration/assets unchanged from the packed freeze |
| Rosetta/Grok execution revision | `6189df7133e72c0f84b078cc6a2d4ce9ce8f3943`; only private evidence/documentation changed after the fixture freeze |

Desktop settings were independently inspected in the settings UI; Engine output alone does not
attest them. The native controller, daemon and kernel observer were arm64 in both core rows. The
Rosetta guest image was amd64, with actual `/run/rosetta/rosetta` descendant observations.

| Row | Result | Independently observed cleanup |
| --- | --- | --- |
| `n3`, native arm64 core | 30 passed, zero failed/skipped/cancelled; installed two-turn controlled ACP example completed | 114 identified resource references absent, 34 compute scopes empty, 70 known PID/start identities absent |
| `r1`, AVF/Rosetta amd64 core | 30 passed, zero failed/skipped/cancelled; installed two-turn controlled ACP example completed | 114 identified resource references absent, 34 compute scopes empty, 70 known PID/start identities absent |
| `hi2`, internal APFS host suite | 183 passed, zero failed/skipped/cancelled | Fixture trees absent; owned child and sampler joined |
| `he2`, external APFS host suite | 183 passed, zero failed/skipped/cancelled | Fixture trees absent; owned child and sampler joined |
| `g1`, pinned Grok in the amd64 guest | Version/hash and eager public ACP registry initialization passed | Six identified resource references absent, two compute scopes empty, four known PID/start identities absent |

Both installed core examples recorded one initialization, one session and two prompts using the
credential-free controlled peer. Their network tests used distinct owners for discovery and
positive/isolated/positive probes: the same numeric URL returned the fresh marker, then
`ENETUNREACH` without a listener request, then the marker again. Each listener census contained
exactly two matching GET requests. Each observed compute scope had repeated empty observations
and an absent final cgroup. Observers, command groups and samplers settled; prepared images were
removed after their rows. Original failed attempts remain failed and retained, with cleanup closed.

The Grok artifact was ELF64 little-endian x86_64, exactly 191,715,904 bytes, reporting
`grok 1.0.62 (1474f9cbdd91)`, SHA-256
`2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`.
Host and guest hashes matched. Eager initialization materialized and disposed the instance.
No session opened; no authentication, credential read or model turn occurred. Advertised
capabilities do not establish native task or account behavior.

### APFS host observations

Both physical volumes exercised directory import/export, subtree selection, raw-link validation,
publication/cancellation/permission cleanup, 20,017 actual one-byte regular files and a separate
20,017-entry reverse-metadata case. Case and canonically equivalent Unicode names aliased on
both volumes; the export tests proved rejection without merging or publishing those aliases.
Darwin lsof observed four exact owned child descriptors with zero links, two holding nonzero
bytes (8,186 and 16). The controller-death assertion joined SIGKILL, required `ESRCH` and preserved
the caller's original sentinel. These are bounded behavior checks, not large-workspace or peak
resource measurements.

The original 3,999-byte raw symbolic-link target remained unchanged (16 components of 249 ASCII
`x` bytes, separated by `/`; SHA-256
`14f1fe50bf745f42db731af6adb6bcef77db9462c28fe6b22ec17a74400d95b1`).
An independent native symlink call on each selected physical root returned `ENAMETOOLONG`;
the SDK export returned the matching syscall/error and exact target identity with no destination
or staging publication. This proves fail-closed cleanup at the native representation boundary,
not successful 3,999-byte APFS publication. A separately labeled 999-byte target published exact
readlink bytes, with one symlink and zero regular-file payload.

For the malformed filename (`626164ff` raw hex), native creation returned `EILSEQ` before SDK
traversal. The valid replacement-character sentinel (`626164efbfbd`) was created first; its inode,
bytes and exact raw directory census remained unchanged, and that valid name imported normally.
The separate malformed raw symbolic-link target reached SDK validation and was rejected without
modification. The APFS result does not claim SDK traversal of an invalid filename the filesystem
would not create. Capable-filesystem assertions and the SDK's existing transport limits remain.

### Exact packed-r2 archive identities

All ten archives are version 0.4.5. These SHA-256 values identify the raw `.tgz` files, not
installed-file aggregate hashes. All 1,317 installed package files matched their archive payloads;
the installation census remained unchanged across the accepted native rows.

| Package | Archive SHA-256 |
| --- | --- |
| `@agen-ai/validation` | `1723037660747f29e2cc140040b0c068b28bdefe4ee0991621287aa401758d54` |
| `@agen-ai/agent-protocol` | `c4365027e2d19e2ef2457e2ffb2ffc44d644b83e23ab797ca2bc4bd694c86c0a` |
| `@agen-ai/agent-runtime` | `614ce6205e44e193b6ef03edf227d4c874ee7bc182e19a4f3b7e0dc708f37663` |
| `@agen-ai/agent-orchestration` | `3d00a27cc55913e12cbd61bad36e4fed4e3a1bad8c0aa3b6ddbce22e019e67e8` |
| `@agen-ai/acp-transport` | `7152813e92bedb28caacae9fb2a8db53a4f2f63b31af6dd1c330efa44ebef090` |
| `@agen-ai/provider-acp` | `9648571f4e9e730407690270b70c537e84ed54bdb333bacc3d14838c172c8987` |
| `@agen-ai/acp-registry` | `b6c526c7acde412206c17ac542f52a356eeb0900fb926790444287de9a833599` |
| `@agen-ai/agent-history` | `116477c337d115cc43e95e05c98ec50691e829189c31df12763afadbeb699d46` |
| `@agen-ai/sandbox` | `b6f1c8ab1e41705c87a4f79bd1bca3e721ec00398ff57aa5dc4447a5b7231bbf` |
| `@agen-ai/sandbox-docker` | `76a29a94df46f9f24ae46d2ac990c5dfd68dbf6d16ed9f4551a1a135720b05b9` |

### Exact image identities

The borrowed Node 24.18.0 source image IDs were
`sha256:af01d58b748ec92b1d6e8e11429aad424fd1e68c848185399dca0596a1ab8f5c`
(arm64 guest/observer) and
`sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6`
(amd64 guest). Each row separately prepared the following immutable images; these prepared
images were removed after cleanup, and their borrowed sources survived the row.

| Row | Prepared guest image ID | Prepared arm64 observer image ID |
| --- | --- | --- |
| `n3` | `sha256:f034cbaf667e237216ad803390b7c71f812b2b1b5a0121f71dc43d8ed6087890` | `sha256:2edd4ef56d1ac6fd583458debaf71ab43e50d108016c80fa69743a9647bbe163` |
| `r1` | `sha256:dd46e3ecc410e53131d5fc6f315280e819d0bdcb9478938df42c676fd35f490a` | `sha256:6608a010cfc79d3bb8ae34b317b7647bf454778cee0a967e0f775bce490436ef` |
| `g1` | `sha256:4624ac1ef2073b83968f63153db241330b27e98cc03d9be7405064b8dd917b0a` | `sha256:6575c3f845e4fad52c9a8d5e88736dc17b0104b49e8b283c76ae6ca67d9ef381` |

These original baseline artifacts do not qualify the separate current live-file admission.
Restricted HTTPS has the separate MS005 record below. Preserving transfers have the separate MS004 r2
native record below. Mac datasets and
large-workspace scale remain unqualified; the observed Engine 29.1.2 is below the
dataset minimum of 29.1.4. Battle Bots/Electron integration and native Mac model/authentication
require separate work and qualification. Existing Linux qualification identities are unchanged.

## Desktop live-files native campaigns (2026-10-26)

The separate Desktop capabilities MS003 campaign uses `packed-ms003-r2`, distinct from the
baseline's `packed-r2` archive table above. It selects the same M3/macOS 26.5.1 (25F80), Darwin
arm64 Node 24.18.0, pnpm 11.7.0, Docker Desktop 4.54.0 / rootful Engine 29.1.2 (`de45c2a`), API
1.52 and Linux 6.12.54-linuxkit tuple. Apple Virtualization, disabled ECI and selected Rosetta
remain explicit independently inspected settings. Published 0.4.4 and the earlier Linux
consumer-capabilities MS003 29-case campaign keep their original artifact and native scopes.

| Selected MS003 r2 archive | SHA-256 |
| --- | --- |
| `agen-ai-sandbox-0.4.5.tgz` | `a0d744bd6c2fbb1fa7514de11ea9edb5d62b505d9e363c8528217f645dac47d2` |
| `agen-ai-sandbox-docker-0.4.5.tgz` | `b19e8a20b4fcf62f36eedfe0d00cb78e2aaf590676938366727825444ca81edf` |

The Docker runtime admits explicitly configured Desktop filesystem grants and repairs the
helper attachment to send an empty body; exec-start keeps its JSON body. There is no new public
API, native protocol, recovery format, resource role or backend revision. Both workload profiles
borrow filesystem image `sha256:e5bacba2d92e9a774935a1ba7a2473f838abbea2323f3c73cce06adc42873cb1`,
with five-file source closure
`sha256:0e14da4b3fd7306fc7d9fa4423cb435ae672aeb135ffe188aaddada4a55015ec`.
It remains native Linux arm64 with UID/GID 1000:1000 beside either arm64 or Rosetta amd64
compute, using `agenai.sandbox.filesystem.v1` and `agenai.sandbox.workspace.v1`. The helper
uses 0.25 CPU, 128 MiB, 32 PIDs, 4 MiB temporary storage, a 1,000-ms heartbeat and 60,000-ms lease.
Those are captured qualification choices, not universal SDK minima or performance guarantees.

Eighteen installed cases per profile cover disabled/read-only/read-write grants, exact bytes and
permissions, bounded streaming and partial reads, no-follow/ancestor races, independent host and
sibling sentinels, cancellation, joined stop, actual helper/control loss, withheld native COMMIT
acknowledgement and unchanged-original-checkpoint recovery. Healthy held-read and write-source
callbacks exceed the full lease while the same helper PID/start identity stays ready. The separate
lease-expiry case pauses the original controller with its attachment open, observes natural helper
exit 74 while compute remains running, then resumes that same controller for fencing, joined
stop/session work, original-file export and destruction. A fresh-process fallback cannot qualify
that positive case. The unprivileged mount-crossing fixture is explicitly unsupported and does
not prove a successful mounted crossing. The independent observer must retire every started
producer's captured PID/start and cgroup scope before disposal.

Desktop capability MS003 native N7 and Rosetta R2 each passed all 18 cases with complete case
cleanup. Each launcher has quiescent commands, no cleanup failures and no pending observer
execs. Each observer was removed after 43 final-empty scopes: 19 compute, 18 filesystem and
six qualification sentinels. The two preparation containers and resulting guest/observer images
were removed for each row; borrowed source and filesystem-helper images were preserved.

| Desktop row | Prepared guest image ID, removed | Prepared arm64 observer image ID, removed |
| --- | --- | --- |
| Native N7 | `sha256:6825a827b1610c6edfd4c785b58d138a160fcd873be79966bbba6c37514dd08c` | `sha256:4f866d99514f14e769829f8635d91df808ef2f0c0c6b041edb6e3bec0f65abbf` |
| Rosetta R2 | `sha256:dc958ffc2eaa516650ae30e22c2fdfc878b0049545c14823abd283ab66bef88c` | `sha256:65415bd5231102f9939025c43c9ddf92762083f5f6cf21c61a2f47306cba0b5a` |

Rosetta R1 remains failed at 17/18: the sentinel setup stream-close observation expired before
the entered-list stop assertion. All 18 case cleanups and 43 kernel scopes still closed, and its
observer/prepared images were removed. R2 reused the unchanged SDK, helper, controller and
manifests. A separate read-only R2 census observed the same sentinel seed exec running and then
stopped with exit code 0; that later observation does not diagnose R1's timeout.

The historical sixteen-case native pass retains its exact smaller fixture scope.
The fresh Linux source-r2 build/typechecks and 250 Docker/68 platform-tooling tests are controlled
regression proof, not this native row;
later controller-fixture differences require their own applicability record. Restricted HTTPS
has the separate MS005 record below; this live-file row does not qualify preserving transfers. This row grants no native account/model,
billing, application integration or fleet claim.

## Desktop preserving-transfer native campaigns (2026-10-27)

The separate Desktop capabilities MS004 campaign selects `packed-ms004-r2`, distinct from both
archive sets above. Native N2 (`m4n2`) and AVF/Rosetta R1 (`m4r1`) each passed all **136 installed
cases**: D08 round trips (12), D09 admission/confinement (84) and D10 host failures (40). Each
profile exercised internal and external APFS with both baseline and private-live layouts on the
recorded M3/macOS 26.5.1 (25F80), Darwin arm64 Node 24.18.0, pnpm 11.7.0, Desktop 4.54.0 /
rootful Engine 29.1.2 (`de45c2a`), API 1.52 and Linux 6.12.54-linuxkit tuple. Apple Virtualization,
Rosetta enabled and ECI disabled remain explicit inspected settings. Controller, daemon, observer
and filesystem helper remain arm64 beside the selected arm64 or Rosetta amd64 workload.

Coverage includes exact binary/executable/raw-link round trips, maximum path/target PAX records,
multi-batch graph validation, actual empty-workspace rejection before source/PUT entry, confined
dangling links and exact inert cycles, rejected escaping/over-bound graphs, default rejection,
subtree confinement, exact-file/live no-follow, hardlink/FIFO rejection and independent sentinels.
Failed imports may retain regular effects while withholding links and fencing execution.
Only the host adapter's fresh destination publication is atomic. No guest snapshot or transactional
import is claimed.

The D10 rows preserve case/Unicode alias rejection without publication and the original
3,999-byte target identity (`14f1fe50bf745f42db731af6adb6bcef77db9462c28fe6b22ec17a74400d95b1`):
native APFS `ENAMETOOLONG` is retained, with no destination publication and a separate exact
999-byte positive control. Native `EILSEQ` rejects filename bytes `626164ff` before SDK traversal;
the valid `626164efbfbd` sentinel remains intact and imports normally. Malformed raw link targets
separately reach SDK validation. Source replacement/truncation/growth detection, import traversal
and export publication cancellation, and exact original directory-cleanup-owner retries all pass.
These results do not claim unsupported APFS representations or detection of all concurrent edits.

Each row completed all case cleanup, joined commands with no cleanup failures or pending
observer execs, and removed its observer after **230 final-empty scopes**: 152 compute, 76
filesystem and two qualification sentinels. Prepared images were removed; borrowed source and
filesystem-helper images survived. Later host-root cleanup passed eight exact acknowledged
removals with zero unknown outcomes, retaining archived original marker/control bytes and
unchanged APFS provenance.

### Exact MS004 r2 identities and applicability

The source export records projection input `713f0e1b5d3bbe457ef3b693193d2fbbc2f5b4d8`.
Its `.agenai-export.json` SHA-256 is
`ee56abf7ce0f6e71d3e84cc411760c10206fa0efd83396e20043d965f01c3465`.
The read-only finalizer verified ten packages, all 1,304 installed runtime files and archive
correspondence, 665 Linux source files and the complete captured 21-file controller closure.
The controller closure SHA-256 is
`2fdb2502a59193c0e188dd8714eb42261e478b2d6b48285dc45860468204903d`;
the outer launcher SHA-256 is
`e67613b688e2e6dfec1e1a3b3fa0a9c015d5f471dd4d2a17afdd7f26d1723574`.
This controlled applicability comparison, rather than the revision or version string alone,
binds N2/R1 to the selected candidate. All ten raw 0.4.5 archive SHA-256 values follow.

| Package | MS004 r2 archive SHA-256 |
| --- | --- |
| `@agen-ai/validation` | `1723037660747f29e2cc140040b0c068b28bdefe4ee0991621287aa401758d54` |
| `@agen-ai/agent-protocol` | `c4365027e2d19e2ef2457e2ffb2ffc44d644b83e23ab797ca2bc4bd694c86c0a` |
| `@agen-ai/agent-runtime` | `614ce6205e44e193b6ef03edf227d4c874ee7bc182e19a4f3b7e0dc708f37663` |
| `@agen-ai/agent-orchestration` | `8c860d57ef0227ed3f735b3978448fb5f38ee7deb4549889908deb5216484938` |
| `@agen-ai/acp-transport` | `7152813e92bedb28caacae9fb2a8db53a4f2f63b31af6dd1c330efa44ebef090` |
| `@agen-ai/provider-acp` | `7503a28384c9fb37c5e9c4b028d0ea37a07dff659629bdcfeb21bb8496c608c2` |
| `@agen-ai/acp-registry` | `b6c526c7acde412206c17ac542f52a356eeb0900fb926790444287de9a833599` |
| `@agen-ai/agent-history` | `a10b43675cd333c90ff45d8da9ce26557e68360d4414f143ec4c57ede156c402` |
| `@agen-ai/sandbox` | `6e4780dd929308f43f385e7f836bcb4ea584c749b2576b8e932b1e1a0e374dd9` |
| `@agen-ai/sandbox-docker` | `6d99e03621af69fc9162afd1e7bf7697bebf00efd9b83863817870778d1e6dc8` |

Both profiles borrow native arm64 filesystem image
`sha256:e5bacba2d92e9a774935a1ba7a2473f838abbea2323f3c73cce06adc42873cb1`.
Its unchanged five-file C/header source digest is
`sha256:0e14da4b3fd7306fc7d9fa4423cb435ae672aeb135ffe188aaddada4a55015ec`,
with preparation-manifest SHA-256
`6d97f6c11b2c4cb49675cc891089c96d0b0a7923510300c3ceba6cac63a4c448`.
It retains the MS003 protocol/layout, UID/GID and captured helper budgets above. Borrowed Node
source images retain the exact arm64/amd64 IDs in the baseline image table.

| MS004 row | Prepared guest image ID, removed | Prepared arm64 observer image ID, removed |
| --- | --- | --- |
| Native N2 | `sha256:de1f5b6cf02d97042b59bcb80fa98242153d3f918290f831dfea5311f1066b20` | `sha256:bc5f83729fda3b2606f0e74696a5209dfaf89ee848eb83febf10f3a1e79d57e5` |
| Rosetta R1 | `sha256:92ad9dfefcf191f01f66400c6335bb3856677ea16367fb342a6d88b8087c7c0d` | `sha256:3b35e498b09d36d13fd3c2d6157db38f58f847f6a144e69b1b9dde4e59fde2ef` |

The finalizer passed with report SHA-256
`7a972ab46d649b2611da2a159c597fb7ece2bb814409ee888e4bb6960d8e7fe2`;
its applicability report SHA-256 is
`be175ee0e8286618f9c7e9e3fc61afbe8e1e8a4c263a80666981a8c7714c13ce`.
It copies and compares retained evidence; it performs no new native observation.

Original native N1 remains failed at 124/136 on r1, with complete cleanup. Its mutation-case
assertions did not retain the original exception; later observations cannot reconstruct it.
The r2 runtime narrowly preserves a producer error when the request-origin aborted transport
wrapper has that exact error as its cause, joins the producer and retains independent cleanup
errors. Fresh Linux r2 builds/typechecks and 253 Docker, 70 neutral and 73 tooling tests are
source/unit validation, **not fresh native Linux qualification**. Historical Linux native and
published 0.4.4 scopes remain unchanged. Restricted HTTPS has the separate MS005 record below.
This row adds no provider/account, billing, product, fleet or network qualification.

## Desktop restricted-HTTPS native campaigns (2026-10-27)

The accepted MS005 native N12 and AVF/Rosetta R2 campaigns each pass all 26 installed cases,
complete original-owner/fixture cleanup and 98 independently observed final-empty process scopes.
They select `packed-ms005-r8`, separate from the baseline, live-file and preserving-transfer
archives. All ten package and 22-module controller identities match the retained source/export
applicability record; three independent final reviewers reported no actionable findings.
A matching version number or an individual component pass does not qualify the combined workflow.

The tuple is M3/macOS 26.5.1, Darwin arm64 Node 24.18.0/pnpm 11.7.0, Docker Desktop 4.54.0 /
rootful arm64 Engine 29.1.2/API 1.52, LinuxKit 6.12.54-linuxkit and daemon
`7ea1aaea-951c-4129-a920-8f003143c27b`. Explicit deployment assertions select Apple Virtualization,
Rosetta enabled, ECI disabled, IPv4-only networking, DNS inhibition `auto`, no host networking or
kernel UDP, and no manual proxy configuration. The caller owns host/VM route, Engine endpoint,
executable and proxy/interception quiescence. Serial observation and leases do not establish
continuous safety during unannounced route/VPN/interception changes. Workloads are arm64 or
Rosetta amd64 respectively; broker, relay and VM observers remain native arm64.

| Selected input | Exact identity |
| --- | --- |
| Sandbox archive | SHA-256 `b8d17ce7cb2d79496913e14d4f21389f9b8b91c519a4fd32595b84a330b78672` |
| Docker archive | SHA-256 `0b31593d33bfbf4742faa677e05e315ac4b290ea76515225c067a897aa17e08d` |
| Darwin host-observer source | `sha256:faa603ca389bd90df8efd6edbd4d28d6c7660524214cdf93355452c806c53533` |
| Darwin executable | SHA-256 `13743b7576433f495b9c7ed6d5c5c3441d72d1545b95af1c3906c23d40388ba0` |
| VM observer source/image | `sha256:a07d005fc343aa007e9ff53bdf8519ac8cbc404ad58f261a6d00a4922ad9f894` / `sha256:01cc9d5789f10178f5ea11b2a0bd5ed1ac449cdd794544b0cce19760e2808524` |
| Egress source/image | `sha256:2152b5e0d5414a83cd7e1e0352a7d770e3108a410cdb9f27860db1feb54c4754` / `sha256:0c07d1c0917158873c34ac576667008cc5f756fa56c5c7a750076caee0b353d3` |
| N12 launcher report | SHA-256 `7c36defa5aff997ed3025f7b980db400e0c7001fc9fa486a980642c9d98a3e45` |
| N12 network report | SHA-256 `bee1909498024b6b3d719e976f9952d8ee8f0d5017b4fcfcb06e714f5096c068` |
| R2 launcher report | SHA-256 `080a7978dba2bccec32c515c0ab6aed04f8fa44618955767a966af18cd2ae28f` |
| R2 network report | SHA-256 `805a604fb1a0c8b6c302873a90387dace7c57a98187b5d9b50c603235bf4c5e7` |

The native cases verify certificate-authenticated TLS/exact response bytes, unlisted/canonical
CONNECT denial, direct TCP/UDP denial and separately reachable host, `host.docker.internal`,
VM-local, owned bridge-gateway, sibling and publicly numbered local markers with zero forbidden
listener-counter deltas. Fifteen fault/recovery cases cover helper/control loss, drift, native
lease expiry and original-checkpoint cleanup. Native IPv6 scope is address-form CONNECT refusal
plus explicit no-route TCP/UDP errors for two selected global forms on the IPv4-only topology;
it does not establish reachable IPv6-service isolation or IPv6 connectivity.
`gateway.docker.internal` has DNS and unlisted-CONNECT observations only, without direct or
reachable-service isolation proof. Native HTTP 302 and bulk-tunnel backpressure were not exercised;
separate deterministic broker/relay tests own redirected-target admission, DNS changes, peer
pinning and healthy bidirectional backpressure. No account, model, billing, application or fleet
admission follows. Failed/superseded attempts retain their original outcomes.

Desktop restricted owners use `engine-1.52-v6-<profile>` and a separately checkpointed
`route_observer` role. Linux keeps `engine-1.52-v5-linux-x64`; the recovery format remains v3.
Older Desktop v5 owners require their original controller and complete original checkpoints.
MS005 Linux source R3 and installed native R6 separately pass source/tooling checks and
46 restricted-network/recovery cases with 378 independent absence observations. The fresh
MS006 Linux rows below supplement that record; reuse still requires exact unchanged runtime
and controller-source applicability.

The [public combined example](combined/README.md) imports its own fixed linked tree, performs
live reads/writes and verified HTTPS through one controlled process, supports entered-write and
process cancellation, then stops, preserves exact final files/links and destroys its sandbox.
It takes explicit caller images/backend policy, prepared authority, destination and checkpoint
storage. The portable consumer compiles this same entrypoint and records its source hashes.
Desktop MS006 native N2/Rosetta R1 and real Linux x64 R1 passed the combined/fault workflows
recorded below. Final evidence/governance checks and independent review remain completion gates.

## Desktop and Linux combined native campaigns (2026-10-27)

The same installed [public combined workflow](combined/README.md) passed Desktop MS006 native
N2 and AVF/Rosetta R1 on `packed-ms006-r3`: **thirteen cases and 62 final-empty scopes per
profile**, with complete row cleanup, quiescent commands and removed observers. The Mac tuple
is the M3/macOS 26.5.1, Darwin arm64 Node 24.18.0/pnpm 11.7.0, Desktop 4.54.0 / rootful
arm64 Engine 29.1.2/API 1.52 and LinuxKit 6.12.54-linuxkit composition recorded above. Its
IPv4-only deployment and caller-owned route/proxy/interception quiescence remain mandatory.
Rosetta changes the workload to amd64; filesystem, egress and route-observer helpers stay arm64.

Each APFS parent receives normal and entered-write cancellation flows: actually empty linked-tree
import, live read/write, certificate-verified exact HTTPS response, separately reachable forbidden
listener with zero connection/request delta, joined stop, exact five-file/one-link export and
destruction. Imported executable/ordinary modes are `0700`/`0600`; replacement preserves the
observed `0600`, and host publication creates `0700`/`0600` while preserving executable intent.
A fully started isolated live-file sibling precedes restricted authority capture, holds its original
membership stable and survives the restricted owner’s destruction with its own bytes unchanged.
This establishes that composition without admitting arbitrary concurrent topology changes.

Seven original-controller SIGKILL cuts cover resource-create acknowledgement, filesystem
initialization, network readiness, entered live write, active process, stop and cleanup. Every
original trusted checkpoint remains immutable. The first fresh cleanup returns an exact SDK-settled
checkpoint; a second fresh process reopens that record and observes absence. A stale `creating`
record can remain uncertain after its named resource disappears and is never translated into a
settled record. A separate lost-delete-acknowledgement case retries the same original cleanup
owner. Trace, Engine and independent PID/start/cgroup evidence establish closure without
creation, process or import replay. Recovery ledgers outlive transient host scratch.

Real Linux x64 MS006 R1 independently passed all three fresh installed rows on Ubuntu 26.04 LTS,
kernel `7.0.0-38-generic`, Node 24.18.0 and rootful Engine 29.1.3/API 1.52, with native
amd64 helpers and same-host Linux route authority. Its original worker is terminal/quiescent,
all row cleanup completed and task-prepared fixture/filesystem/egress images were removed.
Fresh MS006 Linux network R1 separately passed 46 network/recovery cases and 378 independent
absence observations against the selected r3 archives and all 470 current controller source files.
Its original worker exited, all commands joined, both prepared images were removed and the original
34 images, two containers and four networks remained unchanged. The
standalone Linux `restricted-https` platform row remains unimplemented; that limitation does not
remove restricted networking from the executed Linux `combined` workflow.

Network R1 production-report SHA-256 is `bed6f9a8720eeaca5ec71d3f954371b00a293ae0d5aedf1f32f3f35dc71e2849`;
its independent audit is `ee41abb8e1626d2632f7782bcc1c13faff10f4063240b444a951a7f994e2cb72`.
Both the original source copy and the actual executed controller bytes are retained. The earlier
MS005 Linux R6 record remains separate; this current run does not depend on claiming unchanged
MS005 controller bytes.

| Fresh installed Linux row | Passed cases | Final-empty scopes | Original launcher SHA-256 |
| --- | ---: | ---: | --- |
| live-files | 18 | 43 | `da661599f407d1e7069ad97b64dca602dd2633ad9b910d6cf0eeaeaaa3caf5e6` |
| preserve-internal | 68 | 115 | `14c4fadb1d681fc5beebab3c2093deb9e6aeb15c77dcb9a1b6e33407f9c9769d` |
| combined | 11 | 41 | `efafeae38a0215295e49ea9fa229058ec32225faf11ab0fbddad872cb21b073d` |

Mac N2 launcher SHA-256 is `5af52739f561529b6f29cf50e57b51d1e9e4021219ef6fcc964028fa72ccae31`;
Rosetta R1 is `b71bd77795aa1cb009c58b173f8a30688010d1d058be6791d74d4ea721fe11da`.
Their 26-file qualification controller closures invoke these same four compiled public modules:

| Compiled public module | SHA-256 |
| --- | --- |
| `index.js` | `a4754da641fbea8ecb8ac73040233e91e98b963a81b8881c79aea7a771bac33a` |
| `workflow.js` | `e59eb5c3bf2a548bb5e01ff26cdeea306ab4c507b252a727b9815752049297c3` |
| `program.js` | `63f37c3e6514c9101c190ab4a35814ffc8cd6e9740069c62e1c4f576c27c8f22` |
| `session.js` | `3907bdbe2b133f9c5db60e286e2841fe9ffcae051aa0393760ec96e1ea17b35c` |

The selected ten-package **0.4.5 candidate** archives are retained exactly as packed; they are not
the earlier individual-capability archives. Runtime/source applicability and archive identity are
separate checks, including when dependency-key ordering alone changes a package manifest’s bytes.

| Selected `packed-ms006-r3` package | Archive SHA-256 |
| --- | --- |
| `@agen-ai/acp-registry` | `b6c526c7acde412206c17ac542f52a356eeb0900fb926790444287de9a833599` |
| `@agen-ai/acp-transport` | `7152813e92bedb28caacae9fb2a8db53a4f2f63b31af6dd1c330efa44ebef090` |
| `@agen-ai/agent-history` | `a10b43675cd333c90ff45d8da9ce26557e68360d4414f143ec4c57ede156c402` |
| `@agen-ai/agent-orchestration` | `8c860d57ef0227ed3f735b3978448fb5f38ee7deb4549889908deb5216484938` |
| `@agen-ai/agent-protocol` | `c4365027e2d19e2ef2457e2ffb2ffc44d644b83e23ab797ca2bc4bd694c86c0a` |
| `@agen-ai/agent-runtime` | `614ce6205e44e193b6ef03edf227d4c874ee7bc182e19a4f3b7e0dc708f37663` |
| `@agen-ai/provider-acp` | `7503a28384c9fb37c5e9c4b028d0ea37a07dff659629bdcfeb21bb8496c608c2` |
| `@agen-ai/sandbox` | `a8076434ffb7d941c13d22336d9433449bd29bfe55da5c0dce2ed7eaaa018861` |
| `@agen-ai/sandbox-docker` | `fb1aef5f9f835fa9320d7c834940a5befa7ed167dffbbd6106e80e1519690a09` |
| `@agen-ai/validation` | `1723037660747f29e2cc140040b0c068b28bdefe4ee0991621287aa401758d54` |

Original Mac N1 remains failed before program readiness, with complete row cleanup and seven
final-empty scopes. The unchanged earlier program reproduced its executable-mode assertion
failure locally; the r3 program then passed ready/verify against the exact private modes. Consumer
R1’s TypeScript failure and successful but superseded R2 remain separate from selected R3.
The read-only Mac collector diagnostic verifies the current installed runtime/helper/module
applicability and raw recovery/cleanup records. These provider-neutral runs use no account, model or credentials and
add no dataset, large-workspace, application, fleet or publication qualification.

## Run the Mac baseline rows

Use [the platform runner](../../scripts/development/agent-sandbox-qualification/platform/README.md)
for the complete manifest schema, command options, observer restrictions and cleanup procedure.
All paths in this section are relative to the standalone export unless explicitly absolute.
Prepare separate manifests and result roots for native arm64 and Rosetta amd64. Record:

- Native macOS arm64 controller, exact Node/pnpm and Docker CLI paths/versions, `tar --version`,
  and the selected application plist. Do not assume Linux GNU tar behavior proves BSD tar.
- Explicit physical Docker socket and observed Engine ID/version/API/kernel/architecture,
  cgroup controllers, storage driver and resource capacity. Preserve existing daemon settings.
- Actual Docker Desktop version and independently inspected Apple Virtualization configuration.
  ECI must be disabled for these profiles. For Rosetta, explicitly inspect that Rosetta is enabled.
  These settings are caller assertions in the manifest; Engine output does not prove acceleration.
- Exact already-local Node 24.18.0 Linux image IDs and RepoDigests. Native uses an arm64 guest;
  Rosetta uses an amd64 guest on an arm64 daemon. The kernel observer remains **arm64** in both.
- Physical output/spill filesystem, case/Unicode behavior, available disk and memory, and
  `/usr/sbin/lsof` availability. Keep socket paths short: the outer `kernel.sock` is at most
  100 UTF-8 bytes and the deepest source-test proxy path must remain below 104 bytes.

The platform manifest must match live observations. Its `desktop` section explicitly supplies
the application plist/version, `vmm: "apple-virtualization"`, `rosetta` and
`enhancedContainerIsolation: false`. Use exactly
`desktop-apple-virtualization-native-arm64` or
`desktop-apple-virtualization-rosetta-amd64`; there is no architecture fallback. Docker VMM,
Intel Macs, ECI, WSL and remote/rootless Docker have no admitted profile.

```sh
pnpm test:sandbox-platform --row core --test-concurrency 1 --manifest /private/tmp/sdk045-native.json --consumer /private/tmp/sdk045-packed-r1/consumer --output /private/tmp/45nc1
pnpm test:sandbox-platform --row core --test-concurrency 1 --manifest /private/tmp/sdk045-rosetta.json --consumer /private/tmp/sdk045-packed-r1/consumer --output /private/tmp/45rc1
pnpm test:sandbox-platform --row grok-initialize --manifest /private/tmp/sdk045-rosetta.json --consumer /private/tmp/sdk045-packed-r1/consumer --output /private/tmp/45rg1
```

`core` runs source containment/resource/stream/cancellation/lost-reply/recovery checks and the
installed two-turn controlled ACP example. The recorded core rows selected `--test-concurrency 1`
for Node's source-file scheduler; each test's internal concurrency remained intact.
`grok-initialize` needs the exact binary path/hash in
the manifest; it proves eager native initialization, opens no model session and uses no account.
Neither row proves real native tools/authentication. The tooling-only observer reads exact owned
kernel identities; it adds no SDK guest privilege, host PID namespace or host mount authority.

If image datasets are required, run `--row datasets` separately with fresh output. This requires
Engine >=29.1.4 and the admitted containerd image-store marker. Do not reconfigure a user's daemon
to satisfy the row. Dataset absence does not invalidate an independently passing baseline core
row. Required allocated-block workspace quotas remain unsupported and must reject before reserve.

On the actual Darwin filesystem, run the portable consumer and the exported sandbox package's
Node directory/spill tests. Preserve case/Unicode alias, internal-link, subtree/publication,
cancellation and descriptor-cleanup results independently of the Linux VM. An unavailable or
skipped required assertion remains pending. The separate installed `live-files` row covers its
captured grants, helper races, streamed cancellation and original-controller cleanup; the host
suite or baseline row cannot substitute for it. Desktop preserving transfers have the separate
MS004 r2 link-confinement record above; changed tuples require fresh installed proof. Desktop
restricted networking has the separate MS005 host/VM/public-local/sibling
and proxy-bypass controls with reachable positive controls before admission. Unsupported admission
is not positive enforcement evidence.

```sh
pnpm --filter @agen-ai/sandbox test
```

This includes `directoryImport`, `directoryExport`, `directorySymlinks` and `spill` tests on the
actual host. Retain native alias/descriptor diagnostics; a hermetic backend fixture does not
qualify Desktop link import, live files or network enforcement.

## Application migration order

The consumer reference was Battle Bots commit
`7c3737f097ca4e1bee9dfee7713a16933a9c56f8`. Reinspect changes since that pin before applying the
mapping. No Battle Bots source was changed by this SDK plan.

1. Drain old 0.4.4 resources with their retained controller and original recovery records, then
   verify absence. Keep failed cleanup with that owner. Follow
   [UPGRADING-TO-0.4.5.md](../../UPGRADING-TO-0.4.5.md); never rewrite v2 records as v3.
2. Select matching candidate archives and explicitly prepare trusted workload/helper images.
   Keep image creation, inspection, labels, budgets and disposal under a separate caller owner.
   Sandbox cleanup borrows these images and never removes them. Retain exact image architecture,
   digest, build inputs and native binaries. Do not mount host home, source, credentials or socket.
3. Capture one stable source tree and its manifest before launching agents. Import the same
   capture into separate private workspaces. Opt into `preserve_internal` only when supported and
   the destination is actually empty. Preserve executable flags and raw confined link text.
   Apply application source/save/clone policies before import; do not silently truncate paths.
4. Choose explicit per-agent endpoint policy, `files` grant, CPU/memory/PID resources and optional
   execution deadline. Default lifetime is until stopped. Logical transfer quotas are caller
   choices and do not enforce guest workspace disk allocation. Maintain Linux route quiescence.
   The archive representation supports each regular file through `8 GiB - 1`; this is separate
   from aggregate workspace size, entry count and optional caller quotas.
5. Use guest paths throughout native execution. Grok scopes bind the exact native session and
   one active turn; file callbacks enter the sandbox port, not host filesystem APIs. Claude's
   exact spawn facade relocates its native child; controller hooks/custom tools/in-process MCP
   remain disallowed. Read the respective [Grok](grok/README.md) and [Claude](claude/README.md)
   contracts before selecting callbacks or upgrading vendor versions.
6. Supply only the explicitly selected native credential/account route at its deliberate process
   boundary. Keep fresh private homes and no shared writable refresh store. The current public
   examples do not supply a general credential vault, login, subscription or refresh API.
7. Map [live captures/listings](live/README.md) to application-owned immutable preview IDs and
   listing generations. Keep renderer authorization, expiry, MIME/range serving and scratch
   quotas in the application. Serialize public live operations and guest callbacks. A capture
   fixes observed bytes but does not prove an atomic guest snapshot; a later final file can differ.
8. Close callback admission, join readers/native sessions and stop every writer before final
   export. Compare the captured initial manifest against the fully validated stopped output.
   Publish artifacts only after validation; preserve unknown writes and cleanup failures without
   automatic replay. Destroy exact owned resources and independently verify their absence.
9. Test application Run/Stop, cancel/error paths, source/save/clone limits, experiment settings,
   renderer grants, final artifacts/replay and image lifecycle. Electron/macOS behavior requires
   actual target execution; the Linux SDK examples cannot certify it.

## Failure and evidence ownership

Retain each original report, command, source/archive/helper/native identity and failure. Keep
SDK operation receipts, native exits and physical cleanup observations separate. A native leader
exit does not prove descendants are gone. Reconciliation restores cleanup ownership only; make
the original controller quiescent, reuse the matching configuration and original trusted record,
and retry the exact owner. No broad prune, label-based adoption or automatic create/model replay.

For platform tooling, preserve the observer record until guest quiescence is independently
established. Then use its exact `cleanupDaemonObserver` retry owner as documented by the platform
runner. Delete only verified task-owned helper images and host scratch after open actors settle;
preserve borrowed images, fixtures and unrelated workloads.

New or changed platform rows require their own observed effects, independent cleanup and exact
identities. The recorded Mac baseline above does not certify another tuple or artifact. Battle
Bots integration remains a separate consumer change.

## Credential reuse native campaigns (2026-10-28)

### API-key follow-up (EP-20261028-001)

The follow-up passed twenty API-key rows under restricted HTTPS: five providers, each with a normal
file task and cancellation on Linux x64 and Docker Desktop native arm64. There were twenty-one row
attempts. The first Desktop Claude normal attempt failed during sandbox startup before native entry;
its original checkpoints and explicit-404 cleanup are retained. A fresh attempt with identical inputs
passed. No failed attempt is replaced by its retry.

| Controller tuple | Native-used candidate |
| --- | --- |
| Linux x86_64, Node 24.18.0, Engine 29.1.3 / API 1.52 | Same ten installed 0.4.6 archives and public example inputs |
| macOS 26.5.1 arm64, Node 24.15.0, Desktop 4.54.0 build 212467, Engine 29.1.2 / API 1.52 | Same ten archives, with native arm64 images and Apple Virtualization, IPv4-only networking |

| Route | Selected model | Linux normal / cancel | Desktop normal / cancel |
| --- | --- | --- | --- |
| Claude Code 2.1.273 / Agent SDK 0.3.273, Anthropic API key | `claude-haiku-4-5-20251001` | pass / pass | pass / pass |
| Codex CLI 0.163.0, OpenAI API key | `gpt-6-luna`, reasoning `low` | pass / pass | pass / pass |
| Grok Build 1.0.62, xAI API key | `grok-build-0.1` | pass / pass | pass / pass |
| OpenCode V2 2.1.2, Anthropic API key | `anthropic/claude-haiku-4-5-20251001` | pass / pass | pass / pass |
| Cursor CLI 2026.10.22-27dcf5f, user API key | `grok-4.7-medium` | pass / pass | pass / pass |

Every accepted normal row verifies the exact uppercase file written by native tools and successful
native settlement. Every cancel row observes nonempty native output on its original reader or public
callback before abort, then requires an actual cancelled settlement. Native entry facts retain ordering
and available byte counts without retaining the output text. Cleanup queries each original SDK resource
identity through the bounded Engine API; only an explicit HTTP 404 establishes absence. Original recovery
checkpoints and every attempt remain retained. A daemon, permission, transport or parse error fails
qualification rather than being counted as absence.

All four Codex `auth_json` rows (normal and cancellation on both tuples) are explicitly deferred until
a future quiescent session. Neither auth file was read or used by this follow-up, and no Codex or
CodexBar process was stopped. The source-copy mechanism remains available under its caller-quiescent
contract; this API-key record adds no saved-auth, refresh-lineage, Rosetta, billing or fleet guarantee.
The launch recipes' static historical preflight labels do not attest a caller's image, credentials or
the follow-up's deferred routes.

The native-used pack is retained at
`/Volumes/AGENAI/Qualification/sdk-auth/EP-20261028-001/ms003/packed-native-r1`, with execution source
`36fae180aa7476a9c80d31ae0b9edf403b514383`. Nonsecret reports, original native archives and platform
inputs are retained under the same plan's `ms003` directory. In the AgenAI repository, the final record
belongs under `.agent/exec_plans/complete/2026/10/28/EP-20261028-001_sdk-sandbox-auth-followup/artifacts/`:
`ms003-validation.md`, `ms003-native/summary.json`, `ms003-retention-manifest.json` and
`ms003-archive-comparison.json`. The final documentation pack retains identical executable archive payloads and example inputs.
The comparison separately records dependency-map key ordering in three package manifests,
documentation edits and consumer-path rebasing with derived archive-integrity and hook-checksum
updates; dependency values and every other manifest field remain unchanged. Native reports retain
their original pack identities.

### Historical predecessor (EP-20261027-001)

The predecessor's original reports marked twenty-four rows passed, including Codex saved-auth copies.
Those reports remain unchanged. They used a fixed 1.5-second cancellation timer without proving native
entry first, and treated every failed `docker inspect` as absence. They therefore do not establish the
follow-up's entered-native cancellation or explicit-404 cleanup guarantees, including for the four
saved-auth rows deferred above. Its ten original package archives were not retained; later packs cannot
restore that missing artifact record. Its normal-task observations retain their historical scope.

| Tuple | Engine | Candidate |
| --- | --- | --- |
| Linux x86_64 | Docker Engine 29.1.3, Node 24.18.0 | export of `df51bdf80`; full packed aggregate 20/20 |
| Docker Desktop native arm64 | Desktop 4.54.0 / Engine 29.1.2 / API 1.52, IPv4-only | packed sandbox-platform consumer of the same packages |

Its native harnesses were pinned and integrity-verified: Claude Code 2.1.273 (Agent SDK 0.3.273), Codex
CLI 0.163.0, Grok Build 1.0.62, OpenCode V2 2.1.2 and Cursor CLI 2026.10.22-27dcf5f. Each route
reported a normal task and a cancellation on each tuple, 24 rows in all:

| Route | Credential | Normal | Cancel |
| --- | --- | --- | --- |
| Claude Code | API key | pass / pass | pass / pass |
| Codex | API key | pass / pass | pass / pass |
| Codex | quiescent ChatGPT `auth.json` copy | pass / pass | pass / pass |
| Grok Build | xAI API key | pass / pass | pass / pass |
| OpenCode V2 | Anthropic API key | pass / pass | pass / pass |
| Cursor CLI | user API key, model `grok-4.7-medium` | pass / pass | pass / pass |

Each cell is Linux / Desktop. A normal row imports a fresh token file, has the native agent write
its uppercase form with its own tools, and verifies the exported result exactly. The reports recorded
native cancellation and resource absence under the limited checks described above. They also recorded
both host `auth.json` sources unchanged and no credential values in retained reports. These historical
observations do not fill the follow-up's deferred rows.

The campaign found and fixed five real defects:

- recipes had no relay variables for restricted HTTPS;
- Codex's API-key route used a `CODEX_HOME` that did not exist;
- Codex needs its sibling `codex-code-mode-host`;
- the slim Node base lacked a CA store;
- the broker rejected Node `fetch`'s portless CONNECT `Host`.

The broker change was requalified by the 46-case Linux restricted-network/recovery campaign on the
same candidate. One fixture was adapted because `httpbin.org` now redirects only to its own allowlist.

The predecessor retains its credential transport, authentication and normal tool-task observations
on its recorded tuples. Its cancellation and absence reports have the limitations above. Neither
campaign establishes token lifetime, concurrent refresh coherence, billing, account eligibility beyond
the observed runs, or Rosetta amd64 Desktop credential behavior.


## Authentication parity native campaigns (2026-10-28)

The corrective branch adds required existing-login support for **all five harnesses**, separately
from the immutable published 0.4.6 API-key record above. The installed `ms004-packed-r3` development
candidate passed **forty required positive rows**: five harnesses × key/account × normal/entered
cancellation × Linux x64/Desktop native arm64. Four additional OpenCode configured-OpenAI-key rows
passed normal execution and entered cancellation on both platforms. These are real authenticated
model tasks using the user's existing accounts and keys, not scripted authentication results.

| Harness and pinned native | API-key route | Existing-login route used in the real campaign |
| --- | --- | --- |
| Claude Agent SDK 0.3.273 / Code 2.1.273 | Anthropic key, Haiku 4.5 | Existing native Keychain access token through `CLAUDE_CODE_OAUTH_TOKEN` |
| Grok Build 1.0.62 / revision `1474f9cbdd91` | xAI key, `grok-build-0.1` | Selected native first-party `auth.json`, `access_token_only`, subscription proxy |
| OpenCode V2 2.1.2 | Legacy Anthropic key and configured OpenAI key | Existing ChatGPT access token/account ID imported by native OpenAI `chatgpt-headless`, `openai/gpt-6-luna` |
| Cursor CLI 2026.10.22-27dcf5f | Cursor user API key | Existing native Keychain account token through `CURSOR_AUTH_TOKEN` |
| Codex CLI 0.163.0 | OpenAI key, `gpt-6-luna` | Selected existing ChatGPT auth projected into native `chatgptAuthTokens`, with refresh excluded |

The controller explicitly read the authorized native stores. The SDK itself requires explicit
credential inputs and does not silently discover logins. Host OpenCode 1.18.25 had no V2 account
export; its row therefore used the existing ChatGPT login through V2's native OpenAI import, not
an invented OpenCode login. All account runs excluded refresh authority. They demonstrate existing
account reuse for the bounded task, not indefinite lifetime, refresh coordination, all model
entitlements or billing amounts. Claude/Cursor refreshable files, Grok/Codex quiescent copies,
other OpenCode OAuth methods/providers and Rosetta remain outside this live matrix. Native source
and synthetic checks cover their separately documented selection/import boundaries.

Normal rows exported the exact uppercase contents of a fresh input file. Cancellation rows observed
native output on the original reader before abort, then required a cancelled settlement. Desktop
also ran five invalid-account controls with competing valid keys available to the controller;
Grok/OpenCode source inputs contained unselected competing key records. All five produced no task
result and failed without fallback, then cleaned up. Their sanitized reports do not retain raw
provider error messages or claim an exact HTTP authentication status. One additional Desktop
configured-key attempt failed during sandbox startup before native entry; its original record is
retained, fully cleaned, and excluded from the forty-four positive rows. A fresh attempt passed.

Retained root: `/Volumes/AGENAI/Qualification/sdk-auth/EP-20261028-002`. Original r3 archives and
installed examples are under `ms004-packed-r3`; the ten development archives still carry 0.4.6
version fields and are **not published 0.4.6 replacements**. Exact SHA-256 values and sizes are in
the corrective ExecPlan's `artifacts/ms004-evidence.json`. Later corrective release artifacts must
retain this original identity and explicitly reconcile any changed payload; no version rename alone
constitutes a new native run.

Desktop uses macOS 26.5.1, native arm64, Desktop 4.54.0 / Engine 29.1.2, host Node 24.15.0 and guest
Node 24.18.0. Linux uses x86_64, Engine 29.1.3 and Node 24.18.0. Both retain the original native input
pins, immutable Node/GCC image digests, caller-prepared network authority and private per-run state.
Desktop's r2 preparation is reused only after complete r2/r3 archive and guest-asset comparison:
three package manifests differ solely in dependency-key ordering; all other package bytes and all
four guest assets match. Linux installed r3 frozen/offline with only rebased pnpm-hook checksums;
package resolutions did not change.

Desktop's final audit covers 28 attempts, 229 original plus 229 repeated resource-absence HTTP 404s,
651 original recovery checkpoints and removal of all 58 owned prepared images. Linux covers 22
attempts, 158 original plus 158 repeated HTTP 404s, 470 original checkpoints and removal of all 43
owned prepared images. Both preserve their two borrowed base images. The final checkpoint of every
attempt matches its original SDK-returned destroyed record. Private account imports were removed;
file-source identity checks passed. The audit never translated a recovery record or replayed a task.

Independent review found OpenCode 2.1.2 proactively resolves OAuth by refreshing within five minutes
of expiry, even with an empty refresh field. The correction rejects access-only inputs already inside
that window and reports refresh credentials as `not_supplied`; a delayed or later resolution may
still fail early. The original fresh-token live passes remain valid. Their original `refresh: disabled`
metadata describes excluded refresh authority too broadly and is superseded by this clarification;
the reports are retained unchanged. The native-resolution regression and final candidate comparison
are recorded in the corrective ExecPlan, separately from the original forty-four positive runs.

### Corrective 0.4.7 candidate applicability

The coordinated unpublished `ms005-platform-r1` 0.4.7 archive set passes the portable installed
sandbox proof. Its complete ten-package comparison against reviewed `ms004-packed-r5` allows only
package version, internal SDK dependency ranges, dependency-map ordering and README changes; all
runtime, declaration and native-asset bytes match. The five example differences are documentation
and the Claude example workspace version. Execution code and guest launchers match. This establishes
applicability through the recorded r3 → r4 → r5 → 0.4.7 comparison chain, including the separately
reviewed OpenCode expiry guard. It does not rename the original live runs as 0.4.7 executions.
The original and candidate archive digests remain in the corrective plan's evidence manifests.

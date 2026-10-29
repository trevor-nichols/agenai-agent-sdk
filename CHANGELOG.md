# Changelog

All notable changes to the coordinated AgenAI Agent SDK package set are recorded here. Releases
`0.4.0` through `0.4.3` use the three core packages and four optional packages (orchestration, ACP
transport, ACP provider and ACP registry). Release `0.4.4` adds optional history, neutral sandbox contracts
and a local Docker backend, for ten coordinated packages.

## 0.4.7 - Unreleased

Complete API-key and existing-login Docker recipes for all five native harnesses, with matching
coordinated package versions. Protocol V13 and recovery v3 remain unchanged; read
[UPGRADING-TO-0.4.7.md](UPGRADING-TO-0.4.7.md).

- Add Claude OAuth-token/saved-account and Grok native subscription-account selection.
- Add OpenCode provider/model-specific key or native OAuth import into fresh private state, and
  Cursor native account-token/file selection; preserve existing synchronous key interfaces.
- Add explicit access-only Grok/Codex/OpenAI-OpenCode projections for existing active host logins.
  Reject OpenCode access-only credentials already inside its five-minute native refresh window.
- Retain forty required real key/account normal/cancellation passes across Linux x64 and Desktop
  arm64, four additional configured OpenCode-key passes, invalid-account controls and exact cleanup.
  Evidence and native-input limitations are in the [parity record](examples/sandbox/HANDOFF.md#authentication-parity-native-campaigns-2026-10-28).

## 0.4.6 - 2026-10-28

All ten published packages are coordinated at `0.4.6`; npm `beta` and `latest` select this release.
Agent Protocol remains **V13**. See the [v0.4.6 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.6) and read
[UPGRADING-TO-0.4.6.md](UPGRADING-TO-0.4.6.md). There is no recovery-format change and no migration
from `0.4.5`.

- Retire an observed-absent ACP process-group ID before stream closure, preventing later cleanup from signaling a reused ID. This post-native correction has separate fresh source/packed regression proof; it does not relabel the retained native campaign.
- Add explicit credential reuse for sandboxed native harnesses in `@agen-ai/sandbox/node`: a bounded
  stable reader for a caller-selected credential file and a same-process bootstrap that writes one
  private ephemeral guest file before the native process starts. Nothing is discovered, persisted or
  written back to the host.
- Restricted HTTPS now accepts a CONNECT `Host` header without the default `:443` port, which Node's
  `fetch` sends. The request line still selects the destination; every other rule is unchanged.
- Public examples add credential recipes for Claude Code, Codex (API key or a quiescent ChatGPT
  `auth.json`), Grok Build, OpenCode V2 and Cursor CLI, with secret-free preflight facts and egress
  derived from the sandbox's effective network policy.
- The five API-key recipes passed twenty normal-task and entered-native cancellation cases across
  Linux x86_64 and Docker Desktop native arm64 under restricted HTTPS, with explicit Engine HTTP 404
  cleanup evidence. All four Codex saved-login cases remain deferred to a future quiescent session;
  see the [qualification record](examples/sandbox/HANDOFF.md#credential-reuse-native-campaigns-2026-10-28)
  for the exact tuples, retained attempts and limitations of the predecessor evidence.

## 0.4.5 - 2026-10-27

At publication, all ten packages were coordinated at `0.4.5`, with npm `beta` and `latest` selecting that release.
Agent Protocol remains **V13**. See the [v0.4.5 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.5)
and read [UPGRADING-TO-0.4.5.md](UPGRADING-TO-0.4.5.md) before migration. The selected patch
version includes explicit sandbox contract changes requiring caller/driver updates.

- Add opt-in Linux x64 restricted HTTPS CONNECT with exact destination policy, pinned local
  route authority, separate immutable relay/broker helpers and fail-closed infrastructure loss.
- Add explicitly granted live workspace stat/list/read/write through a descriptor-anchored
  native helper, bounded streams, precise publication/uncertainty receipts and whole-owner cleanup.
- Add opt-in confined symbolic-link transfers, links-last publication and disk-backed namespace
  validation while retaining default rejection and no-follow live/exact-file operations.
- Advance cleanup records to v3 with Linux `engine-1.52-v5-linux-x64` and Desktop
  `engine-1.52-v6-*` revisions, with at most nine exact owned roles including Desktop `route_observer`. Drain old records with their matching controller; no conversion or replay.
- Add consumer-owned captured preview/listing, Grok ACP file-scope and exact Claude SDK spawn
  examples. Vendor authority remains optional and explicit; the neutral packages acquire no
  provider credential, host filesystem callback or product workflow.
- Record separate Linux native scripted and API-key tool/cancellation qualifications for the
  exact Claude/Grok compositions. The real account campaign used private qualification-only
  gateway tooling; it proves neither arbitrary auth routes nor billing or hostile-guest secrecy.
- Provide installed helper-context proof and the [platform/consumer handoff](examples/sandbox/HANDOFF.md).
- Record the exact [M3/macOS 26.5.1 baseline](examples/sandbox/HANDOFF.md#recorded-mac-baseline-2026-10-26):
  native arm64 and AVF/Rosetta amd64 each passed 30 checks and the installed two-turn controlled
  ACP example; internal and external APFS each passed all 183 host tests without skips. Pinned
  Grok 1.0.62 passed version/hash and eager initialization only. Desktop live files have a separate
  18-case installed campaign per profile. Separate [MS004 r2 native campaigns](examples/sandbox/HANDOFF.md#desktop-preserving-transfer-native-campaigns-2026-10-27)
  passed all 136 preserving-transfer cases on each Desktop profile, across both APFS roots and
  workspace layouts, with complete cleanup and 230 final-empty scopes per row. Separate
  [MS005 N12/R2 restricted-HTTPS campaigns](examples/sandbox/HANDOFF.md#desktop-restricted-https-native-campaigns-2026-10-27)
  each passed 26 installed cases and 98 final-empty scopes on the exact IPv4-only caller-quiescent
  tuple. Separate MS006 native N2/Rosetta R1 generic combined campaigns passed thirteen cases
  and 62 final-empty scopes each on packed-ms006-r3; real Linux x64 R1 passed eleven combined
  cases plus fresh eighteen-case live-file and 68-case preserving-transfer rows. The same
  public workflow covers normal completion, entered-write cancellation and fresh-process
  cleanup from exact original/SDK-returned settled checkpoints without replay. Fresh MS006 Linux
  network R1 separately passed 46 network/recovery cases and 378 independent absence observations
  against the current installed candidate/controller. Mac datasets, large-workspace
  scale, native model/authentication and Battle Bots/Electron integration remain unqualified.
- Preserve leading U+FEFF in filesystem names, link targets and metadata identities at the five affected UTF-8 decoding boundaries.
- Preserve the original Engine upload-producer error when a request-origin aborted transport
  wrapper has that exact producer error as its cause. Join producer cleanup before returning;
  distinct cleanup errors remain aggregated. This narrow derived-abort repair changes no public
  API, transfer protocol or recovery revision.

## 0.4.4 - 2026-10-24

This release advances Agent Protocol to **V13** with native structured final responses and adds
optional history and explicit optional sandbox execution. Managed store contract 4 and SQLite format 3 remain unchanged.
All ten published packages and SDK dependency ranges are coordinated at `0.4.4`; npm `latest`
and `beta` select that complete release. History and both sandbox packages complete their first
publication with verified trusted publishers; temporary setup stages have been removed. Package
publication makes no private deployment change. See the
[v0.4.4 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.4) and
[UPGRADING-TO-0.4.4.md](UPGRADING-TO-0.4.4.md).

### Added

- Add explicit single-subtree export with targeted Docker archive reads, checked ancestors and workspace-relative output paths.

- Add optional `@agen-ai/sandbox` and `@agen-ai/sandbox-docker` packages with a separate
  `@agen-ai/sandbox/acp` bridge. The neutral root has no Docker or ACP requirement; all backend
  authority is explicitly supplied. Extend export, release admission and packed-consumer checks to
  the exact ten-package release while leaving the core/runtime dependency graph unchanged.
- Add the credential-free [sandbox walkthrough](examples/sandbox/README.md) and reusable
  example lifecycle. One native connection/process and one SDK session support multiple turns;
  eager materialization, whole-compute stop, retained-file export and final destruction share
  exact cleanup ownership. Persisted recovery restores cleanup only, without execution replay.
- Add exact local Docker image admission and finite CPU, memory, PID, tmpfs, stream and transfer
  policy, disabled ACP host facilities, and explicit isolated or broad outbound networking.
  Arbitrary workload image ENV metadata and host mounts are not admitted; required hard workspace quotas reject before reservation until native enforcement is qualified.
- Add `generateObject` through the explicit `@agen-ai/agent-runtime/generation` entrypoint.
  It borrows a validated instance, owns one fresh session/turn and its output reader, decodes an
  authoritative JSON object and closes the session before returning a typed value. The caller
  retains instance disposal, credentials, tool/sandbox policy and application persistence.
- Add the bounded `agenai.output-schema.v1` JSON Schema draft 2020-12 profile, neutral
  `createAgentOutputDefinition` and explicit `/zod` `zodOutput`. Inference comes from an actual
  decoder/schema; decoders must preserve the JSON value and successful results are deeply frozen.
  The Zod convenience rejects transforms, refinements, defaults, coercion, optional fields, and
  string/array length checks. Neutral string and array bounds remain supported.
- Add the public [title-generation example](examples/generate-title.ts), compiled and executed
  from installed tarballs using only public entrypoints. It saves a typed title only after session
  cleanup. Add deterministic installed failure, scope, deadline, observer, decoder, interaction and
  cleanup-retry qualification without native model calls.
- Add an explicit public Grok Build 1.0.62 structured-output mapping through stable ACP
  `schema-v1.23.0`. Installed real-backend proof covers title/rich objects, a changed per-turn
  schema, ordinary text afterward and independent cleanup on its exact qualified tuple.
- Add optional `@agen-ai/agent-history` with plain contracts/parsers, explicit `/zod`, custom driver
  composition, scoped catalogs, metadata lookup, transcript/run views, separate native search
  ports and individually enabled saved-session management. Imports remain inert and native
  dependencies are optional peers for their selected constructors.
- Add qualified explicit readers for Claude SDK 0.3.306 / Code 2.1.306, Codex app-server 0.163.0,
  OpenCode V2 2.1.2, Cursor SDK 1.0.40 JSONL/SQLite local stores and Grok Build 1.0.62. Generic
  ACP stable `schema-v1.23.0` provides negotiated catalog discovery only.
- Preserve live coverage, native retention/omissions, stable native anchors when available and
  instance-sealed pagination. Metadata matching retains each provider's native title semantics;
  only the qualified Grok mapping supplies ranked native content search. No SDK index or private
  parser fallback is introduced.
- Require explicit management selection and exact accepted effects. Preserve applied native
  receipts across later failures, return honest unknown outcomes after uncertain dispatch,
  fence further mutation without replay, and retain cleanup ownership until native work settles.
- Add reusable public browsing and explicitly configured Claude examples with packed-consumer
  acceptance across isolated compositions. Browsing needs no runtime session or model turn;
  stored tools, instructions and attachment references remain inert.

### Changed

- Replace array file transfer with streaming `importTree` / callback-scoped `exportTree`, optional
  caller quotas and no implicit total transfer timer. Preserve exact-length/body ownership,
  provisional export completion, bounded external metadata sorting and retryable spill cleanup.
  Add explicit `@agen-ai/sandbox/node` spill storage; Docker requires `spillDirectory` and uses
  profile-bound backend revisions `engine-1.52-v4-<profile>`. Exact-file exports read only admitted selected paths.
- Add exact borrowed read-only image datasets under `/datasets/<name>` on Engine 29.1.4+ with the admitted containerd/overlayfs image store, with separate private writable workspaces and no automatic pull or borrowed-image deletion.
- Add explicit `workspaceDiskQuota` no-request/required allocated-block policies. Required enforcement rejects before reservation on the current unsupported backend; positive quota support remains deferred.
- Bind cleanup recovery v2 to a separate immutable configuration digest covering profile, user, workload image and dataset attachments. Legacy records are rejected before effects.
- Add explicit Docker controller/daemon/image profiles: existing `linux-x64` default and
  Apple Virtualization native-arm64/Rosetta-amd64 candidates. Bind recovery to the selected
  profile; old and cross-profile revisions reject before Engine access. Desktop settings are
  explicit caller assertions, separate from Engine observations. Actual Mac qualification is
  pending; a portable installed-consumer lane and daemon-side cleanup observer support the
  documented Mac handoff without changing the full Linux proof lane.
- Remove universal cumulative process-traffic and 256 MiB tmpfs ceilings while retaining explicit
  CPU/RAM/PID resources and bounded stdin/output staging. Docker archive encoding currently
  represents single files through `8 GiB - 1`; aggregate workspace size has no SDK ceiling.

- Default sandbox execution to `until_stopped`, with no implicit execution or idle timer. Add
  explicit `{ kind: 'deadline', timeoutMs }` execution policy without a business-duration ceiling,
  including timer-safe multi-day durations. Transfers accept optional per-call `deadlineAt`;
  retired `deadlines.executionMs` and `operationMs` inputs must migrate and are rejected. Input types permit
  omission while parsed policies always carry the normalized choice. Smoke/eval budgets remain
  explicit application configuration; resource, stream, cleanup and recovery safeguards remain.
- Add explicit `/node` directory imports with descriptor reads and staged directory exports.
  Export reserves a fresh private namespace, publishes its `files` child only after complete
  validation, preserves existing destinations and retains local cleanup retry ownership.
  Caller-owned source hierarchies must be stable and quiescent; no snapshot guarantee is added.
- Preserve omitted ordinary ACP turn deadlines without a provider prompt timer. Caller-selected
  `deadlineAt` uses native-confirmed cancellation and supports dates beyond Node's timer range.
  Retire provider `promptTimeoutMs`; move finite execution budgets to caller turns and use separate
  finite `terminalWaitTimeoutMs` for host terminal waiting. Direct transport requests keep finite
  defaults and may explicitly select `lifetime: 'until_settled'`, mutually exclusive with numeric
  timing fields. Pending request, response, cancellation and cleanup ownership remain enforced.
- Advance current live protocol envelopes from V12 to V13. Require
  `turns.structuredOutput` capability and `turn.completed.payload.structuredOutput` result variants
  for every adapter, including explicit unsupported/not-requested declarations. Add optional
  scope-correct output requests to fresh create and turn inputs; structured resume/branch remain
  unsupported. Historical decoders preserve old stored data without accepting old live envelopes.
- Keep native execution outcome separate from structured-result availability. Missing, refused,
  incomplete, invalid, mismatched, oversized or exhausted native output never becomes a typed
  success. There is no prompt-only fallback, automatic repair or automatic replay.
- Bound generation, observers, request handling and cleanup independently. Retain exact callable
  cleanup ownership and primary errors/results after incomplete cleanup; an abort or uncertain
  response does not authorize repeating generation.
- Admit only the complete matching ten-package source/archive set before publication can begin.
  Reject incomplete, foreign, duplicate or mixed-version artifacts. The public root stays private.
- Preserve the distinction between historical development archives and the published ten-package
  release. Retain exact release bytes, provenance and registry-consumer proof separately from
  native qualification. All ten package names have verified trusted publishers with publication
  and staging permissions, without separate dist-tag promotion permission.

### Fixed

- Complete Docker resource cleanup when cancellation or persistence failure occurs after a
  `creating` checkpoint but before create dispatch. Only the original owner's dispatch record
  proves that no effect entered; recovered uncertain acquisitions retain their existing safeguards.
- Preserve process streams while Docker reports a non-running exec with a null exit code after
  upgrade. Wait for a numeric terminal status under the selected execution policy without replay.
- Keep generation request handlers active when a provider expiry falls beyond the generation
  deadline. Only earlier provider expiries need a separate timer, avoiding Node timer overflow
  for distant valid dates while preserving timely expiry and rejection of late answers.

### Qualification limits

Sandbox backend and installed proof covers Linux x86_64 / Node 24.18.0 / rootful Docker Engine
29.1.3 API 1.52, cgroup v2/systemd, default seccomp, AppArmor and private cgroup namespaces.
Separate Grok Build 1.0.62 (`1474f9cbdd91`) API-key evidence covers four portable turns: exact file
task and follow-up, a fresh isolated repeat, and cancellation after observed content. It records
six delivered once-only approvals and independent compute absence before export plus complete
retained-resource absence after destruction. The [Docker package README](packages/sandbox-docker/README.md#qualification-scope)
records the exact binary identity, requested model/reasoning and scope. This does not qualify
other providers, subscription authentication, fleet execution or billing. Hosted Docker CI results,
credential-free source/packed checks and authenticated native evidence retain their separate
workflow, artifact and qualification identities.

Native evidence remains specific to the recorded Linux x86_64 / Node 24.18.0 tuple and exact native
inputs. The portable root supports Node >=22; Cursor construction requires Node >=22.13. Cursor
IDE/legacy CLI stores and cloud replay are unqualified; the sampled retained cloud stream returned
HTTP 410 and no cloud constructor ships. Grok mutation proof covers only the owned unauthenticated,
networkless, caller-quiescent local composition. Native read storage effects remain explicit.
Structured-output public qualification uses Grok Build 1.0.62 (`1474f9cbdd91`), `grok-4.3`, low
reasoning and xAI API-key authentication through installed matching `0.4.4` packages. Private
Codex app-server 0.163.0 and Claude SDK 0.3.269 / Code 2.1.269 have separate diagnostic native
proof; no public Codex/Claude provider ships and production admission/containment remains
unqualified. Claude history's 0.3.306 / 2.1.306 tuple remains separate. Generic ACP, OpenCode and
Cursor structured execution remain unsupported. Successful values guarantee accepted shape and
local decoding, not factual truth, completion of every invocation, backend call count or billing.

The private monorepo's Host V26/catalog V18/Agent13 successor and immutable V25 recovery are
source changes only. Public packages do not enable private member/managed structured requests,
deploy services, migrate production storage or activate a fleet. Prior MS009 history example/native
evidence retains its original archive identities; current installed assembly and structured-output
proof are separate. No qualification establishes arbitrary stores/platforms or history backend
authentication/billing. First-publication setup and trusted-publisher verification for history
and both sandbox packages are complete for this release; future operations require authorization.

## 0.4.3 - 2026-10-20

This coordinated patch keeps Agent Protocol V12, managed store contract 4 and SQLite
format 3. Upgrade all seven packages together; no envelope or storage migration is
introduced. See [UPGRADING-TO-0.4.3.md](UPGRADING-TO-0.4.3.md).

### Fixed

- Reserve the shared execution slot for immediate idle-session operations so they
  cannot overlap caller turns or native continuations. Exact cached idempotent
  results do not reserve another execution.
- Start native quiescence before close joins entered operation work and awaited
  output. Entered failures preserve uncertainty and cleanup ownership.
- Accept provider-owned retry observations through the operation's exact output
  correlation without creating a conversational turn.
- Keep a retired managed-request presentation signal aborted across Node 24 garbage
  collection; request retirement cannot silently restore presentation eligibility.

### Added

- Add a public-entrypoint operation walkthrough with exact discovery/revision,
  confirmation, awaited observations, no-effect completion and cancellation.
  Eight synthetic cases compile and execute against packed core SDK artifacts.
- Retain the exact complete release archives and source lockfile before npm upload.

### Scope

The private Claude adapter's manual/automatic compaction implementation and host
policy are outside the public package inventory. This release adds no public Claude
constructor or universal compaction method. Existing native qualification retains
its original artifact/version scope; current-source checks and packed examples do
not establish new native/backend authentication, billing or deployment claims.

## 0.4.2 - 2026-10-17

This coordinated release advances all seven packages to `0.4.2` and Agent Protocol
to V12. Review [MIGRATING-TO-0.4.2.md](MIGRATING-TO-0.4.2.md) for the protocol and
session-response changes before upgrading the installed package family together.

### Added

- Add `request.unavailable` to retire an exact turn request while preserving the
  original output reader, unrelated work and independently entered answer receipts.
- Add typed session forms and plan reviews alongside decisions, with tagged
  responses, exact offered actions and plan identity/revision validation.
- Add explicitly supported native continuations that share the caller-turn
  execution slot. A host must install an execution owner and start reading output
  before the work-starting response is dispatched; no extra prompt is synthesized.
- Add bounded adapter FIFO ownership for native callbacks, including withdrawal
  of displayed or queued requests and retained callback/write settlement.
- Add explicit `until_withdrawn_or_closed` human waiting for supporting adapters.
  The default remains five minutes; provider expiry, response/cleanup deadlines
  and retained-work limits remain independent.
- Add core-only and ACP session-continuation examples, updated live-request
  examples, and matching packed-consumer coverage through public entrypoints.

### Changed

- Advance current protocol envelopes to V12 and managed store contracts to 4.
  SQLite physical format remains 3. Historical records retain their original
  decoder and delivery evidence; changing a version field is not a migration.
- Require tagged session decision responses and exact support declarations for
  opening operation, request kind and continuation timing. Missing support remains
  unsupported. Core packages retain their existing dependency boundaries.

### Fixed

- Keep request availability separate from response delivery, continuation outcome
  and cleanup. Withdrawal never rewrites an entered receipt or permits answer replay.
- Fence retired IDs through a shared bounded session-generation census and retain
  actual producer, callback and response ownership until cleanup has joined them.

### Qualification

- Retain 15 selected genuine vendor-executable cases with scripted local model
  responses and fixture credentials. These establish their recorded native/SDK
  compositions, not real backend authentication, inference or billing.
- Qualify the exact selected Grok Build `1.0.60` resume/plan-review continuation
  after opening, with automatic parent wake disabled and the recorded single-worker
  limits. Simultaneous native Grok callbacks entering the SDK FIFO remain
  unqualified under the accepted qualification amendment; controlled generic FIFO
  and genuine Claude FIFO evidence are separate.
- The Claude SDK `0.3.301` / Claude Code `2.1.301` composition is diagnostic and
  does not add a public Claude provider. Native human-wait observation is bounded
  to 250 ms and does not qualify arbitrary native waiting.
- Preserve the exact earlier Grok `1.0.50` trust/remembrance evidence and recorded
  resource-limit warnings. Publication does not expand those scopes or deploy the
  private V25 host source.

## 0.4.1 - 2026-10-15

This coordinated release advances Agent Protocol to V11. All seven packages are published
at `0.4.1`, selected by npm `latest` and `beta`. See
[MIGRATING-TO-0.4.1.md](MIGRATING-TO-0.4.1.md) before adopting the new lifecycle surface.

### Added

- Add the closed `AgentApprovalConsequence` union. Precise options carry a `scoped` consequence;
  provider-managed remembrance carries explicit unknown duration and applicability with a bounded
  explanation. Supported approval capabilities declare `providerManagedRemembrance`; existing
  default once-only ACP mapping declares false.
- Add constructor-selected ACP permission mappings: an exact Grok 1.0.50 edit profile and a bounded
  complete-menu declaration for inspected peers. Both preserve exact native option IDs, unknown
  remembered boundaries, remembered denial versus cancellation and the original output reader.
  Selected identities and complete menus are validated; the default remains once-only.
- Add core-only `examples/remembered-approvals.ts` and optional
  `examples/remembered-approvals-acp.ts`, with matching example commands. The synthetic walkthroughs
  display explicit unknown remembrance bounds, select exact offered IDs, retain the original output
  reader and join cleanup. The controlled ACP peer records actual correlated replies for remembered
  allow, remembered deny and cancellation; neither example claims native persistence. Packed
  consumers compile and run the same sources, preserving the core-only three-package installation.
- Add bounded neutral workspace decision requests, offered choices, explicit grant/decline
  consequences and exact-choice parsers. Persistent provider-managed workspace grants declare
  that they may affect other sessions; decline keeps configuration gated without promising
  revocation or a persisted denial.
- Add optional runtime `sessionInteractions` support per opening operation and request kind,
  with an early `interactions.onRequest` handler, bound response receipts, presentation signals
  and terminal observation. Opening can return with a live outside-turn decision and no model
  turn. Omitted support remains unsupported and ordinary no-handler callers retain their path.
- Bound retained requests/bytes, expiry, responses and cleanup observation. Preserve actual
  callback, response and producer ownership through terminality; uncertainty fences mutation
  without authorizing response replay. Failed opening and cleanup retain exact callable owners.
- Add the explicit Node `grok-folder-trust-v1` create-only mapping for a genuine direct native
  executable with exact `agent --no-leader stdio` arguments. It requires an early handler and a
  host-supplied exclusive descendant-owning execution boundary before materialization. Injected
  or shared connections, selected-profile resume/branch, interactive materialization and
  outside-turn forms/authentication remain unsupported.
- Add the typed `NodeAcpExecutionBoundary` reservation/start/release port and retained
  `NodeAcpExecutionCleanupError`. Failed acquisition or initialization cleanup stays retryable
  through the registry error's exact cause, including failure before a registry is returned.
- Add a maintained typed Linux execution reference using systemd, cgroup v2 and Bubblewrap.
  Controlled proof and independent close checkpoints cover its declared host/tooling tuple;
  Linux dependencies remain outside the published packages and core imports.
- Add `examples/lifecycle-interactions.ts` and `pnpm examples:lifecycle-interactions`, a core-only
  credentialless walkthrough that retains a question after opening, answers its bound handle,
  observes terminality and joins cleanup without invoking a turn. Packed consumer coverage uses
  public entrypoints, including retained opening and startup-cleanup failures.

### Changed

- Advance serialized protocol envelopes to V11 and reject older live protocol values. Approval
  options replace flat `persistence`/`scope` fields with `consequence`; adapters must update their
  options and approval capability declaration together. Managed store contract and SQLite format
  remain 3. Exact offered-ID selection, once-only response entry and receipt meaning are retained.

### Fixed

- Start native quiescence before joining session-interaction callbacks and entered responses.
  Cleanup timeouts bound observation while retaining the actual cleanup and retry owner.
- Preserve exact startup-cleanup errors through runtime registry materialization failures.
  Successful request delivery or terminality no longer substitutes for workload cleanup.

### Qualification

- Qualify SDK03 remembered edits through the exact installed seven-package `0.4.1`/V11 set and
  genuine Grok Build `1.0.50` (`c58f321264ba`) with the selected edit mapping. One session's
  once-only edit, once-only repeat, remembered edit, exact repeat, neighboring owned file and
  uncovered terminal action have request counts `[1, 1, 1, 0, 0, 1]`, exact native reply correlation
  and actual fixture effects. An isolated loopback model fixture uses no real account credentials
  or paid/backend inference. Each successful SDK close has an independent empty checkpoint of the
  same physical cgroup before registry/host disposal, with the controller alive and no earlier
  external intervention.
- Qualify a separate retained-state SDK03 attempt with a fresh native process and native session:
  the edit asks again and runs after its exact once-only answer. Process and session change together;
  duration and applicability remain unknown. General matching, separate projects/profiles,
  remembered denial, terminal remembrance and revocation remain unqualified. Exact native-used
  archive/report identities are recorded in the
  [provider README](packages/provider-acp/README.md#qualified-remembered-edit-scope-sdk03).
- Preserve the earlier SDK02 grant, decline and pending-close qualification for its distinct
  retained `0.4.1`/V10 artifacts and exact Grok Build `1.0.50`
  (`c58f321264ba`), no-leader Node mapping, modern stable ACP `schema-v1.23.0`, API-key,
  Linux x86_64 kernel `7.0.0-38-generic`, Node `24.18.0` and frozen execution/dependency tuple.
  Grant has separate vendor-file effect proof; decline proves local delivery and absence of
  grant. Each SDK close has an independent same-cgroup empty checkpoint while the consumer is
  alive, followed by host retirement without external intervention.
- For that SDK02 session-lifetime proof, keep native wire correlation and prompt counts unobserved.
  Separate controlled peers prove
  wire behavior and no-prompt execution, while frozen native consumers invoke no SDK turn.
  Later documentation or packing can change archive identities; new `0.4.1` tarballs are not
  automatically the retained native-qualified artifacts. This scope grants no publication,
  consumer application integration, other pairing or private execution qualification.

## 0.4.0 - 2026-10-13

This coordinated release advances Agent Protocol from V9 to V10 while preserving explicit entrypoints
and core dependency boundaries. It introduces the four optional packages alongside the core set.

### Added

- Replace the segmented session API with synchronous `startTurn` reservation and one lazy execution.
  Its output reader remains live through pending requests; execution-owned `resolveRequest` returns
  independent delivered, rejected or uncertain receipts. Exact request claims prevent duplicate
  callbacks, and close starts native quiescence before joining entered controls. Public ACP and
  managed delegation use the same continuous execution contract. Managed store contract 3 and
  reference SQLite format 3 preserve historical receipts through explicit offline migration.
- Add `examples/live-request-output.ts` and `pnpm examples:live-request-output`. The packed,
  credentialless walkthrough holds an exact request open until unrelated progress is observed,
  then accepts its answer while one reader owns later output, true terminality and joined cleanup.
  Complete the published-`0.3.1` migration guide with independent human handling, exact rejected
  request availability, cancellation/uncertainty boundaries and retained cleanup ownership.
- Add bounded provider-neutral failure categories and strict recovery hints to `AgentError`, retaining
  its root imports and parsers. Category and recovery are required; the former `retryable` field is
  removed. Observed quota references reuse the account-quota reset contract. Live V10 parsers reject
  V9 values; historical records retain their recorded decoder.
- Add nonterminal turn-scoped `runtime.retrying` observations with provider ownership and optional
  retry counters and delay. Counters exclude the original attempt and are local to each provider retry
  operation. Remove `retryable` from `runtime.warning`. Recovery hints and observations grant no replay
  authority and do not alter uncertainty, retirement or cleanup ownership.

- Add optional `@agen-ai/agent-orchestration` with inert certified target catalogs and a pure
  developer/user policy resolver. Managed delegation defaults disabled, developer exclusions default
  empty, fast starts unselected, and no model/reasoning ceiling is imposed. Exact selections, unknown
  semantics and source revisions remain explicit; native subagents retain their independent policy.

- Add scoped managed task execution over the validated runtime registry, bounded volatile storage,
  exact-reference descendant ceilings, host-only live request handles and truthful steering/cancellation
  outcomes. Atomic outcome/notification and critical cleanup capacity are independent of observation
  storage. The explicit `/store-adapter` entrypoint shares closed transition rules with storage adapters.
  Host authority, resource leases and configuration attestation gate child execution, including applying
  the selected configuration before its first prompt. Parent turns do not own child lifetime.
- Add default `collect` completion and explicit compatible parent-inbox ports for `next_turn` and
  `automatic`. Keep child outcome, deduplicated inbox acceptance and authorized parent dispatch separate.
  Inspect lost acknowledgments before retry, preserve results after revocation/expiry, and never replay
  uncertain child execution or parent dispatch. `collect` requires no inbox, including with durable
  storage; any inbox configured for durable storage must be durable. Bounded latest delivery
  claim/receipt slots keep bookkeeping finite.
- Add scoped `delegation_targets`, `delegate_task`, `task_status`, `task_send` and `task_cancel` tools
  through `createDelegationHostBinding`, with bounded projections/waits and durable operation IDs.
  Disabled policy returns no binding; enabled-empty policy explains the empty catalog. Cached tools
  enforce current authority while preserving authorized result/control access. SDK-generated internal
  guidance requires no user-facing prompt template and uses truthful declared placement. Native tools
  and subagents remain independent.
- Add the explicit orchestration `/mcp` entrypoint with an owned loopback HTTP bridge using pinned
  `@modelcontextprotocol/sdk@1.29.0`. Share the scoped handlers and runtime argument/result validation;
  keep imports inert, bearer credentials host-only, and tool/server guidance distinct from trusted
  system/developer instructions. Binding release drains calls without disposing managed tasks.
- Add `isAgentProviderSessionCleanupErrorFor` to identify retained opening-cleanup ownership
  against the exact create/resume/branch input, without treating a foreign propagated error as the current
  owner. `AgentProviderSessionCleanupError` retains failed candidate cleanup without requiring host tools;
  the existing binding-specific error remains its compatible subclass. Adapters can report owned
  partial-opening cleanup with `createAgentProviderSessionCleanupError` and the exact opening input.

- Add optional session-local host tools and instruction bindings to the runtime SPI. Validate
  bounded JSON schemas, invocation arguments and results; declare adapter transport and instruction
  placement support; and retain binding ownership through create/resume/branch cleanup. Failed
  opening cleanup exposes an explicit retry handle. Existing native collaboration remains independent.
- Add optional `@agen-ai/acp-transport` with bounded Node.js JSON-RPC transport and explicit root
  and `/client` entrypoints. It owns package-local ACP v0.11.4 stable/unstable schemas, upstream
  license and provenance, and deterministic standalone generation. The core packages remain
  independent of ACP and Ajv.
- Add the separately selected stable `schema-v1.23.0` profile with immutable upstream provenance.
  Preserve legacy defaults and scope method validation and request cancellation to the selected
  profile. Modern unstable and ACP v2 methods remain unavailable.
- Add bounded `unknownExtensionPolicy: 'reject' | 'standard'`. Direct transport defaults
  to reject; public injected-stream and Node providers default to standard. Standard
  discards unknown extension notifications and returns correlated `-32601` for unknown
  extension requests without host effects. Exact known-method validation and transport
  limits remain in force; writer saturation stops synchronous rejection floods before
  further request IDs can be retained.
- Include the transport in standalone projection, packed consumer proofs, and guarded release
  workflows as part of the coordinated seven-package release.

- Add optional `@agen-ai/provider-acp` with injected connections and an explicit `/node` launcher.
  Map bounded text, reasoning, tool progress and exact once-only permission answers through
  the continuous runtime API. Keep one native prompt across request boundaries and retain explicit
  connection ownership, immutable negotiation and cancellation certainty.
- Admit transport notifications, reverse requests and received-response hooks in wire order while
  awaiting their processing independently, preserving control responsiveness under backpressure.
- Map advertised ACP resume with bounded replay suppression, explicit selectable catalogs and
  exact offered revision checks, two-stage forms preserving all native dispositions, inline images,
  observed plans/partial file changes and command catalogs. Add explicit host facilities for
  authentication, URL/form interactions, files and complete terminal lifecycles; configuration
  and host policy never imply observed integration, skill, quota or compaction support.
- Add optional negotiated `sessionMcpBinding: { transport, create }` composition to the ACP provider.
  Create/resume receive fresh session-local MCP resources before native opening, preserving static
  servers. Declare support only for the configured negotiated HTTP/SSE transport. Quiesce the native
  connection before MCP release and original runtime binding release; retain failed-opening cleanup
  handles. Setup evidence does not certify actual native tool discovery or invocation.
- Expose the transport's allocated request ID to synchronous dispatch observers so authorized
  host interactions correlate an exact active RPC. An observer that aborts admission prevents the
  original request from being written.

- Add optional `@agen-ai/acp-registry` with bounded published-v1 catalog validation, explicit source
  identities, raw-byte and normalized digests, deterministic search/selection and immutable install
  plans. Bind exact package resolution, toolchain identities and integrity/scripts/network policy
  without executing metadata. Keep bounded origin-restricted fetching under `/node` and include
  the registry package in standalone projection, packed consumer proofs and release governance.
- Add explicit verified binary/npm/uv installation under the registry's `/node` entrypoint, with
  bounded artifact acquisition, checked archive extraction, real offline package managers and
  caller-pinned toolchains. Publish complete payload receipts atomically into an owned store;
  retained launch revalidates payload/tool entries and requires a persisted active reference.
  Exact recovery tokens, reference-safe removal and independent update generations preserve
  installation ownership. Package lifecycle scripts and Python source builds remain unsupported.
- Add executable credentialless local-command and registry-plan/install/retain/run examples using
  public entrypoints and the ordinary runtime registry, session and execution-owned response APIs.
  The registry example reopens a verified store after deleting its source artifact and retains its
  installation reference through native cleanup. Both examples participate in standalone checks.
- Add executable direct-delegation and ACP/MCP workflows for target choice, configuration before
  prompting, scoped tools, host approval and children that outlive their parent turn. Add a SQLite
  task-store/parent-inbox reference and setup/inspect/restart/cleanup walkthrough with a separate
  process-crash qualification matrix. The durable reference qualifies only its documented
  Linux/Node `24.18.0`/SQLite `3.53.1`/local-filesystem tuple. Examples use public entrypoints and packed
  artifacts; deterministic peers prove integration behavior without credentials or inference.
- Add an explicitly invoked native Grok qualification runner with independently pinned
  inputs, separate discovery/selection, offline evidence checks, installed dependency
  verification, one bounded invocation lifetime and retained cleanup authority. Direct
  and fresh-process retained-binary qualification exercised Grok `1.0.50` on Linux
  x86_64 through the API-key route with `grok-4.3` / Low / observed default service tier,
  real managed callbacks, once approvals, child-result delivery and cancellation.
  Hermetic runner tests execute in source and packed-consumer checks; ordinary commands
  never launch authenticated native inference. Native completion in this example is
  volatile, and qualification remains specific to the recorded inputs. Retained version-1 reports
  describe the prior continuation API; the new version-2 execution reports require fresh qualification.

### Fixed

- Terminate the built-in ACP launcher's owned POSIX process group through bounded graceful and
  forced phases, including descendants that outlive the leader or close their streams. Require
  group and stream closure before release succeeds. Reject built-in Windows launch before spawn;
  Windows hosts supply their own owned connection and process-tree supervisor.
- Carry forward the correction first prepared in unpublished `0.3.2`: retire a validated session
  after its provider returns steering `delivery_uncertain`. The active output stream can settle,
  but later mutations fail with `session_unusable`; the host must close and rematerialize the
  session. Preserve the exact uncertainty receipt and keep definitively rejected steering reusable.

### Changed

- Coordinate all seven package manifests and their packed SDK dependency ranges at `0.4.0`.
  Validation, protocol and core dependency boundaries remain unchanged; optional packages are
  installed only by consumers that need them.
- Admit the complete seven-package source/archive set before publication and reject missing,
  unknown or mixed-version packages. Retain exact tarball, tag, provenance and guarded-retry checks.
- Document the exact schema/registry pins, capability support, host lifecycle responsibilities,
  expected versus measured integrity, dependency reproducibility gaps and separate native/platform
  qualification. Package semver remains independent of native vendor versions.
- Document the SDK-first boundary: product settings, user preference persistence, account-aware
  target catalogs and production provider registration remain host/application follow-up work.

Provider-invoked steering failure classification carries forward from `0.3.1`. Continuous execution
ownership supersedes its former waiting-interruption invalidation: terminal output stays on the
original reader after accepted interruption. Public SDK publication does not deploy a host or
change private fleet execution authority.

See [MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) for compatibility and lifecycle guidance.

## 0.3.2 - Superseded unpublished preparation

The `0.3.2` source preparation was never published. Its uncertain-steering retirement correction
is included in the coordinated `0.4.0` source above. The retained
[MIGRATING-TO-0.3.2.md](MIGRATING-TO-0.3.2.md) records that preparation; use
[MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) for the current release target.

## 0.3.1 - 2026-09-12

This coordinated patch release preserves Agent Protocol V9 and the complete public API shipped in
`0.3.0`. The `beta` and `latest` npm tags select the same `0.3.1` release.

### Changed

- Clarify that authentication and credential selection are adapter-owned. The public SDK neither
  requires API keys nor prefers them over provider-supported subscription or interactive login.
- Advance all three package manifests and packed dependency ranges together to `0.3.1` without
  adding provider-native account, credential, terminal, or product authorization contracts.
- Refresh the governed public projection, repository checks, and packed external-consumer proof
  for the coordinated patch release.

See [MIGRATING-TO-0.3.1.md](MIGRATING-TO-0.3.1.md) for the compatibility and release checklist.

## 0.3.0 - 2026-09-10

This coordinated release advances all three packages from Agent Protocol V8 to V9. The `beta`
and `latest` npm tags select the same `0.3.0` release.

### Added

- Add effective environment observations with bounded `content`, `commands`, `extensions`, and
  `integrations` domains. Each domain reports unsupported, not initialized, unavailable, partial,
  or complete state with scoped evidence, catalog revision, and observation time.
- Add focused plain entrypoints for `/effective-content`, `/commands`, `/extensions`, and
  `/environment`, plus parsers and the explicit `/zod` and `/json-schema` surfaces for the new
  contracts.
- Add capability-bound instance discovery and session observation ports. Each port explicitly
  declares `unsupported`, `read`, or `read_and_watch`; supported ports declare the domains they
  observe, and reads and invalidations echo the caller-supplied environment identity.
- Add selected `content_reference` turn input parts carrying environment, catalog, content, and
  content revisions. Add capability fields for reference count, argument support, and prompt or
  argument text formats.
- Add Apps or connector integration descriptors alongside MCP descriptors in the shared
  integrations catalog. Extension descriptors can reference exact contributed content, command,
  and integration catalog generations.

### Changed

- Require serialized protocol values and capability declarations to carry `protocolVersion: 9`.
  V8 values are rejected at the live boundary; the public parser has no compatibility mode.
- Require every materialized instance to expose `environment`, using `{ kind: "unsupported" }`
  when discovery is unavailable. Require every provider session to expose its matching
  environment observation port.
- Enforce canonical absolute discovery working directories, validated configuration, exact
  environment identity echoing, declared domain matching, caller and owner cancellation, and
  sequential watch pulls with bounded native iterator cleanup.
- Keep `managedContent` as caller-managed content and `effectiveContent` as native harness
  evidence. Effective inventory does not authorize a selected reference or provider operation;
  the product host supplies current visibility and execution authority.
- Keep all three package versions coordinated at `0.3.0`. Account-quota observations remain an
  instance-scoped public port outside session events and execution admission.

### Removed

- Remove the standalone provider-session `integrations` observation port. MCP servers and Apps or
  connectors are now reported through the environment integration catalog.
- Remove Agent Protocol V8 parsing and compatibility behavior at the public boundary.

Provider-native adapters, credentials, process management, native identifiers, and private host
or transport protocols remain outside the public package set. Update adapter implementations with
[MIGRATING-TO-0.3.md](MIGRATING-TO-0.3.md) before using this release.

## 0.2.5 - 2026-09-08

This coordinated release preserves Agent Protocol V8 and introduces account-quota snapshot
schema version 1 outside session events.

### Added

- Add the validator-neutral `/account-quota` entrypoint with bounded snapshots, quota windows,
  allowance states, source identity, and original observation timestamps.
- Add instance-scoped quota query and observation ports with caller and instance cancellation,
  validated snapshots, sequential observation, and iterator cleanup.
- Extend fake-provider, conformance, generated-schema, and packed-consumer coverage for quota.

### Changed

- Require `accountQuota` on every materialized provider instance. Providers without support must
  explicitly return `{ kind: "unsupported" }` with no handlers.
- Advance validation, protocol, and runtime packages together to `0.2.5`; the validation API and
  public Agent Protocol V8 event version remain unchanged.

See [MIGRATING-TO-0.2.5.md](MIGRATING-TO-0.2.5.md) before upgrading driver implementations.

## 0.2.4 - 2026-09-05

This coordinated patch release preserves Agent Protocol V8 and advances all three packages
together.

### Changed

- Require every runtime operation invocation to provide a caller-owned `observationTurnId` for
  exact session and turn correlation.
- Require providers to await the optional operation `onOutput` observer for each emitted output,
  preserving host admission backpressure before the operation result settles.

### Fixed

- Validate operation-scoped progress, context, compaction, operation, resource, warning, error,
  and diagnostic observations through the same stateful session authority used by turn output.
- Reject mismatched observation identity, undeclared output, invalid lifecycle transitions, and
  output emitted after operation settlement before it can cross the public runtime boundary.

See [MIGRATING-TO-0.2.4.md](MIGRATING-TO-0.2.4.md) for the required operation-call and adapter
changes.

## 0.2.3 - 2026-09-04

This coordinated beta release is published under both the `beta` and `latest` npm tags.

### Added

- Add closed capability and inventory contracts for selectable configuration, typed operations,
  managed content, managed MCP observations, collaboration lifecycles, generated resources, and
  structured image input.
- Add matching provider-session ports for listing and applying configuration, listing and invoking
  operations, observing managed content and integrations, controlling collaboration, and retrieving
  generated resources.
- Add bounded elicitation fields, richer approval choices, provider source evidence, process
  boundaries, context usage and compaction semantics, and neutral resource/artifact correlation.
- Expand the deterministic fake provider and reusable conformance suite across the V8 surface.

### Changed

- Advance every serialized protocol value from Agent Protocol V7 to V8 as a direct hard cut.
- Replace the former `interactionExtensions` booleans with independently constrained,
  discriminated capability domains and strict capability-to-port validation.
- Preserve stream backpressure through terminal or exactly-one-pending-request boundaries and make
  incomplete turns or request continuations render a validated session unusable.
- Require explicit provider-execution-start observation for mutating operations so hosts can
  distinguish definitive pre-delegation failures from uncertain post-start delivery.

### Fixed

- Commit provider execution start only after the host observer succeeds, preserving durable-journal
  failures as pre-delegation errors without poisoning a reusable session.
- Reject stale revisions, conflicting invocation identities, invalid lifecycle transitions,
  unoffered request choices, and capability/result mismatches before they cross the provider SPI.

### Removed

- Remove Agent Protocol V7 parsing and every compatibility reader, alias, or dual-protocol runtime
  surface.
- Remove the generic boolean interaction-extension catalog and provider-native escape-hatch shape.

See [MIGRATING-TO-0.2.3.md](MIGRATING-TO-0.2.3.md) for the coordinated V7-to-V8 upgrade sequence.

## 0.2.2 - 2026-08-31

This coordinated patch release is published under both the `beta` and `latest` npm tags.

### Fixed

- Reject terminal, regressed, or rebound item and plan subjects before an approval can reach a
  waiting boundary or provider delegation, while preserving prior in-progress evidence across an
  `unknown` status update.
- Reset materialization-scoped context usage at an explicit provider process boundary without
  weakening logical-session monotonicity.
- Accept approval prompts up to the protocol's 4,000-character limit across generated and runtime
  validation surfaces.
- Enforce uniqueness and canonical ordering directly in the exported standalone approval
  capability schema.
- Resume partial coordinated releases only when existing packages carry exact provenance from the
  original immutable release tag or its guarded recovery run.

## 0.2.1 - 2026-08-30

This coordinated patch release is published under both the `beta` and `latest` npm tags.

### Fixed

- Preserve cumulative context counters across later usage samples that omit individual fields, so
  a subsequent regression cannot bypass materialization-scoped monotonicity validation.
- Accept the protocol-safe `unknown` compaction trigger when a provider supports compaction while
  continuing to reject unadvertised known triggers and all compaction from unsupported providers.
- Permit neutral cancellation after an approval request expires while continuing to reject expired
  option selections before provider delegation.

## 0.2.0 - 2026-08-29

This coordinated release is published under both the `beta` and `latest` npm tags.

### Added

- Agent Protocol V7 context-usage events with bounded occupancy, measurement scope, optional
  cumulative counters, and compaction pressure.
- Required neutral details for context-compaction items, including bounded trigger, token,
  duration, and summary-preview facts.
- Item-correlated and proposed-plan-correlated approval requests.
- Typed approval choices with exact decision, persistence, and neutral scope semantics.
- Approval capabilities that advertise exact persistence/scope combinations.
- Stateful runtime validation for context monotonicity and post-compaction occupancy changes.
- Refusal-before-delegation validation for stale, expired, mismatched, and unoffered approval
  resolutions.

### Changed

- All serialized protocol values now require `protocolVersion: 7`.
- Approval resolutions select an offered `optionId` or use the explicit canceled disposition.
- The approval capability is now a supported/unsupported discriminated union rather than a
  boolean.
- `AgentCapabilities` now requires the `context.usage` and `context.compaction` capability object.
- `@agen-ai/validation`, `@agen-ai/agent-protocol`, and `@agen-ai/agent-runtime` advance together
  from `0.1.0` to `0.2.0`.

### Removed

- Agent Protocol V6 parsing and compatibility behavior.
- Boolean approval capability declarations and boolean approval decisions.
- Uncorrelated approval subjects.

See [MIGRATING-TO-0.2.md](MIGRATING-TO-0.2.md) for exact replacement examples and rollout order.

## 0.1.0 - 2026-08-03

- Initial public beta release of the validation, protocol, and runtime package family.

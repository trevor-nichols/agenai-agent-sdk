# MS001 retained native trace analysis

Read-only source analysis on 2026-10-29. Original inputs remain outside the repository at `/Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/`. This analysis changes no Docker resource, production admission, raw observer document or original checkpoint. Current source decoder replay does not establish byte equality between current workspace code and the frozen installed bundle.

## Frozen installed reproduction r3

`reproduction-r3/report.json` records installed public `@agen-ai/sandbox`/`@agen-ai/sandbox-docker` 0.4.7 on native arm64 Node 24.18.0, Engine 29.1.2 / API 1.52 / `6.12.54-linuxkit`, Desktop 4.54.0 build 212467. The analyzer ran locally under Node 24.15.0; this read-only parser run is separate from the original execution tuple.

The repeatable analyzer is `analyze-trace.ts`, with bounded input/hash verification in `trace-input.ts`. Its retained output is `reproduction-r3-compact.analysis.json`. It verifies all **220 capture entries**, **47 original checkpoints**, decodes **28 original VM observation documents**, and replays **14 paired complete Engine network censuses** through the existing source census decoder. VM/member checks call the existing source topology functions; no model snapshot is substituted.

The original capture did not retain `/info` bytes or Darwin host observer stdout. Its proxy selector recognizes `/v1.52/info` while the SDK requests `/info`. For network-schema replay only, the analyzer supplies the report's recorded Engine ID/kernel and an explicit unknown-hostname marker; it does not claim a captured `/info` or host authority observation.

The exact observed cascade is:

| Original evidence | Observed fact |
| --- | --- |
| A empty bridge, `00020`/`00028` VM documents | A owns bridge `ag25ae112ac837f`, index 27, `172.19.0.0/16`, gateway `.1`; no endpoint, carrier 0, operational state 2, TSO 65,536; three IPv4 routes. |
| A endpoint, `00047`/`00055` | Broker adds sole endpoint `.2`, veth index 28. Bridge becomes carrier 1/state 6, TSO 524,280. Both link-local addresses are tentative (`flags=192`). Existing source bridge/broker/VM validators pass. |
| `00057`/`00065`, then `00067`/`00075` | Bridge IPv6 flags settle to 128 first, then veth flags settle to 128. Kernel local/anycast routes appear in two finite steps. The source settling predicate becomes true at the latter pair; `00078`/`00086` repeats the same settled VM graph. |
| A ready checkpoint `a/checkpoint-0021.json`, 22:36:23.690Z | A is running. `00106`/`00114` later repeats healthy sealed authority before B's effects. |
| B observer start, trace 173 | B's host-network observer starts at 22:36:25.360Z and acknowledges at .417Z. B baseline `00127`/`00135` sees both original host members and A's active bridge. This does not prove observer appearance alone was the first change noticed by A. |
| B bridge create, trace 200; `00142`/`00151` | B gains bridge `ag4f0b182564bca`, index 29, `172.20.0.0/16`, gateway `.1`. Its empty shape matches A's initial empty shape under its own identities. |
| B broker start, trace 231 | Entered at 22:36:25.788Z; acknowledgement at .863Z. This overlaps A's next complete authority bracket. |
| A `00165` at .837Z vs `00174` at .864Z | A's first VM read sees B's empty bridge; its second sees B's carrier/TSO transition, new veth index 30, tentative IPv6 addresses and six added/four-net-added routes. The complete VM bracket differs. Assuming the earlier uncaptured socket/host checks passed, the first VM-specific current `capture()` rejection is `Desktop VM authority did not settle within complete acquisition.`, before the later sealed snapshot comparison. A's actual failure callback text is not separately retained, so this is a conditional source-order inference grounded in the unequal raw bracket. |
| A checkpoint `0022`, .884Z; deletes 245/263/272/279 | A enters stopping immediately after that bracket and deletes its compute, broker, filesystem and observer. Its bridge remains retained; veth 28 disappears. |
| B `00192`/`00201`, 22:36:26.207–.233Z | B's own bridge/veth pass source member validation, still with tentative link-local addresses. Its external A projection has changed: A's veth is gone, bridge carrier is 0, running flags changed and prior routes disappeared. The bracket itself is stable, but its external graph differs from B's original baseline. |
| B reported error | Original nested cause is exactly `External VM authority changed during the finite owned link-local transition.` B retains uncertain startup and original cleanup ownership. Its relay remained planned. This is an observed secondary failure after A's infrastructure stop. |

Engine snapshots correlate the same facts: host membership changes from A to A+B, then B; A's bridge endpoint changes from its exact broker to empty; B's exact broker occupies its own network. Only restricted compute appears in the builtin `none` network. The live filesystem helper has `NetworkDisabled:true`, configured mode `none`, **zero actual network attachments**, and no builtin `none` endpoint; the never-started export likewise has zero attachments. A configured mode or identified resource does not itself prove a census member exists.

This run demonstrates initial observer acquisition, empty bridge creation, broker attachment and finite IPv6 settling, an active peer's bracket spanning sibling endpoint activation, peer infrastructure removal, and retained empty networks. It does not demonstrate two successfully active coordinated members, healthy TLS/file/primary survival, explicit private IPAM, denial counters, zero-observer re-entry, lost acknowledgements, or index reuse.

Both original owners reach `destroyed`; their report's final exact census records 404 for all **17 identified resources** plus B's never-created planned relay name. Original-network DELETE acknowledgements are followed by exact ID 404 readbacks. There is no final VM observer after both network deletions, so this record proves exact resource cleanup, not a final complete VM topology observation.

## Frozen installed reproduction r4

`reproduction-r4.analysis.json` separately verifies **285 capture entries**, **47 checkpoints**, **28 raw VM documents**, **14 complete network censuses**, and **four raw pinned Host documents**. Every network census now replays an actual captured `/info`; none requires the earlier metadata fallback. The four Host phases (`before-a`, `a-ready`, `after-b`, `after-cleanup`) all decode to semantic fingerprint `cab7ea54eec7af4fb5086944015103c3fb52bdc6a84a37fa4fca613d5b47de5b`. They are separate phase observations, not complete Host brackets around each VM census.

This run preserves the same structural failure with a different observed timing. A's health pair **`00204-observer.json` / `00217-observer.json`** at 22:47:41.695–.740Z is itself stable, but already contains B's **empty** bridge **index 45**, **`ag1fee1deb8616d`**, `172.20.0.0/16`, carrier 0/state 2/TSO 65,536. B's veth is not present in that pair. Assuming earlier uncaptured per-call socket/Host checks passed, the first VM-specific rejection is now the sealed whole-VM comparison, rather than r3's changing complete-capture bracket. A then stops; B again retains the recorded nested `External VM authority changed during the finite owned link-local transition.` error. A's actual callback cause is still not directly retained, so its exact exception remains a conditional source-order inference.

All sampled Host, Engine and VM ranges have zero overlap with the candidate pool. Both original owners again reach destroyed and all 17 identified resources have final exact 404 observations. The raw r4 Host files close the absence of phase Host evidence from r3, without retroactively adding it to r3 or claiming continuous Host authority. The r3 and r4 records are retained separately; their different first observed topology phases must not be flattened into one invented trace.

## Source-composed IPAM r2: the delayed retained transition

The separate `ipam-r2` attempt is **failed**, and remains failed. `analyze-ipam.ts` verifies all 11 original raw VM/parsed snapshot hash references, re-decodes the raw VM documents, revalidates retained normalized host/Engine facts, and isolates source route rejection. Retained output: `ipam-r2-retained.analysis.json`.

Only A fails, at `b-endpoint-1` (`0297-parsed.json`, raw `0285-vm-raw.json`). B's own member projection passes. A's original bridge index is **34**, name **`ai2e499f0095a`**, subnet **`10.240.0.0/28`**. Between `b-endpoint-0` and `b-endpoint-1`, after A's endpoint was already deleted:

- Bridge flags change **4163 → 4099**, operational state **6 → 2**, carrier stays **0**, TSO stays **524,280** and its settled IPv6 address remains.
- Its IPv4 connected and broadcast route flags change **0 → 16**; the current source permits these exact IPv4 variants.
- Its IPv6 **`fe80::/64`, table 254, protocol 2, type 1, priority 256** and **`ff00::/8`, table 255, protocol 2, type 5, priority 256** flags also change **0 → 16**. These exact two routes trigger `Owned native route exceeds its exact IPAM/link-local projection.` because the current IPv6 branch requires flags 0.
- Gateways, next hops and source remain absent. No foreign route or publicly numbered allocation is needed to explain the failure.

The important domain state is delayed endpoint-free bridge deactivation. The first successful post-remove observation is not yet fixed retained authority. Two repeated early observations can be identical while the kernel has not reached its explicit terminal down state.

`retained.ts` is a research-only mechanism selected for the next experiment:

```ts
captureDesktopRetainedTransition(originalEmptyOwnedBridge, settledWithEndpointVm)
validateDesktopRetainedTransition(context, currentVm)
// => { kind: 'settling' | 'settled', devices, fingerprint }
captureDesktopRetainedState(context, currentVm)
validateDesktopRetainedState(fixedState, currentVm)
```

Capture the transition context before removing the endpoint or replacing the original empty bridge receipt. The source validator first proves that the original endpoint graph was settled. Current observations are compared directly with finite exact alternatives; they are not sanitized into the old validator. Permitted changes are the original bridge's known deactivation flags/state/carrier, its original TSO value or restoration to its original empty value, and flags 0→16 only on its exact original connected/broadcast/link-local connected/multicast kernel routes. Other route fields, full native identity/attributes and settled addresses remain exact. Unknown flags, gateway/route/address changes, old bridge-index replacement and remaining children reject.

Only terminal down state 2/flags 4099/carrier 0 plus all exact linkdown route alternatives yields `settled`. The caller must obtain two matching **settled** fingerprints within its existing deadline before freezing fixed retained authority. The original r2 samples classify A's first three retained observations as `settling` and only its final observation as `settled`; r2 supplies no second terminal-down sample. TSO restoration to 65,536 is an admitted exact research alternative tested synthetically; it did not occur in these r2 samples.

The removal-transition context rejects the retiring endpoint index until it settles. Fixed retained state owns only the exact retained bridge and its routes. It releases the removed endpoint index so a separately validated registered member can reuse it. The owner-boundary test table covers this separation; the natural native run did not force or prove index reuse.

## Final IPAM r5 qualification of this research mechanism

Root's final `ms001/ipam-r5/report.json` is **passed**, with SHA-256 `95479a73fdbbaa223cbcf743d18f76e6829d32300543925301c5c5d23a70f1cb`. Its **26 full brackets** include 25 validated observations and one intended unregistered-network rejection. The read-only reviewer verified 131 original reference hashes/byte counts, decoded all 52 raw VM and 52 raw Host documents, reran the finite member and unchanged external projection on both sides, and verified 55 terminal native exec receipts. All 130 effects acknowledged; no original record was changed by assessment.

The retained mechanism now has actual native terminal-state evidence for both members: A and B each provide two early `settling` samples followed by two matching explicit `settled` samples before freezing. Both retained TSO values stay 524,280; 65,536 restoration remains a tested synthetic alternative. A's fixed retained bridge survives zero-observer removal/replacement and B's later complete lifecycle. Subnet `.0/28` is reused by C only after original A/B network removal, with a new ID. No forced native interface-index reuse is claimed.

An unregistered `.32/28` control copies B's exact labels but has its own original ID. The full negative bracket rejects it; no further member topology dispatch occurs before exact control deletion and complete baseline restoration. This closes the sampled lookalike-label/extra-private-network transition case without broad topology subtraction. All eight original resources are removed; 16 final original name/ID inspections return 404 and the final Engine projection equals the initial external baseline.

The frozen source manifest (`ms001/ipam-r5-source/manifest.json`, SHA-256 `05ec9b14ee2506657b3c424f70aef88bd9fb9eb1966a5711a70c9e3e43c89b3b`) retains 1,081 selected files / 7,312,752 bytes, independently hash-verified as saved copies. Root also verified selected live source before/after execution. These exact source-composed bytes remain separate from the frozen installed 0.4.7 reproduction and later public-package qualification.

The largest reported bracket elapsed was **513.496959 ms**, among the 26 samples, below the configured 10,000-ms bound with 5,000-ms commands and unchanged 60,000-ms supplied leases. The measurement covers the captured/validated bracket before its final report write. It demonstrates this exact deadline-feasibility run, not durable journal timing, performance, saturation fairness, active helper-heartbeat/tunnel survival or fleet admission. No executable changed or extra test/Docker run occurred for this final assessment; the prior 14-test/type/lint/syntax results remain applicable. Full ownership/fault/lifecycle acceptance stays with later implementation milestones.

## Fixed private pool assessment

Frozen reproduction r3's captured Engine ranges are `172.17.0.0/16`, `172.18.0.0/16`, A's `172.19.0.0/16` and B's `172.20.0.0/16`. The decoded VM addresses, non-default route networks and gateways also include loopback and `192.168.65.0/24`; **none overlaps any of the sixteen `/28` candidates inside `10.240.0.0/24`**. The r3 host allocation census is unavailable.

As separate supplemental evidence, all eleven IPAM r2 host documents decode successfully and have no overlap with any candidate. That attempt requested `.0/28` and `.16/28`. This supports pool feasibility on those sampled host/Engine/VM facts; it is not a host bracket for r3, a continuous allocation lock, installed immutable broker denial, or a full IPAM pass. Final exact-name/ID absence in the failed r2 is independently hash-verified by the analyzer.

## Reproduction commands and verification

From `/Volumes/AGENAI/Coding/Production/agenai`:

```sh
pnpm exec tsx scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/analyze-trace.ts /Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/reproduction-r3 scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/reproduction-r3-compact.analysis.json
pnpm exec tsx scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/analyze-trace.ts /Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/reproduction-r4 scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/reproduction-r4.analysis.json
pnpm exec tsx scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/analyze-ipam.ts /Volumes/AGENAI/Qualification/sdk-concurrency/EP-20261029-001/ms001/ipam-r2 scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/ipam-r2-retained.analysis.json
pnpm exec tsx --test scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/*.test.ts
pnpm exec tsc --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/*.ts
pnpm exec eslint --no-ignore scripts/development/agent-sandbox-qualification/platform/research/desktop-concurrency/transitions/*.ts
```

Analyzer output uses exclusive creation; choose a new analysis filename when repeating it. Both analyzers refuse mutation and use no Engine transport. Initial inspection-only attempts exposed an undefined fingerprint comparison and a CJS-only eval loader mismatch; the retained scripts run as ESM and the corrected typed analyzers pass. Current verification: **14 tests pass**, strict ES2024 TypeScript and explicit ESLint pass; root script and documentation checks pass. Native G06–G09 campaigns, live broker denial and lifecycle settlement remain separate root-owned work.

# Installed native catalog qualification

This opt-in command checks Grok 1.0.70 catalog discovery through the installed
public sandbox SDK and an explicitly rebuilt restricted-HTTPS helper. It creates
a disposable native process and profile using the caller's existing access-only
account credentials. It never creates a session or model Task.

The recorded candidate is unpublished `0.4.11`. Passing this command does not
publish packages, update an application, or qualify the pinned 1.0.62 execution
recipe for a newer native version. Catalog refresh and Grok 4.7 availability are
separate report fields.

## Inputs and invocation

Use the exact installed consumer, package archives, helper image and native
workload selected for qualification. Prepare the platform and restricted-HTTPS
capability manifests using the existing platform runner conventions. This
command builds or pulls no image and changes no Docker Desktop setting.

```sh
node scripts/development/agent-sandbox-qualification/capabilities/catalog/run.mjs \
  --manifest /absolute/private/catalog-manifest.json \
  --consumer /absolute/installed-consumer \
  --output /fresh/short/physical/output
```

The closed `agenai.native-catalog-manifest.v1` input contains:

- `platform` and `network`: physical manifest paths and their exact SHA-256 hashes.
- `workload`: the reviewed native ARM64 image, non-root user, CPU/memory/process
  limits and temporary-storage capacity.
- `native` and `bootstrap`: the reviewed absolute guest executables, byte lengths
  and SHA-256 identities; `native` also declares version `1.0.70`.
- `helperBaseImage`: the immutable base used to prepare the running helper.
- `installedIdentitySha256`: the SHA-256 of the existing `installedIdentity`
  function's JSON result for the selected consumer.
- `credentialSource`: exactly `selected_existing_account`.

`configuration.mjs` owns the admitted identities and bounds. The command checks
current Engine/platform/image facts and installed package identities before
native startup. The output directory must not exist, must use a physical path,
and must be short enough for a Unix socket. Keep it private: exact original
recovery records and local resource identities remain there.

Credential selection is `GROK_AUTH_PATH`, otherwise `GROK_HOME/auth.json`, otherwise
the current user's `.grok/auth.json`. A stable private-file read admits only the
first-party access record, strips refresh material and unknown fields, and rejects
expired or imminently expiring access. The public SDK delivers the projected file
over its private credential-bootstrap stdin. No credential travels in argv,
environment variables, host mounts or public evidence. Account readback is
compared privately inside the guest.

## Acceptance and ownership

One guest reader sends `initialize`, optional advertised `authenticate` with
`cached_token`, `_x.ai/auth/info`, and `_x.ai/models/list`. There are at most four
requests within the same 45-second observation budget. Native requests for tools
or files are not granted. Raw debug output stays inside the disposable guest;
only bounded known event forms, catalog fields and closed failure codes leave it.

A non-empty catalog is insufficient. Acceptance requires source-associated HTTP
fetch completion for `https://cli-chat-proxy.grok.com/v1/models`, positive usable
model prefetch, and catalog readback after those observations. Cached-manager
success, fallback, missing provenance or exceeded bounds cannot pass. The guest
joins the native process and drains its diagnostic file before marking catalog
observation complete. A contradictory refresh between the list request and that
final drain invalidates the result, including delayed diagnostic writes. Raw
HTTP counts need not equal filtered picker counts.

The original sandbox owner stops and destroys its resources, joins entered work
and the sole output reader, then verifies exact resource absence and independent
daemon process-scope emptiness. A cleanup timeout retains that original owner and
its support resources. Its report identifies the original PID and `SIGUSR2`
cleanup-retry signal; preserve that process and its records until cleanup settles.

`catalog-report.json` records discovery, configured inputs and cleanup separately.
`guest` contains the bounded native result; `configuration` is the approved
projection without host paths or account identity. The publication verifier
consumes a reviewed projection under `qualification/native-catalog/`, bound to
exact archives, package payloads, helper/native identities and current harness
bytes. The command does not generate or approve publication evidence itself.

## Hermetic checks

Catalog host and guest tests are included in the monorepo
`test:agent-sdk-sandbox-capabilities-tooling` aggregate and the exported
`test:sandbox-platform:tooling` aggregate. Scripted peers test classification,
bounds and ownership; they cannot supply native publication evidence. Ordinary
CI needs no account or live Docker workload for these tests.

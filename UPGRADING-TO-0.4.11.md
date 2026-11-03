# Upgrading to 0.4.11

The coordinated ten-package `0.4.11` release is published under npm `latest` and `beta`.
Original archives, exact native applicability, provenance, registry consumers, installed files,
offline helpers, signatures and stable tags passed verification. Install the coordinated family
together. Application adoption and its actual helper/account checks remain separate actions.

The correction accepts one bounded printable CONNECT `User-Agent` field as inert metadata.
The exact destination and matching Host still determine admission. Duplicate, blank, credential,
framing and unsupported fields remain rejected under the existing 8,192-byte header limit.
Agent Protocol V13, sandbox recovery v3, backend identities and the egress helper protocol are unchanged.

## Select the release and preserve existing owners

Retain the governed export's `.agenai-export.json`, its dependency lock and the complete coordinated
archive set. The [native record](qualification/native-catalog/0.4.11.json) identifies the original
archives used by the native campaign; the [reviewed repack](qualification/native-catalog/0.4.11-repack.json)
identifies the final checked archives and any exact qualified manifest bytes used for comparison.
Those are different archive identities. A version string alone does not establish applicability.

Install the selected coordinated package family together in a fresh consumer and retain its lockfile.
Do not copy a Linux `node_modules` directory to macOS. Keep the original package installation,
helper images, controller configuration, route authority and complete SDK-returned records for
every existing or incompletely cleaned owner. Finish its cleanup through its original owner;
never translate records, overwrite pinned helpers or replay effects with the new candidate.

## Rebuild and select the egress helper

Updating the host package alone leaves an existing broker image's parser unchanged. From the
installed candidate, call `prepareDockerSandboxEgressHelpers` from
`@agen-ai/sandbox-docker/node` with a fresh physical directory, an explicitly selected immutable
Node base image and the intended non-root UID/GID. Preparation writes a build context and its
source manifest; it does not pull, build or modify Docker.

Follow the [helper preparation/build recipe](packages/sandbox-docker/README.md#restricted-https-egress).
Build a distinct image explicitly with network access disabled and no implicit pull. Retain the
base image, generated manifest, source digest and resulting immutable image ID. Inspect its
architecture, user and source/protocol labels and compare the actual nine shipped runtime files
with the preparation manifest before selecting it. The qualified helper source digest is
`sha256:734b16f0b2932a432e54c43d69f16fcabb210eaa533df44eedf601886ad24cc5`.

Select that verified image ID only for newly owned resources using the matching platform and
route-authority configuration. Preserve borrowed old images and existing cleanup ownership.
A different image/platform/configuration is a new composition requiring its affected checks;
the recorded native image ID is evidence, not a portable image download or automatic upgrade.

## Qualification and consumer acceptance

The [catalog handoff](examples/sandbox/HANDOFF.md#connect-and-native-catalog-candidate-2026-11-03)
records the exact native-arm64 Desktop/Grok 1.0.70 tuple. The installed helper accepted the
unchanged captured request, verified TLS, retained denial/isolation checks and completed cleanup.
Native remote refresh then advertised `grok-4.7` and `grok-4.7-build-fast`, each with a 256,000-token
context and low/medium/high/xhigh reasoning (high default). It created no model session or Task.

This establishes catalog transport and observed availability for the selected existing access-only
account route. It does not qualify all Grok 1.0.70 execution features, inference, billing, other
accounts or a production consumer. The existing task recipe remains pinned to 1.0.62. Access-only
credentials carry no login or refresh authority; expired access is a prerequisite to resolve separately.

After separately authorized adoption, require fresh no-Task discovery through the consumer's actual
selected helper and account, with positive remote-fetch/prefetch observations, Grok 4.7 advertised
and complete original-owner cleanup. A non-empty fallback list or CONNECT 200 alone cannot pass.
If Grok 4.7 is absent or unproven, keep the consumer blocked; do not substitute another model.
The bounded qualification runner's [input and observation contract](scripts/development/agent-sandbox-qualification/capabilities/catalog/README.md)
describes the recorded composition. The consumer's later model Task campaign remains separate.

The native Linux standalone `pnpm check` and separate installed sandbox-platform profile passed.
They cover package assembly, executable examples, units and packed native-history fixtures; they
do not constitute a second authenticated catalog campaign or a new Linux Docker network campaign.
Use [RELEASING.md](RELEASING.md#native-catalog-admission) for final archive admission. A fresh pack
with different hashes must receive its own reviewed comparison before publication.

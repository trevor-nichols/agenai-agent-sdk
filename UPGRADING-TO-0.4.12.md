# Upgrading to 0.4.12

`0.4.12` is a coordinated ten-package patch for the Docker Desktop coordinator in
`@agen-ai/sandbox-docker`. Install the complete package family together. Agent Protocol V13,
neutral sandbox recovery v3, the coordinator journal format, public types and existing backend
identities are unchanged.

## Resource Saver can stay on

Docker Desktop's default Resource Saver stops the VM while no container runs and answers some
read-only Engine requests from a cache. Before this release, the coordinator took its external
topology baseline from that cache at `activate()`, so the first member after an idle period could
fail with `External Desktop Engine topology changed.` Applications had to turn Resource Saver off
or wake the VM themselves.

The coordinator now takes its baseline from the first member observation backed by a running
route observer, after the VM's IPv6 addresses have settled. While any member is registered, every
later observation must still match that baseline exactly. While no member is registered, the
health check reads only host authority and the Engine identity seen at `activate()`, so a
long-lived coordinator can stay open across idle periods. Remove any application-side Resource
Saver refusal, VM wake step or retry that existed only to work around the old baseline. The
[Docker package README](packages/sandbox-docker/README.md#concurrent-desktop-members) describes
the exact rules, including how an Engine restart fences registered members.

## Cleanup after an Engine restart

A restarted Engine reports a stopped container's unset DNS lists as `[]` where creation reported
`null`. That changed the container's ownership fingerprint, so cleanup refused the container and
left its storage volume in place. Fingerprints now record an empty DNS list as unset. Fingerprints
persisted by `0.4.11` still match, so `0.4.12` cleans up resources that `0.4.11` created through
their original owners; any configured DNS server, option or search domain still changes the
fingerprint.

## Helpers and qualification

No egress, coordinator or recovery helper source changed. Applications already running the
`0.4.11` helper keep it; applications upgrading from an earlier release still follow the
[0.4.11 helper rebuild steps](UPGRADING-TO-0.4.11.md#rebuild-and-select-the-egress-helper).

The coordinator change qualified natively on Apple silicon with Docker Desktop 4.98.0 (build
245422), Engine 29.9.2 and Resource Saver on: single, joint, idle re-entry, foreign-network and
Engine-restart rows, plus the existing warm rows, passed against a packed candidate of this source
before its version change, with every member destroyed and every coordinator closed clean. The
Grok 1.0.70 catalog observation recorded for `0.4.11` was not repeated.

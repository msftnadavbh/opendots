# OpenDots Azure pilot — operator runbook

**Pilot only. No production target, automatic upgrades, resource deletion or cleanup command.**
**Current status: cloud HOLD; not activated, not Azure Validated, and not live-complete.**
SSH is closed. Managed transport, its live privacy canary, the one-off image/unit recovery,
and the integrated application backup API/HTTPS client must pass their gates before activation.
Live privacy inspection and Azure validation remain lead-owned. Local tests do not establish
cloud readiness. This runbook is not authorization for cloud operations.

**Cloud hold:** the VM was deallocated under governance controls. Establish the permitted
test/running window before resuming; do not change tags/schedules or run a restart loop.
Local preparation is permitted; this document is not an authorization to bypass the cloud hold.

The recorded drift includes a governance-created default-deny NSG attached to the application
subnet; the NIC's 80/443 permit does not override it. The data disk's ownership tags are absent,
so inventory validation refuses it even if its immutable ID and attachment match.
Do not restore tags, adopt/detach/alter the added NSG, or redeploy to erase this drift.
Current state must be revalidated under separate authorization before activation.

## Fixed boundary and trust model

The tenant, subscription, deployment principal, resource identities, region, registry, and
endpoints are fixed in [`scope.mjs`](scope.mjs). This operator is not parameterized for other
accounts or deployments. Preserve those source pins; changing them is not a supported setup step.
Preserve the existing Intelligence project key and owner/thread IDs.

The pinned VM uses Standard_D2als_v7 and Ubuntu 24.04 Gen2 version 24.04.202610160.
Its data disk is 32 GiB StandardSSD, NVMe LUN0, ext4. The model deployment is
`dot-chat` (gpt-5.4-mini 2026-03-17, GlobalStandard 50).

The VM fallback is selected because Azure Policy enforces Entra-only Foundry access
and stable Sandboxes have no established managed-identity path. The existing empty
`sbx-opendots-pilot` and its group-scoped Data Owner assignment are retained.
Sandbox activation commands are retired; no model keys are fetched. The application remains
Node 24/CopilotKit. Python is only for the Ubuntu host's standard-library management/disk utilities,
not an application/runtime migration.

“Private” means **single-owner authenticated access on a public HTTPS listener**, not private-network ingress.
Caddy exposes 443 and 80 (ACME/HTTPS redirection). **SSH is closed, including the historical operator `/32`.**
The exact NSG contract is `https-and-acme` (priority100, Allow Internet TCP80/443) and
`deny-other-inbound` (priority4096, Deny all). Do not restore port22, use an alternate
port, JIT, reverse SSH, tunnels or a policy exception. A further NSG/governance change is a stop condition.
The app is published only at host loopback `127.0.0.1:4310`. Docker 28+ is required at installation
and every service start. Caddy access and HTTP-error log namespaces are excluded; TLS and other
non-request operational diagnostics remain available. Never enable request/debug logging with real credentials.

The VM's system-assigned identity gets **Cognitive Services OpenAI User only on this Foundry account**.
Runtime auth is explicitly `managed-identity`, using a renewing token provider for
`https://ai.azure.com/.default`. Tokens are never configuration values. The host identity is a trust boundary:
do not run browser sidecars, untrusted computers or unrelated workloads on this VM.

## Preserve state and validate locally

Use Node 24 for app checks; the operator supports Node 22.23+. Azure CLI, local Bicep,
and Docker are needed for the corresponding validation/build work. SSH is not used by the active operator.
Keep the operator clock synchronized (NTP).
The disk-time sanity check allows ten minutes of skew; it never substitutes for prior absence,
ownership and immutable identity checks.

1. Preserve ignored `.env` and `.env.pilot` if present, owned by the operator and mode **0600**; never print them.
2. Preserve existing `vm-state.json`, ARM outputs, public SSH parameters and their original hash unchanged.
   Keep the dedicated keys and host pin as historical recovery material. The `/32` parameter is compatibility
   state, **not** an ingress allowance. `prepare` now fails closed rather than generating keys or rebinding state.
3. Do not clear the old image pin, format permit/intent, filesystem UUID, identity or resource pins.

Compile and execute the mandatory operator/ARM contract, then the mocked disk tests:

```sh
set -eu
mkdir -p -m 700 /tmp/opencode
"$HOME/.azure/bin/bicep" build infra/main.bicep --outfile /tmp/opencode/opendots-pilot-arm.json
PILOT_ARM_TEMPLATE=/tmp/opencode/opendots-pilot-arm.json npm --prefix deployment/azure test
python3 -m unittest discover -s deployment/azure/test -p '*_test.py'
```

Do not omit `PILOT_ARM_TEMPLATE`: the compiled contract intentionally fails without it. It checks
the full pilot graph, including account-scoped roles, Entra-only auth, the retained Sandbox,
NVMe/disk retention, exactly two NSG rules with no SSH allowance, historical public parameters,
no unexpected resources, and no production imports. Managed Run Command is deliberately **not** an ARM
deployment resource: protected inputs must never enter deployment history.
Disk tests mock all device commands; they never format a host device.

Run full app tests, typecheck, lint, formatting and build in Node24 with the real `.env` masked.
Backup pressure/process-death tests must run serially in a disposable container with
`--tmpfs /tmp:rw,noexec,nosuid,size=64m --env OPENDOTS_BACKUP_TEST_SANDBOX=1`, never on
the operator host. Ordinary host tests skip those stress cases; CI has a mandatory isolated
step. Require all backup tests with zero skips in the explicit sandbox, plus the full
integrated suite. A wrong opted-in profile fails before any pressure allocation.
Verify the actual image with the exact nonroot/read-only/capability/resource flags in `vm-host.sh`.
The local environment may require the integrity-checked offline npm cache; never disable TLS verification.
Only after local evidence and independent review, follow **azure-validate**:

```sh
node deployment/azure/pilot.mjs validate
node deployment/azure/pilot.mjs what-if
```

Review private `artifacts/azure-pilot/{validate,what-if}.json`. Require provider validation success,
only the approved RG, no deletions/replacements or unexpected changes. Inherited policies are read
through ARM's explicit `atScope()` query; the CLI listing omitted them in this tenant.
Azure still enforces custom policies. Never create an exemption or change policy to make deployment pass.

## Managed Run Command and the mandatory privacy gate

The only active guest transport is the retained child
`vm-opendots-pilot/runCommands/opendots-pilot-management-v1`, tagged with the pilot ownership,
transport version/hash and operation ID. It is reused, never deleted. The closed inventory adds only this
tracked child and the exact `Microsoft.CPlat.Core/RunCommandHandlerLinux` handler on this VM.
The historical action `RunCommandLinux` allowance is retained, but the operator no longer invokes it.
An untracked child, different source/operation, wrong handler/publisher/version or foreign resource stops work.

The logged-in Azure **user** is rechecked against the fixed tenant/subscription/principal. PUT/GET use only
the fixed ARM HTTPS origin/path and stable API `2026-04-01`; redirects and debug logging are prohibited.
The local request body stays in memory, not CLI arguments or ARM deployments. Linux input is a single **named**
protected environment parameter, popped by the wrapper before a scrubbed child receives its bytes on stdin.
Input is limited to64KiB. Output is only a fixed bounded receipt (under3KiB), never logs, credentials or files.
Raw stderr/HTTP errors are suppressed; exit status is preserved. There is no output blob, chunking or network-data stream.

The existing local operator lock and guest `rootCommand` flock/deadlines remain in use. An fsynced local
operation intent precedes PUT; a source/identity-checked completion receipt precedes reuse. A lost response,
abort or timeout after HTTP invocation leaves `management.pending`. Even a synchronous fetch failure or HTTP4xx
does not prove nondispatch. Only a private, typed proof from the real client **before invoking fetch**, or an observed
abort before calling that client, permits a durable local restoration of prior management without resubmission.
An abort before intent/invalidation leaves prior state unchanged. Once a new canary's invalidation is durable,
restoration never resurrects the old candidate/privacy approval. A failed restoration save poisons the transport:
reload persistent state. After a crash, old/missing remote state is **not** proof of nondispatch.

Inventory permits exactly the pending public contract or its durable prior receipt's public contract, selected by
operation ID, with full source/tags/timeout/ownership/binding checks. This keeps read-only status/HTTPS-backup
preflight reachable when a PUT did not land. `management-reconcile` performs bounded GET polling only: it may wait
for an exact prior resource with its unchanged completion, pending public source with that exact prior instanceView,
or a valid pending nonterminal view. Only the **pending** operation's validated completion clears pending state.
Mixed/foreign contracts, changed prior completion, unknown IDs and malformed terminal output fail closed; no PUT retry.

For a requested budget of T whole seconds, the wrapper has T−30 seconds of execution, the provider T−15, and the
client T. This reserves15 seconds beyond execution for the bounded10-second reap/reporting, plus15 seconds for polling.
Standard caller budgets additionally cover the root's30-second lock wait,10-second kill grace and
10-second launch allowance. Import cleanup has a separate520-second outer budget for its bounded
240-second reconciliation followed by260-second cleanup; no unknown operation is retried or cleared.
Budgets below31 seconds are rejected; the1320-second cap and existing root-command timeouts are unchanged.
Both canary children share one execution deadline. Slow authentication/provider scheduling can still exhaust the
client budget; that is an unknown outcome to reconcile, not evidence that the guest stopped.

**Retention decision:** encrypted protected settings/input and platform/agent history may remain on the retained child
or guest and are within the privileged control-plane/guest-admin trust boundary. There is **no mandatory clearing PUT**:
it would add another uncertain execution and cannot erase history. This is not a secure-erasure guarantee. Restrict
privileged access; unexpected plaintext persistence/telemetry blocks release. ACR token revocation/password cleanup
remains mandatory and unchanged.

**Lead-only live gate, after separate authorization and independent review:**

```sh
node deployment/azure/pilot.mjs management-canary
```

This sends only the nonsecret marker `opendots-privacy-canary-v1:<operationId>\n` through the protected-input
path. A **direct Python child** checks stdin and its environment before a separate `rootCommand('true')` lock test;
sudo cannot mask a wrapper-child environment leak. Both must succeed before recording the candidate.
Removing a variable from Python's environment does **not** erase the parent's original environment/memory or prove
erasure from `/proc`; transient root-readable parent/process memory is an explicit trusted boundary, not a privacy claim.
It does **not** approve privacy. Before reusing the child for any read-only inspection probe, privately inspect
its GET **with and without** instanceView. Then inspect Activity Log, agent settings/logs, scripts, stdout and
stderr, plus available process/security telemetry, for **both** the marker and its base64 encoding. Document which
process/telemetry surfaces are available and their retention; do not infer erasure from a successful child check.
Root-only encrypted protected settings and intended transient root-readable process input are acceptable;
unexpected plaintext records/leaks are not. Do not print raw surfaces into operator logs/chat.
The narrow CLI exposes no arbitrary guest shell or log download. Lead-owned, separately reviewed nonsecret
inspection probes can reuse `managedTransport`, `rootCommand` and fixed result schemas under the same local lock;
reconcile their receipts before recording proof. Automatic agent/log scanning is not implemented here.
If the exact handler ID/version cannot be verified, or safe inspection needs a different boundary, stop and
consult the lead/architect; do not widen the allowlist or invent a fallback.

Create an owner-only0600 JSON proof **only after those real inspections**, with these exact fields:

```json
{
  "version": 1,
  "canaryOperationId": "<candidate operationId>",
  "vmUniqueId": "<candidate vmUniqueId>",
  "transportSha256": "<candidate transportSha256>",
  "handler": "<copy the candidate handler OBJECT, not this placeholder string>",
  "evidenceSha256": "<SHA256 of the lead's private inspection report>",
  "validatedAt": "<actual UTC inspection timestamp>",
  "checks": {
    "get": true,
    "expandedGet": true,
    "activityLog": true,
    "agentSettings": true,
    "agentLogs": true,
    "scripts": true,
    "stdout": true,
    "stderr": true,
    "processTelemetry": true
  },
  "plaintextLeaks": false
}
```

The placeholder is intentionally not valid proof. Do not infer these booleans from local tests or the
canary's exit code. `handler` contains exactly the candidate's `id`, `publisher`, `type`, `configuredVersion`
and running `version`. Record it with:

```sh
node deployment/azure/pilot.mjs management-record-canary <private-proof.json>
```

Protected operations fail closed until this record exists and matches the exact VM, handler and current
transport source hash. A handler/source change requires a new inspected canary; a new canary invalidates old proof.

Documentation evidence: Context7's Azure catalog returned no managed-Run-Command match. Microsoft Learn
[Linux managed Run Command](https://learn.microsoft.com/azure/virtual-machines/linux/run-command-managed)
confirms Ubuntu24.04 support, Guest Agent minimum2.4.0.2, named Linux parameters as environment variables,
unnamed parameters as argv (forbidden here), and the4KiB platform output limit. The current
[Create/Update REST contract](https://learn.microsoft.com/rest/api/compute/virtual-machine-run-commands/create-or-update?view=rest-compute-2026-04-01)
documents the exact child PUT and execution/instanceView contract. Microsoft's
[handler source](https://github.com/Azure/run-command-handler-linux) and
[extension publisher/type documentation](https://learn.microsoft.com/azure/azure-arc/servers/security-extensions#allow-lists-and-block-lists)
identify the managed handler family; the actual installed VM handler/version still requires live evidence.

## One-off initial image/unit recovery (version1)

The original image digest `ea4668cc47fd6e22a8cbd5a80ca42742aa8890b4a44fac3db304562a0541f978` was pinned
before provisioning failed. The guest unit already references it, but the lead last observed no application
image/container/runtime configuration/database, `provisioned=false`, `configured=false` and no pending pull.
These observations are **not** reusable eligibility proof. The integrated backup API/HTTPS client
requires a separately reviewed image; local source alone does not establish a built or published image.

Do not retry old-image activation or weaken `vm.mjs`'s digest guard / `installFile`'s immutable leaf check.
The only exception is `initial-activation.{mjs,py}`, version1, from that exact old digest and the frozen old
unit SHA256 `2813973ad9b447ebbd89e31354a7a85053eacf94808c83e84f648e98e89a73d3`.

1. After the next scoped application/backup work, independently review the new image digest. Use the pure,
   local `initialActivationTarget(newImage)` export to render old/new units and hashes for review; it performs no I/O
   beyond checked-in source imports. The unit may differ **only by that digest**. Keep the old unit/hash frozen.
2. Create a private0600 approval JSON with exactly `version:1`, `oldImage`, `newImage`, `oldUnitSha256`,
   `newUnitSha256` from that reviewed target and `reviewSha256` (hash of the independent review record).
   Do not copy `oldUnit`/`newUnit` text into the approval JSON. A test fixture's review hash is not approval.
3. Ensure no pending management/pull. Reconcile an interrupted operation first and verify the token disabled
   **and password/certificate-free**. Do not delete an image, stopped container, data, configuration or history to create eligibility.
4. After privacy proof is recorded, the lead may invoke:

   ```sh
   node deployment/azure/pilot.mjs recover-initial-image <private-reviewed-target.json>
   ```

The procedure takes both locks and freshly verifies the exact live VM/disk/UUID. It requires a pristine
Docker image/container inventory (including stopped containers; unidentifiable leftovers also block), no data
except an empty `lost+found`, no runtime.env/database, no active/enabled unit, activation history or job, and
unchanged immutable helpers. Inspection failures are **not** absence. The guest reads and validates its journal
**before** eligibility checks. Confirmed activation/configuration/data/image before a guest intent or mutation can
create a permanent pre-activation tombstone. Once a transaction is prepared/applied, the same observations are
**post-intent conflicts**, not a reason to overwrite its phase or forget that the unit may already have changed.

It verifies the root-owned regular0644 old unit, exact bytes/hash, effective systemd commands and no unexpected
drop-ins. It preserves a verified0600 old-unit backup under root0700 `/etc/opendots/initial-activation-v1/`, never
under app-owned data. Durable local/guest intent binds old/new digests and unit hashes, immutable resource/SSH/FS
state and operation ID **before** the atomic unit replacement. The file and directory are fsynced, post-bytes
checked, and systemd reloaded without start/enable. A durable guest applied receipt then a durable local applied
record precede the atomic **image-pin + recovery-metadata only** update. No helper, data, resource, identity,
SSH, filesystem or format pin is changed. The old backup/intent/receipt is retained.

On interruption: retain every record; subject to the cloud hold, reconcile pending management before considering
the **same reviewed target**. Prepared+old-unit and prepared+new-unit states are explicitly reconciled only when all
gates remain satisfied; applied+new-unit verifies its applied receipt without rewriting. New unit bytes alone never
authorize image-pin advancement. Checks also run after guest applied-receipt publication and before local pin commit.

The guest's root-private `conflict.json` contains the full bound intent plus `status: post-intent-conflict`. Locally,
`initialActivationRecovery.conflict` contains the bound operation ID/unit hashes/status, **without replacing** the
transaction phase or an existing applied receipt. Mixed tombstone/journal facts, uncertain unit mutation and post-intent
activation/data preserve every journal/backup/unit/image-pin fact and prohibit automatic continuation. Deleting the
activity/data observation does not clear the conflict. There is no retry/force/clear/rollback command for this state;
stop for lead/architect reconciliation. Failed local saves poison that state object; reload the durable state, never
continue from stale in-memory pins. A new unit without the exact intent, an applied receipt with the old unit, drift
or missing evidence is not permission to adopt, roll back or erase evidence.
Never clear the pin, roll back blindly or delete an eligibility observation. A failed/unknown provider execution
without a valid wrapper receipt stays pending and requires lead/architect reconciliation, not an automatic retry.

## Deploy and activate — only after all current gates

```sh
# Lead-only; do not redeploy existing resources merely to repair SSH.
# validate/what-if/deploy/build are separate reviewed cloud operations, not local verification.
# Read the nonsecret immutable image reference from artifacts/azure-pilot/image.json.
node deployment/azure/pilot.mjs provision artifacts/azure-pilot/arm-outputs.json <exact-registry/repository@sha256:digest>
node deployment/azure/pilot.mjs configure
node deployment/azure/pilot.mjs status
```

`deploy` records a successful absent-resource inventory before ARM writes. Subsequent runs check
existing VM identity/principal, OS/data disk identities, network/SSH policy and pinned endpoints
**before** an ARM update. Missing, replaced, foreign or untracked resources are never silently adopted/recreated.
The Foundry project depends on model creation to avoid concurrent child-write conflicts.

`provision` uses only the named managed child after the privacy/recovery gates. Historical keys/pins stay
unchanged and are not used or refreshed. Host scripts and units remain immutable checked content. Bootstrap waits for cloud-init,
uses bounded apt lock waits and signed repositories with fingerprint-pinned Docker/Caddy keys.
Publisher rotation requires independently verifying and reviewing a new pin, not bypassing it.
The installer explicitly repairs nonsecret installation directories to0755 despite the private umask,
rejecting symlinks, unsafe ownership/writability and existing file content/mode drift. It never relaxes
runtime-secret or data-directory permissions. Verify the `caddy` user can read its Caddyfile after recovery.

Formatting requires a tracked new disk, exact ARM attachment and the packaged Azure NVMe mapping
`/dev/disk/azure/data/by-lun/0`, plus matching `azure-nvme-id`, udev, size and root-ancestry checks.
Any signatures, partitions, other mounts or holders block a first format. A durable exclusive intent
precedes the one permitted `mkfs`; interrupted formatting cannot trigger a second speculative format.
A completed filesystem can recover from intent only with its matching UUID and read-only fsck.

Systemd owns the foreground container, requires the UUID mount and rechecks it before startup.
There is no Docker restart policy to bypass that gate. The container runs UID1000, dropped capabilities,
no-new-privileges, read-only root, bounded tmpfs/resources and no Docker socket.
Same-UID app files are not tamper-proof; configuration/backup work runs inside that restricted
container, never as host root beneath the app-owned disk tree.

Image pull uses only the approved repository-read token, explicit **55-minute password expiry**, stdin
delivery and a temporary root-only Docker credential directory under `/run`. Remote cleanup is verified;
the outer `finally` disables the token and deletes its passwords even if pull/cleanup fails. There is
no registry admin access or persistent AcrPull grant. The digest-pinned image stays local for offline restart.

`configure` copies only allowlisted owner/Intelligence settings through gated named protected input to the
existing UID1000 stdin configuration helper and atomic0600 file; no host-root write beneath app-owned data.
The model endpoint and HTTPS origin must match owned live outputs. Existing owner ID/token/project key
cannot silently change. `.env.pilot` is private local recovery material: protect it alongside the dedicated
SSH key and immutable `vm-state.json`; neither belongs in Git, images, screenshots or support logs.

## Acceptance and access

The operator prints the **nonsecret HTTPS origin** from the owned Public IP. Open it, then enter
`OWNER_TOKEN` from private `.env.pilot` locally. Never append it to a URL or paste it into an issue/chat.
Anyone with that token has full owner access. The browser keeps it only in that tab's session storage.

Before handing off, record evidence for:

- Trusted HTTPS certificate, HTTP redirection, UI and readiness; unauthenticated API and photo requests return 401.
- Token acquisition and real streaming/tool-capable Foundry inference from the **actual UID1000 app container**,
  not only the host shell; verify the VM principal/tenant and exact account-scoped role. Retry only boundedly for RBAC propagation.
- Real conversation turns via CopilotKit, including a fresh client and a post-restart client on the same thread.
- GUI name/instructions/photo changes, replacement/removal/fallback, reload and service/VM restart persistence.
- Zero persisted MCP connections/external action tools; no browser/computer/voice/Composio activation.
- Content-free `agent.turn` spans ingested into the owned workspace, token disabled/password-free, consistent backup/restore.

`/readyz` checks local database/configuration, not model or Intelligence connectivity.
The Foundry resource is in East US2; **GlobalStandard is not a regional inference-residency guarantee**.

## Operations and recovery

```sh
node deployment/azure/pilot.mjs restart
node deployment/azure/pilot.mjs backup
node deployment/azure/pilot.mjs restore-test <private-path-under-artifacts/azure-pilot/backups/backup-UUID.sqlite>
node deployment/azure/pilot.mjs stop
node deployment/azure/pilot.mjs resume
```

`stop` gracefully stops the application then deallocates the VM, retaining both disks and its Public IP.
Disk, registry and other charges can continue. `resume` verifies identities/mount/service; recheck HTTPS,
model access and conversation continuity. This is a single-instance pilot, not HA.

`backup` uses owner-authenticated `POST /api/backup` on the exact live owned HTTPS origin, not SSH or
Run Command output. The endpoint requires an explicit bearer token, configured Origin and empty JSON;
tokenless-local access never enables export. The configured database is copied in full using SQLite
`VACUUM INTO`, including WAL-visible changes and photos, outside the HTTP event loop. Only one export
runs, followed by a30-second cooldown. The operator refuses redirects and writes an exclusive0600 partial;
length/SHA256/integrity/table hashes must match before the durable manifest and completed file are published.
Failed transfers retain private partial evidence, never a reported successful backup.

**Pilot backup limit:32MiB per complete snapshot**, using only the existing64MiB `/tmp` tmpfs for private
staging. No data is omitted to fit, and there is no disk fallback. The worker has a20-second guardian,
32MiB per-file and1GiB address-space limits, bounded heap and disabled core dumps; the request/stream
has a60-second lifetime. Shared tmpfs pressure may fail an export safely. Cleanup uncertainty/orphan jobs
block more exports; investigate only the known job prefix or restart the container after proving no export
is active. Review storage before a workspace exceeds this capacity. See [Private owner backup](../../docs/private-backup.md).
Never encode/chunk a backup into Run Command output or add blob services/credentials to bypass this boundary.
`restore-test` requires the manifest and restores to a **separate local copy**, never the active database.
Run a restored copy in isolation with model/scheduler/network effects disabled before any manual cutover.
Preserve project key, owner ID and thread IDs: SQLite backups do **not** contain CopilotKit's external chat history.
Backups are private data and can contain connected-service credentials if integrations are later enabled;
encrypt exported copies and approve retention separately. There is no automatic pruning.

### Interrupted operation

- A local timeout/abort does **not** prove remote execution stopped. Root-owned `flock` serializes bounded
  management operations; systemd startup itself does not recursively take that lock. Never unlink or age-break it.
- Run `node deployment/azure/pilot.mjs management-reconcile` to validate the pending resource/source/opID and
  persist its bounded completion receipt. This is GET-only, not a PUT retry. An exact durable prior contract/completion
  can be observed while waiting, but never accepted as the new completion. Missing/foreign/drifted state, raw output,
  or terminal provider status without the wrapper receipt remains blocked. No delete/recreate/adoption/unpin.
- Run `node deployment/azure/pilot.mjs token-disable` first if import state is uncertain; it works without VM
  outputs or an active guest. Verify disabled status and no passwords; expiry is a backstop, not proof of revocation.
- Retain `pullOperationId` after cleanup failure. Unknown management must reconcile before remote cleanup;
  the outer token revocation still runs even when reconciliation/cleanup fails. A retry checks cleanup/image presence first.
- Inspect Azure operation status and reconcile VM/disk identities and guest format intent. Never force-format,
  rotate owner/project identity, replace a host-key pin or remove a saved creation record to bypass a guard.
- Remove a stale **local** `operator.lock` only after confirming no local operator is active, checking cloud status,
  and respecting the remote deadline/lock. Orphan OS disks or lost identity records require manual reconciliation;
  this tool will not delete or adopt them.

### Maintenance boundaries

Operator-IP changes are no longer a management prerequisite: preserve the historical parameters/hash/keys and
**do not restore `operator-ssh`**. Image/helper upgrades after any activation, active-database restore and credential
rotation remain separate maintenance, not automatic retries. The version1 initial-activation procedure is not an upgrader.
The installed `vm-host.sh`, `vm-disk.py`, and `vm-bootstrap.sh` bytes are immutable; this change does not replace them.

If Azure policy adds extensions or identities, inspect their exact IDs/publisher/type and policy provenance;
preserve required controls and review a narrow read-only allowance. Do not blanket-allow Compute resources,
remove an enforced identity, or disable security agents. Treat these as actual-state changes, not assumptions.

Production preparation and its intentionally unimplemented application migration gates are in
[Production preparation](../../docs/AZURE-PRODUCTION.md). The pilot operator cannot select or deploy that foundation.

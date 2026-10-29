# South Central US — preservation and B1 host infrastructure

This is **not migration completion, application readiness or Azure validation**. The approved target is
`pilot-scus-v1`, `rg-opendots-pilot-scus`, `southcentralus`, in the original fixed account. The original
profile (`original`) remains the default. Exactly these two immutable profiles exist. Neither environment
variables, a configuration file nor arbitrary region/group/template arguments select a profile.

Stage A (group/capture/copy) is lead-reported **live complete**. Preserve its journal, archives, requests,
templates, parameters and hashes; do not rerun its applies. B1 adds a fresh target host, an attached restored
application disk, a separately created **unattached** OS-audit disk, and a separate model-role stage. This source
revision is not proof that B1 has been validated or deployed. Each new live caller still needs lead verification
and independent review.

There is no source start/stop/delete/export-policy operation, credential delivery, formatting or guest command.
B1 creates no extension, managed Run Command, customData, userData or bootstrap script. The fresh stock image
boots as part of VM creation; this is not an application launch or proof of safe audit-disk boot containment.
Target management/privacy qualification, restore-only guest handling, OS/data audit, offline configuration,
activation and cutover acceptance remain B2 work and reject before effects here.

## Boundaries

- Account remains tenant `16b3c013-d300-468d-ac64-7eda0820b6d3`, subscription
  `68eab0d1-ab81-4851-b2dd-173dede87582`, deployment user `ad4d1fc5-ea1f-4e76-a56c-934f5b1b52e9`.
- Compute metadata for the new RG is South Central US. Capture snapshots reside **in the new RG but East US 2**;
  copy snapshots reside in that RG in South Central US. Per-resource locations are checked independently.
- Original East US 2 Foundry, ACR, telemetry, Sandbox and Intelligence remain unchanged. The profile reserves
  `artifacts/azure-pilot-shared` for later coordination, but this increment creates no token machinery there.
  The sole additional shared-scope write is the separately reviewed OpenAI User assignment to the actual new VM
  identity on the existing Foundry account, plus its fixed deployment bookkeeping. No original role is replaced.
- Source VM and disk resource/unique IDs come from the read-only original operator archive and fresh ARM reads,
  not chat-provided dynamic identities. The source filesystem binding is
  `a18c384f-d8ca-40a5-8a93-18ba8e1890e3`; this is archival lineage, not a guest filesystem audit or format permit.
- Preserve source OS30GiB Standard_LRS, Linux/Gen2/TrustedLaunch/platform-key encryption, AllowAll/publicEnabled;
  preserve source data32GiB Standard_LRS, DenyAll/publicDisabled. Unexpected source settings stop the operation;
  no source policy is rewritten to make preservation pass. Both disks must remain attached/retained/Reserved.
- Every **new** snapshot is Standard_LRS, incremental, DenyAll/publicDisabled and platform-key encrypted. OS
  snapshots retain Linux/Gen2/TrustedLaunch. If provider validation refuses that security combination, stop;
  do not downgrade security or enable SAS/VHD export.

## Local prepare and input preservation

After independent source review, the lead may run these callers; local tests are not permission to run them:

```sh
node deployment/azure/pilot.mjs --profile pilot-scus-v1 prepare
```

`prepare` is local only. Under a separate target operator lock it reads exactly the original
`vm-state.json`, `vm-parameters.json` and `arm-outputs.json`; it never reads `.env`, `.env.pilot` or private SSH keys.
It verifies current-owner0600 regular files, non-symlink owned directories and absence of an original operator
lock. It checks source bytes again while archiving. Keep all other source operations stopped during migration.

Original files remain byte-for-byte unchanged. The new private `artifacts/azure-pilot-scus/source/` holds exclusive
copies, and `migration-state.json` is version3 with mandatory profile ID, archive byte hashes and source lineage.
The durable archive intent precedes archive publication. Each fixed filename uses its deterministic
`.<filename>.<migrationId>.tmp` staging alias through the held private directory descriptor. Publication writes
only the planned bytes, verifies and fsyncs the file, exclusively hardlinks the final name (never overwrites it),
fsyncs the directory, removes only the verified staging alias, and fsyncs the directory again. Final verification
requires the ordinary private single-link file; parent-directory durability is also retained.

A repeated `prepare` recovers only the same exact archive intent:

- Neither path exists: exclusively create owned0600 staging.
- Staging only: require an owned0600 regular single-link file and stable path/descriptor identity; accept only
  an exact prefix of the expected bytes and write only its missing suffix before verification/fsync/publication.
- Final and planned staging share the same inode: require complete expected bytes and **exactly two links**,
  re-fsync, then remove only that verified planned alias and require the final file to have one link.
- Final only: verify the exact complete private single-link file and re-fsync it without rewriting.

Conflicting files, different inodes, symlinks, unsafe modes/owners, unknown extra links, unexpected staging bytes
or partial final files stop without overwrite or cleanup. There are no directory sweeps or archive rebinding.
This local publication recovery is not permission to retry a cloud stage or clear an interrupted operator lock.
Original creation/format permits, existingPilot evidence, management privacy and initial recovery facts remain
archival data only; none becomes active target state. No target guest bundle is read or claimed to exist.

Linux `/proc/<operator-pid>/fd/<directory-fd>/...` paths keep the fixed private request files reachable by the CLI
child while the operator holds its directory descriptors. There is no arbitrary request-file CLI argument.

## Finite stages

| Stage        | Fixed deployment                                  | Resource writes                                                                       |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `group`      | `opendots-scus-group-v1` (subscription scope)     | Only `rg-opendots-pilot-scus`                                                         |
| `capture`    | `opendots-scus-capture-v1` (new RG)               | `snap-opendots-source-os-v1`, `snap-opendots-source-data-v1` in East US 2             |
| `copy`       | `opendots-scus-copy-v1` (new RG)                  | `snap-opendots-scus-os-v1`, `snap-opendots-scus-data-v1` in South Central US          |
| `host`       | `opendots-scus-host-v1` (new RG)                  | Seven declared target resources plus the exact implicit fresh OS disk described below |
| `model-role` | `opendots-scus-model-role-v1` (**shared old RG**) | One account-scoped OpenAI User assignment for the pinned target MI                    |

Run each stage completely before the next. Do not chain unreviewed applies. The following Stage A commands are
procedure reference only: **do not replay them against the already-completed migration**.

```sh
node deployment/azure/pilot.mjs --profile pilot-scus-v1 preflight group
node deployment/azure/pilot.mjs --profile pilot-scus-v1 validate group
# Review the private group-validation.json and exact compiled request; create group-review.json below.
node deployment/azure/pilot.mjs --profile pilot-scus-v1 apply group
node deployment/azure/pilot.mjs --profile pilot-scus-v1 reconcile group
# Repeat preflight → validate → manual review → apply → reconcile for capture, then copy.
```

`preflight` is read-only in Azure. It requires an attributable prior stage, absent new names, complete target
inventory, fresh original VM/disk identity and cold-state evidence, and an exact compiled resource graph.
An existing untracked group, snapshot or deployment name refuses adoption. Fixed names are never regenerated.

`validate` invokes real provider-level validation **and full-payload what-if**, not just local compilation.
It rejects skipped/failed validation, missing validated resources, deletions, replacements, modifications,
untracked resources and unapproved settings. Only exact expected Creates and unchanged/ignored known prior
stage resources are allowed. It writes a private `<stage>-validation.json` and a journal proof binding the
compiled bytes, parameters, profile, archive/source observations, provider responses and full change set.
Azure CLI must support `--validation-level Provider` (2.76+); no Template/ProviderNoRbac fallback exists.

### Manual review file

After actual inspection and the required independent review, create an owned0600 non-symlink
`artifacts/azure-pilot-scus/<stage>-review.json` with **exactly** these fields:

```json
{
  "version": 1,
  "profileId": "pilot-scus-v1",
  "migrationId": "<copy the durable migration ID>",
  "stage": "group",
  "proposalSha256": "<the validate result's proposal hash>",
  "changesSha256": "<the validate result's full change-set hash>",
  "reviewSha256": "<SHA256 of the actual independent review record>",
  "reviewedAt": "<actual UTC review time>"
}
```

Placeholders and fixture hashes are not review. There is no approve-all or blanket Validated flag. Revalidation
requires a matching review of the newly recorded proposal. `apply` checks the compiled bytes/source/profile again,
reruns provider validation and what-if, requires the same reviewed change set/provider template hash, then checks
inputs/absence once more. The target-only `createWithIntent` path validates, copies and freezes the exact CREATE
arguments/options and execution environment, then completes the final account/tenant/principal and Graph checks.
Only afterward does `apply`'s mandatory internal callback recheck the exact private request bytes and
**unconditionally fsync the same intent**, followed by one fixed `create --no-wait` invocation. No account/Graph
check or mutable request preparation occurs between that intent and create. The callback is not a CLI/user hook;
target `write()` allows validation/what-if but rejects create, and target `read()` cannot dispatch mutations.

Argument or final-authentication failure produces no new intent or create. Request-byte/callback/durability
failure prevents create and retains any already-published or uncertain journal facts. Once create invocation
begins, every error retains the intent for GET-only reconciliation. A crash between durable intent and invocation
is still unavoidable uncertainty: filesystem publication and Azure are **not** an atomic transaction. There is
no reset, skip-verification flag or automatic retry. Validated source settings are never refreshed silently.

## Cold capture and managed copy

The source must already be deallocated/Succeeded. Disk unique IDs, attachments/Detach settings, sizes, security,
exports, `diskState:Reserved` and the raw REST `properties.LastOwnershipUpdateTime` are required. That timestamp
changes on attachment or VM start/deallocation transitions; missing/invalid evidence is not assumed safe.
Cold-source preservation accepts an omitted/null VM OS managed-disk `storageAccountType` mirror; a present
mirror must be `Standard_LRS`. The managed-disk reference and exact ID remain mandatory, and dedicated disk GETs
must still prove `Standard_LRS` and all identity/attachment/timestamp/security/export/retention checks; no SKU is inferred.
The full source-RG inventory is still read and checked for shape, duplicates and required VM/OS/data records.
Only those three exact inventory records enter the canonical fingerprint, explicitly identified as
`inventoryProjection:source-vm-os-data-v1`; their tags remain conservative identity inputs. Unrelated Foundry,
ACR, network or other resource tags/additions do not invalidate the source proof, but incomplete/malformed or
duplicate inventory still fails. Older whole-RG proofs/intents are not silently reinterpreted or hash-rewritten;
this batch provides no journal conversion.

All direct source observations and that required-record projection must remain unchanged. The early source check
on pending capture reconciliation and the completion-time source check are both mandatory. Observed transitions,
required-record changes or unavailable checks set a retained `uncertainPreservation` condition and stop automatic
continuation, even if the source later looks stopped again. Later observations never clear that condition.

Capture is labelled **cold/crash-consistent**, `sourceGuestManifest:unavailable`, shutdown cleanliness **unknown**.
No source guest boot, filesystem repair or data-content audit is required before protective capture. Snapshots
preserve persisted blocks, not volatile writes or a guarantee of graceful shutdown. Data authority and SQLite
sidecar handling still require the later read-only snapshot-derived audits before any application launch.

`copy` uses only managed Azure `CopyStart` from the exact captured snapshot IDs. Source snapshot unique/family/
creation/lineage metadata is checked, not inferred from the resource name. All four snapshots pin provider
`uniqueId`, `incrementalSnapshotFamilyId`, `timeCreated`, `creationData.sourceResourceId` and `sourceUniqueId`.
Missing identity fields block acceptance rather than manufacturing continuity. Families are pinned individually;
cross-region family-ID equality is not assumed. Capture requires `sourceUniqueId` to match its original disk UID.
CopyStart readback accepts only the exact captured snapshot UID **or** that captured snapshot's original disk UID,
after the captured root has independently matched the corresponding archived OS/data disk lineage. Its
`sourceResourceId` must still be the exact captured snapshot ID. No cross-disk, destination, arbitrary or missing
UID is accepted. The observed value and `sourceUniqueIdKind` (`captured-snapshot` or `original-disk`) are pinned;
later GETs cannot switch either. The request's `expectedSourceUniqueId` tag remains the immediate captured
snapshot UID, not the compatibility readback value.

These two CopyStart UID interpretations are **not fully documented provider guarantees**. Acceptance relies on
the independent exact captured-snapshot unique/family/time/root/security/export checks, refreshed before copy
authorization, before accepting destination lineage and again before copy completion. An unknown first-live
variant still stops for lead investigation; it is not grounds to widen the accepted values.

**Both capture and copy** require provisioning `Succeeded`, no `copyCompletionError`, and `snapshotAccessState`
exactly `Available` or `AvailableWithInstantAccess`. Missing/null/`Unknown`/`Pending`/`InstantAccess`/unrecognized
access remains pending; neither SKU nor provisioning alone implies availability. Copy additionally requires
numeric `completionPercent === 100`; missing/string/incomplete progress stays pending. Failed/canceled snapshots
or a copy error remain failures even when another snapshot is merely pending. Access/progress are volatile,
not immutable snapshot identity, so legitimate transitions reconcile without replacement or a new create.
Fresh dependent-stage authorization rechecks access, including B1 restoration. This is a snapshot-copy gate,
**not** a Standard HDD disk hydration rule.

## B1: local key preparation → host → model-role

After source review and with Stage A complete, the lead uses the same explicit profile and reviewed stage flow:

```sh
node deployment/azure/pilot.mjs --profile pilot-scus-v1 prepare-host
node deployment/azure/pilot.mjs --profile pilot-scus-v1 preflight host
node deployment/azure/pilot.mjs --profile pilot-scus-v1 validate host
# Independently review the exact host proposal; write host-review.json using the contract above.
node deployment/azure/pilot.mjs --profile pilot-scus-v1 apply host
node deployment/azure/pilot.mjs --profile pilot-scus-v1 reconcile host
# While pending, repeat only reconcile; never apply again.

# Only after successful host readback has pinned the ACTUAL new MI:
node deployment/azure/pilot.mjs --profile pilot-scus-v1 preflight model-role
node deployment/azure/pilot.mjs --profile pilot-scus-v1 validate model-role
# Independently review that actual-principal proposal and write model-role-review.json.
node deployment/azure/pilot.mjs --profile pilot-scus-v1 apply model-role
node deployment/azure/pilot.mjs --profile pilot-scus-v1 reconcile model-role
node deployment/azure/pilot.mjs --profile pilot-scus-v1 status
```

### Target-only admin key

Linux VM creation needs a public admin key, but it does **not** authorize opening SSH. `prepare-host` is local
only: it reads the preserved Stage A archive/state, never source private keys or `.env`, and uses local
`ssh-keygen` to create one fresh Ed25519 pair in the fixed owned0700
`artifacts/azure-pilot-scus/host-key/` directory. The private `id_ed25519` and public `id_ed25519.pub` are kept0600;
only the public key enters `host-public-parameters.json` and ARM. No operator CIDR is a target parameter.

The version-3 host stage records a key-generation intent before creation. An untracked directory/parameter file
is not adopted. A completed key pair can finalize interrupted preparation using that same private key (a missing
public companion can be derived); an absent, partial, unsafe or conflicting private key never triggers another
generation. Conflicting/partial public parameters stop without overwrite. Complete preparation fsyncs material
and directories, verifies private/public correspondence, and pins exact file hashes. Later preparation and host
preflights verify those bindings; possible VM submission can never rotate or regenerate a key. No private key or
subprocess output is logged or transmitted. Missing-key/interrupted-lock recovery is lead-owned investigation,
not a force/reset option. Original key material remains untouched.

### Fixed host graph and readback

| Resource                  | Fixed name / contract                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| VM                        | `vm-opendots-pilot-scus`, Standard_D2als_v7, system-assigned MI, Linux/Gen2/NVMe/TrustedLaunch with Secure Boot and vTPM        |
| Fresh implicit OS disk    | `disk-opendots-pilot-scus-os`, FromImage, explicit32GiB Standard_LRS, platform-key encryption, retained/Detach                  |
| Restored application disk | `disk-opendots-pilot-scus-data`, Copy from the SCUS data snapshot,32GiB Standard_LRS, LUN0 only, cachingNone/Detach             |
| OS-audit disk             | `disk-opendots-pilot-scus-os-audit`, Copy from the SCUS OS snapshot,30GiB Standard_LRS/Linux/V2/TrustedLaunch, **Unattached**   |
| VNet / subnet             | `vnet-opendots-pilot-scus` / `app`, sole10.43.0.0/24 subnet, no peering/custom DNS/routing/service overlays                     |
| NIC                       | `nic-opendots-pilot-scus`, sole primary static10.43.0.4 IPv4 configuration                                                      |
| NSG                       | `nsg-opendots-pilot-scus`, attached to both NIC and subnet; Internet TCP80/443 to10.43.0.4/32, then deny other inbound          |
| Public IP                 | `pip-opendots-pilot-scus`, Standard/Regional staticIPv4, DNS label `opendots-7unu3az5tgmza-scus`, ResourceGroupReuse protection |

The host template declares seven resources; the VM implicitly creates only the exact named fresh OS disk. The
deployment's output-resource list must contain all seven declared IDs and may additionally contain that one OS
disk ID. Runtime inventory must contain the named OS disk, and no other implicit resources or governance overlay
is adopted. New host IDs become allowable target inventory only after the host intent. The seven declared
resources plus the OS disk are read independently; UUIDs, creation times, ownership, attachment, retention,
image/security/export settings, actual public IP/FQDN and network bindings are verified before host completion.
Reported network resource GUIDs are pinned without inventing absent fields. Azure's actual FQDN is read and
pinned, not synthesized from the DNS label or reuse hash.

Only the exact target public IP declares and accepts `ipTags:[{ipTagType:'FirstPartyUsage',tag:'/Unprivileged'}]`,
as required by the enforced custom `PublicIPAddress_Tags_Append` policy. This is mandatory classification,
not an exemption or permission to adopt arbitrary policy overlays; it does not establish firewall or routing
privileges. The [Network2025-05-01 schema](https://learn.microsoft.com/azure/templates/microsoft.network/2025-05-01/publicipaddresses)
documents `ipTags`/`FirstPartyUsage`; the exact `/Unprivileged` requirement comes from that custom policy.
What-if and completed readback require that exact one-object array, including its exact fields and case.
Verified provider values are pinned at `stages.host.binding.network.resources.pip.ipTags`; missing values are
never filled, and later classification drift stops without rebinding or corrective writes. Other network
resources still reject IP tags; ownership tags and all DNS/routing/prefix/peering/attachment guards are unchanged.

Host **what-if only** accepts four bounded preview representations observed in a diagnostic response:
the two exact NSG rules in either name order (all security properties remain exact); omission of the sole NIC
IP configuration's whole `primary` property (a present value must be `true`); independent omission of the VM's
whole OS/data `managedDisk` properties; and exactly one SSH public-key entry containing either the exact intended
path/key pair or both values literally `*******` (seven asterisks). A present managed-disk object must retain
its requested fields; any returned ID/SKU must match the exact target disk/`Standard_LRS`, with no other
managed-disk configuration. Null, partial, contradictory or unresolved fields and mixed/other masks fail.
No other array order or masking allowance is introduced. Overlay/classification and no-guest-execution guards
inspect the original payload, and neither provider nor expected inputs are rewritten.

Omitted or masked preview values are **not verified equal**. Manual review must inspect the exact compiled host
graph, prepared public parameters/key binding and Provider-level validation as well as the full raw what-if,
explicitly recognizing these preview gaps. Completed VM/NIC GETs still require actual managed-disk IDs,
`primary:true` and the intended unmasked SSH path/key; dedicated disk size/SKU checks are unchanged. The diagnostic
capture is regression evidence only, not an accepted validation proof or a universal provider-shape guarantee.
After source review, the lead must rerun normal `validate host` and independently review its fresh proposal;
no diagnostic is promoted, no intent/create is authorized by this compatibility change alone.

The image is exactly `Canonical:ubuntu-24_04-lts:server:24.04.202610160` in South Central US. Preflight checks its
documented Linux/x64/V2 identity and Trusted Launch/NVMe compatibility. The marketplace GET schema does not
establish a minimum disk size. The template explicitly requests a32GiB FromImage OS disk; real Provider validation
and the reviewed exact what-if are the pre-creation gate. A successful validation reports:
**“Provider validation accepted pinned-image 32GiB request; image minimum not independently measured.”** This is
request acceptance, not a capacity or provisioning guarantee. Only successful dedicated Disk GET verification
can report **“created OS reports 32GiB.”** Its size must be numeric32; missing/non-numeric/wrong authoritative size
or SKU cannot complete. An omitted VM-reference size/SKU is not a substitute for the authoritative disk, and a
present contradictory mirror fails. No auto-resize, image substitution or probe VM is available.

Both restored disks remain DenyAll/publicDisabled/platform-key encrypted. B1 records the fresh implicit OS's
AllowAll/publicEnabled defaults (or DenyAll/Disabled if already enforced) without modifying them; the defaults
are **not anonymous access or a SAS grant**. Later export-setting drift cannot silently refresh the binding. Before B2 delivers any protected
application/registry input, the fresh OS must be verified DenyAll/Disabled. Any required hardening PATCH is a
separate reviewed, journaled capability, **not implemented or permitted in B1**.

### Restored disk Copy lineage — distinct from Stage A CopyStart

Restores require exact `createOption:Copy` and the corresponding SCUS snapshot ID. All four snapshots' recorded
unique/family/root/security/creation metadata and availability are refreshed before submission and after creation,
before accepting disk bindings. Both SCUS copies must still report numeric100 and accepted access state. The
reviewed deterministic deployment, durable intent, prior name absence, exact inventory/output graph and new disk
identity/creation/ownership/security checks are mandatory even when a provider source UID is absent.

For a restored disk's `creationData.sourceUniqueId`, accept exactly:

- omitted;
- explicit `null`;
- the immediate SCUS source snapshot's **own** `uniqueId`.

Original-disk IDs, older/captured-snapshot IDs, cross-disk IDs, foreign UUIDs and empty/malformed values fail.
Never use the source snapshot's `creationData.sourceUniqueId` as the expected value and never infer it from tags.
The first successful completed binding records `sourceUniqueIdRepresentation:omitted|null|value` and the exact
value when present under `stages.host.binding.disks.<kind>.creation`. Later representation/value drift fails;
an incomplete provisioning response cannot establish final absence. No provider fields are filled or rewritten.
Standard_LRS disk hydration percentage is not subjected to the snapshot-copy100% gate; known disk copy errors
still fail. This contract does not change Stage A's separately approved CopyStart validator.

### Separate model-role and bounded observations

`model-role` deploys into the **explicit shared `rg-opendots-pilot`**, not the target compute RG. The existing
Foundry account is an existing-resource scope, never a resource update. The only new assignment is
`f38e4e56-1acc-5c13-9dc1-d17567962599`, Cognitive Services OpenAI User
(`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`), scoped to `ai-opendots-7unu3az5tgmza`. Its `principalId` must be the
actual host-bound new MI, with `principalType:ServicePrincipal`. There is no unresolved-principal what-if
allowance. Fresh host identity drift rejects the proposal; a fixed existing untracked role is not adopted.
The original assignment and all shared service configurations remain unchanged. Role readback is authorization
metadata, **not proof that inference works**; no service token, image pull or model request is performed.

After host binding, `status` performs a bounded GET-only observation. It checks the host binding, reads a fixed
instance-view projection and rechecks VM identity. Output contains only sanitized power/provisioning state, agent
version and bounded native handler names/versions/statuses. Missing handler evidence stays unavailable, not an
invented empty ready set. No raw VM payload, diagnostic/SAS URL, message, protected settings or private key is
returned. Observation does not save handler pins or qualify management, privacy, boot containment or app data.

B1 can report `hostBound` and, after the separate verified role stage, `modelRoleAssigned`; it always reports
`applicationActivated:false` and leaves guest qualification, fresh-OS export hardening and data audit pending.
`audit`, `configure`, `activate`, source power, audit attach/detach, harden/export, extension and guest commands
remain unavailable. B2 must establish actual target management and effective firmware/bootloader/initramfs/root
selection containment before attaching the unknown-UUID OS copy. There is no boot workaround, copied source
privacy approval, or B1 activation shortcut.

## Ambiguity and GET-only reconciliation

An apply with a durable intent can never apply again. Timeout, abort, CLI failure or missing immediate readback
does not prove non-dispatch. `reconcile <stage>` makes a bounded single pass of fixed GET/list operations only;
it cannot create, repair, clear or retry. A still-incomplete copy stays pending. The exact deployment ID,
provider template hash, parameters and pinned correlation ID must match, followed by immutable resource reads.
Unknown/failed/substituted outcomes retain all local intent, archive and partial cloud resources. No automatic
cleanup or stale-lock deletion exists. The operator lock is released only on normal local unwinding; interrupted
locks require lead investigation, never a timeout-based force option.

Completed stage evidence remains historical evidence when later source power or future template bytes change;
GET-only observation uses its recorded request, not a newly rendered template as authority. New writes still
require fresh source/lineage/provider checks and a matching review. A missing/replaced snapshot is not adopted.
Successful `copy` means preserved copies only. It does not mark host/audit/configure/activate complete or select
authoritative app data. Source and target must not become simultaneous application writers.

## Local checks and remaining integration

```sh
mkdir -p /tmp/opencode/opendots-scus-contracts
"$HOME/.azure/bin/bicep" build infra/main.bicep --outfile /tmp/opencode/opendots-scus-contracts/original.json
for stage in group capture copy host model-role; do
  "$HOME/.azure/bin/bicep" build "infra/scus/$stage.bicep" --outfile "/tmp/opencode/opendots-scus-contracts/$stage.json"
done
PILOT_ARM_TEMPLATE=/tmp/opencode/opendots-scus-contracts/original.json \
PILOT_SCUS_TEMPLATE_DIR=/tmp/opencode/opendots-scus-contracts \
node --test deployment/azure/test/*.check.mjs
python3 -B -m unittest discover -s deployment/azure/test -p '*_test.py'
```

Run tests with credentials/artifacts masked and networking disabled; only synthetic temporary state is used.
The B1 tests also use local `ssh-keygen` only on synthetic key directories. No original IaC, guest helper/wrapper
or native-handler implementation changed. Stage A's earlier shared scope-validator change altered the original
computed transport hash; B1 does not rewrite that transport or historical recorded hashes. Preserve them and
require fresh qualification for future guest work. This increment never constructs a target transport. Future
target guest integration must cover profile/bundle dependencies in its transport hash and use new target-only
privacy evidence; it cannot transplant the original approval or wrapper bindings.

Documentation sources: Context7 Azure documentation first, followed by Microsoft Learn for exact raw response
fields and deployment validation semantics:

- [Managed cross-region incremental snapshot copy](https://learn.microsoft.com/azure/virtual-machines/disks-copy-incremental-snapshot-across-regions)
- [Snapshots GET, API2025-01-02](https://learn.microsoft.com/rest/api/compute/snapshots/get?view=rest-compute-2025-01-02)
- [Disks GET, including LastOwnershipUpdateTime](https://learn.microsoft.com/rest/api/compute/disks/get?view=rest-compute-2025-01-02)
- [Provider deployment validation](https://learn.microsoft.com/rest/api/resources/deployments/validate?view=rest-resources-2025-04-01)
- [Marketplace-image GET, API2025-11-01](https://learn.microsoft.com/rest/api/compute/virtual-machine-images/get?view=rest-compute-2025-11-01)
- [Trusted Launch marketplace image feature checks](https://learn.microsoft.com/azure/virtual-machines/trusted-launch-faq)
- [Resource-scoped RBAC in Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/scenarios-rbac)
- [Role-assignment list REST](https://learn.microsoft.com/azure/role-based-access-control/role-assignments-list-rest)
- [Native VM agent/handler instance-view fields](https://learn.microsoft.com/javascript/api/@azure/arm-compute/virtualmachineagentinstanceview?view=azure-node-latest)

Actual provider compatibility, policy permission, B1 deployment and B2 application acceptance remain lead-owned
verification. A provider denial never authorizes weakening security, changing images, adding resources or retrying writes.

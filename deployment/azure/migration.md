# South Central US — preservation increment only

This is **not migration completion, application readiness or Azure validation**. The approved target is
`pilot-scus-v1`, `rg-opendots-pilot-scus`, `southcentralus`, in the original fixed account. The original
profile (`original`) remains the default. Exactly these two immutable profiles exist. Neither environment
variables, a configuration file nor arbitrary region/group/template arguments select a profile.

This increment can create only the target group and four incremental snapshots. It has no source
start/stop/delete/export-policy/credential operation, no target VM/disk attachment, and no formatting or
guest command. Host, restore-only disk handling, OS/data audit, offline configuration, privacy qualification,
activation and cutover acceptance are later increments and reject before effects here.

## Boundaries

- Account remains tenant `16b3c013-d300-468d-ac64-7eda0820b6d3`, subscription
  `68eab0d1-ab81-4851-b2dd-173dede87582`, deployment user `ad4d1fc5-ea1f-4e76-a56c-934f5b1b52e9`.
- Compute metadata for the new RG is South Central US. Capture snapshots reside **in the new RG but East US 2**;
  copy snapshots reside in that RG in South Central US. Per-resource locations are checked independently.
- Original East US 2 Foundry, ACR, telemetry, Sandbox and Intelligence remain unchanged. The profile reserves
  `artifacts/azure-pilot-shared` for later coordination, but this increment creates no token machinery there.
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

## Three finite stages

| Stage     | Fixed deployment                              | Resource writes                                                              |
| --------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `group`   | `opendots-scus-group-v1` (subscription scope) | Only `rg-opendots-pilot-scus`                                                |
| `capture` | `opendots-scus-capture-v1` (new RG)           | `snap-opendots-source-os-v1`, `snap-opendots-source-data-v1` in East US 2    |
| `copy`    | `opendots-scus-copy-v1` (new RG)              | `snap-opendots-scus-os-v1`, `snap-opendots-scus-data-v1` in South Central US |

Run each stage completely before the next. Do not chain unreviewed applies:

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
Only cold-source preservation accepts an omitted/null VM OS managed-disk `storageAccountType` mirror; a present
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
Fresh dependent-stage authorization rechecks access, and later disk restore must do so too (not implemented here).
This is a snapshot-copy gate, **not** a Standard HDD disk hydration rule for later host work.

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
for stage in group capture copy; do
  "$HOME/.azure/bin/bicep" build "infra/scus/$stage.bicep" --outfile "/tmp/opencode/opendots-scus-contracts/$stage.json"
done
PILOT_ARM_TEMPLATE=/tmp/opencode/opendots-scus-contracts/original.json \
PILOT_SCUS_TEMPLATE_DIR=/tmp/opencode/opendots-scus-contracts \
node --test deployment/azure/test/*.check.mjs
python3 -B -m unittest discover -s deployment/azure/test -p '*_test.py'
```

Run tests with credentials/artifacts masked and networking disabled; only synthetic temporary state is used.
No original IaC, guest helper/wrapper or native-handler implementation changed. Shared scope-validation source
changed, so the computed original transport hash changes naturally; preserve historical recorded hashes and
require fresh qualification for future guest work. This increment never constructs a target transport. Future
target guest integration must cover profile/bundle dependencies in its transport hash and use new target-only
privacy evidence; it cannot transplant the original approval or wrapper bindings.

Documentation sources: Context7 Azure documentation first, followed by Microsoft Learn for exact raw response
fields and deployment validation semantics:

- [Managed cross-region incremental snapshot copy](https://learn.microsoft.com/azure/virtual-machines/disks-copy-incremental-snapshot-across-regions)
- [Snapshots GET, API2025-01-02](https://learn.microsoft.com/rest/api/compute/snapshots/get?view=rest-compute-2025-01-02)
- [Disks GET, including LastOwnershipUpdateTime](https://learn.microsoft.com/rest/api/compute/disks/get?view=rest-compute-2025-01-02)
- [Provider deployment validation](https://learn.microsoft.com/rest/api/resources/deployments/validate?view=rest-resources-2025-04-01)

Actual provider compatibility/policy permission and live preservation success remain lead-owned verification.
The new trusted-launch capture/copy request is never weakened in response to a provider denial.

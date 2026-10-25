# Azure production foundation — not authorized for deployment

The pilot is one trusted Node 24/CopilotKit application on an Ubuntu 24 VM with
a system-assigned managed identity, SQLite and a POSIX data disk. The VM fallback
is deliberate: tenant policy requires Entra-only Foundry access, while stable
Sandbox has no managed identity. It is not an HA or multi-tenant deployment.

`infra/production/foundation.bicep` is a **standalone infrastructure foundation
with no app containers**, not an application migration or production release. It is not wired
to the pilot operator and adds no production selector. Do not deploy production
from the pilot template or move the pilot database onto a shared replica mount.
No deployment, cloud validation, application migration or restore is demonstrated
by the local checks below.

## Reliability targets, not guarantees

| Area         | Pilot                                                                                               | Production acceptance target                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Availability | Best effort; one instance, no SLA claim                                                             | 99.9% monthly authenticated API availability, measured externally                                                         |
| Agent turns  | Current 90-second timeout; manual success/error/timeout spans                                       | At least 95% successful supported turns; p95 first useful response <15 s and completion <60 s on representative workloads |
| RPO          | At most 24 h **only with** daily exported, verified local backups; otherwise unbounded              | 15 minutes, proven with managed DB PITR and protected/versioned objects                                                   |
| RTO          | Four-hour operator recovery target, not demonstrated                                                | One hour, proven by a timed restore/failover exercise                                                                     |
| Retention    | Pilot Log Analytics policy: 30 days / 0.1 GB daily ingestion cap; private backups retained manually | Approved data/backup deletion policy, budgets and alerts before release; foundation has no diagnostic sink                |
| Privacy      | Fixed operational metadata; no prompt/photo/header/error-body telemetry                             | Same content-free defaults, controlled diagnostics access and audited break-glass procedure                               |

Only exclude scheduled maintenance after approving that policy. Count model and
provider failures separately; an HTTP 200 stream is not a successful turn.
`agent.turn` outcomes are a measurement starting point, not an SLO result.
`/readyz` checks local DB/runtime configuration, not model or Intelligence
reachability. Synthetic authenticated checks and provider health measurements
must not record private content. Zone-redundant HA is **regional availability,
not regional DR**; PostgreSQL geo-redundant backup is disabled in this foundation.
Local backups do not include external CopilotKit conversation messages.

## What the foundation actually creates

- One VNet with three required, non-overlapping IPv4 subnet inputs: ACA delegated
  to `Microsoft.App/environments` (/23 recommended), PostgreSQL delegated to
  `Microsoft.DBforPostgreSQL/flexibleServers` (/27 recommended) with a
  `Microsoft.Storage` service endpoint, and an undelegated private-endpoint subnet
  (/27 recommended) with private endpoint network policies disabled.
- An **empty ordinary ACA** Workload Profiles environment: one Consumption profile,
  zone redundancy, internal load balancer, VNet integration, public network access
  disabled. Its private DNS zone comes from the returned `defaultDomain`; a
  wildcard A record uses the returned static private IP. A small same-RG local
  Bicep module (`infra/production/aca-dns.bicep`) holds only those three DNS
  resources because the domain is a runtime result, not a Bicep deployment-start
  name. All DNS links disable registration.
  **There is no public-ingress toggle.** Public publication needs separate review.
- PostgreSQL 17 Flexible Server: required GeneralPurpose SKU, explicit distinct
  primary/standby zones, ZoneRedundant HA, 128 GiB Premium_LRS with auto-grow,
  35-day backups. Entra authentication only, password authentication disabled;
  no administrator login/password properties or firewall rules. The required
  Entra **group**, in the deployment tenant, is the administrator, not the future
  workload identity. Private VNet integration uses
  `private.postgres.database.azure.com` and waits for its **VNet link**. The
  selected schema's `network.publicNetworkAccess` property applies only to
  non-VNet-integrated servers and is deliberately omitted here.
- StorageV2 / Standard_ZRS with HNS disabled, HTTPS/TLS 1.2, public network access,
  anonymous Blob access and shared keys disabled, firewall Deny / bypass None.
  Blob versioning and 30-day blob/container soft deletion protect one private
  `media` container. A Blob private endpoint in the dedicated subnet and its DNS
  zone group target exactly this account and `privatelink.blob.core.windows.net`.
  Soft deletion is not a lifecycle policy or an independent backup; version
  retention/deletion cost policy remains a release gate.
- One unattached user-assigned identity for a **future** workload. Its sole role is
  deterministic Storage Blob Data Contributor scoped to the **media container**,
  not account/RG/subscription. No SQL runtime principal or SQL grants are created.

Outputs are only resource/subnet IDs, the ACA domain/private IP, PostgreSQL FQDN,
media endpoint/container and identity resource/client/principal IDs. An endpoint
is not a credential or a working app URL. There are no containers, SQL migrations,
deployment scripts, secrets/connection strings/SAS/key outputs, model deployments,
Key Vault, AKS, APIM, Bastion or VMs. No pilot principal is reused.

ACA sets `appLogsConfiguration.destination = azure-monitor` but has **no diagnostic
setting or destination**: this does not establish persisted logs. A reviewed sink,
retention, redaction, access controls, budgets and alerts are mandatory before app
release. Third-party secret management (Key Vault/protected references and runtime
access) is also mandatory at that gate, not implemented by this foundation.

Private ingress does **not** establish outbound isolation. There is no egress
firewall/allowlist here. Future networking validation must preserve platform
DNS/resolution, Entra token acquisition and PostgreSQL's Storage backup/HA traffic,
as well as ACA platform,
registry, model, CopilotKit and approved integration connectivity. Review actual
DNS/route/port requirements before adding NSGs, UDRs or forced egress routing.
The declared PostgreSQL-subnet Storage service endpoint's necessity must be verified
for the future approved topology; its presence is not proof of backup connectivity.

### Required inputs and future deployment preflight

All inputs are required; no location, credentials or pilot identity defaults:

| Parameter                                                          | Constraint / required preflight                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `location`                                                         | Region supports ACA zone redundancy, PostgreSQL 17 HA/SKU/zones and Storage ZRS                                                 |
| `namingPrefix`                                                     | 3–10 lowercase ASCII letters/digits, starts with a letter; validate Azure naming and generated-name availability                |
| `vnetCidr`                                                         | IPv4 VNet range, compatible with existing/peered networks                                                                       |
| `acaSubnetCidr`, `postgresSubnetCidr`, `privateEndpointSubnetCidr` | Contained within VNet, mutually disjoint, correctly aligned; service minimums/capacity and reserved-range compatibility checked |
| `postgresSkuName`                                                  | Explicit GeneralPurpose SKU available with HA in **both** selected zones, with capacity/quota                                   |
| `postgresPrimaryZone`, `postgresStandbyZone`                       | Logical `1`, `2` or `3`; a compiled `fail()` guard rejects equal zones; verify both are actually supported                      |
| `entraAdminGroupObjectId`, `entraAdminGroupDisplayName`            | Matching group UUID/name in deployment tenant; verify type, membership and administrative access                                |

Bicep constrains string lengths and zone values; these are **not** CIDR parsing,
SKU discovery, UUID/type validation or provider validation. Before any separately
authorized deployment, preflight provider/API availability and registration,
zone/SKU/capacity, subnet containment/non-overlap/sizing, DNS and Entra/Storage
egress, policy, deployment privileges and narrow RBAC. Tenant ID comes only from
the deployment scope. None of that preflight has been run here.

### Local compile and compiled-contract tests (no Azure calls)

From the repository root, with a local Bicep binary and Node 22+ (no app startup
or dependency installation):

```sh
set -eu
BICEP="${BICEP:-$HOME/.azure/bin/bicep}"
mkdir -p -m 700 /tmp/opencode
ARM="$(mktemp /tmp/opencode/opendots-production-foundation.XXXXXX.json)"
trap 'rm -f "$ARM"' EXIT
"$BICEP" build infra/production/foundation.bicep --outfile "$ARM"
PRODUCTION_ARM_TEMPLATE="$ARM" node --test infra/production/foundation.check.mjs
git diff --check
```

The dedicated test **fails if `PRODUCTION_ARM_TEMPLATE` is absent**. It does not
compile Bicep, import pilot checks/operators or perform cloud operations. It
checks actual compiled resources, API pins, required inputs, dependencies, exact
security properties, object-valued nested ACA DNS template, private endpoint
association, container-scoped RBAC and the output allowlist. It also rejects additional
resources/imports, app containers and deployment scripts. Bicep 0.45.15 lacks
local types for `Microsoft.App/managedEnvironments@2026-07-01` (BCP081); that API
is pinned against current Learn schema and checked structurally, not validated
against the live provider. Tests prove **infrastructure shape only**, not network
reachability, HA/restore behavior, tenant isolation or application guarantees.

## Concrete application migration map — UNIMPLEMENTED / UNVERIFIED

PostgreSQL is asynchronous. The existing synchronous `node:sqlite` stores cannot
be migrated by changing a connection string or adding a pretend synchronous PG
adapter. This work requires its own reviewed application release.

| Existing state                                                                               | Required migration boundary                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Store` (`store.ts`): settings, tasks, runs, events, memories, setup telemetry               | Currently unpartitioned; scope schema, queries, jobs and event streams, not just task rows                                                              |
| `WorkspaceStore`: spaces, Dots, grants, thread bindings, task links, calls, captures, photos | Preserve scoped ownership/grants, stable bindings and atomic photo replacement/failure semantics                                                        |
| `Pages`: revision CAS, parent tree, idempotent review receipts, thread reservations          | Preserve CAS/conflicts, scoped parent relations and reservation races using DB constraints/transactions                                                 |
| `ConnectionStore`: plaintext MCP tokens and serialized approval arguments/results            | Encrypt/protect secret-bearing records, enforce scoped ownership/revocation and transactional action receipts                                           |
| `ComputerStore`: permissions and audit                                                       | Preserve scoped permissions, revocation and audit through async callers                                                                                 |
| CopilotKit Intelligence history                                                              | **External**, not in SQLite backup: `platform.createConversation` creates an Intelligence thread then a local binding; history uses `getThreadMessages` |

### Trusted identity and async callers

The current startup-constant `ownerId` and single bearer are **not multitenancy**.
A future authenticated `(tenant, subject)` / Entra `(tid, oid)` must map to immutable
internal tenant/owner IDs and membership. Never trust client-supplied IDs or
emails as scope. Every table, scoped parent relation, composite FK, query, cache,
job and blob prefix must carry that trusted scope, including settings and audit.
Persist a collision-free Intelligence **project + userId** mapping and preserve
legacy project/userId/thread IDs and bindings; do not automatically replace them
with new login identifiers. A login page alone does not protect media or history.

Make Hono app/workspace/page/connection/computer routes, Runner
claim/check/finish/events, agent tool closures and permission checks, page
conversation reservations, voice and setup telemetry explicitly async. Never
hold a DB transaction open across model/provider calls. Commit an atomic
**claim + run + event before external calls**. Use DB-time leases and fencing;
completion, progress and renewal must match trusted scope, state and current
lease. Revocation invalidates the old worker. Expired work requires review, not
automatic replay. Preserve page CAS, photo atomicity and thread reservations.
Separate web and worker scaling; two web replicas must not both run the current
in-process scheduler. At least two web replicas and readiness/revision rollback
gates are future targets, not resources provided here.

### Connected actions and secrets

The current action key is unique **`(threadId, toolCallId)`, not `approvalId`**;
approval lookup and action insertion are separate operations. The future design
must make one DB transaction validate scoped ownership, expiry, authorization
and immutable arguments, then consume the approval and create its receipt with
`UNIQUE(scoped approvalId)`, preserving scoped thread/tool-call uniqueness.
Commit before dispatch. A repeat returns status/result/conflict with **no new
dispatch**. Use a stable provider idempotency key only when that provider supports
it. Timeout/crash after possible dispatch means **outcome unknown**, not a safe
retry or an exactly-once promise. Database retries must not replay external actions.

Connected-action activation needs this safety gate **even on a single-owner
pilot**. Pilot acceptance must confirm zero MCP connections; absence of a
Composio key alone is insufficient. This document does not implement that gate.

Use authenticated encryption/protected references with keys outside the DB dump.
Normal exports exclude MCP tokens, reusable session handles and secret payloads
(including secret-bearing serialized arguments/results). Default to reconnecting
integrations. Restricted migration artifacts/backups must be encrypted, use an
explicit transformation/omission manifest, expire pending approvals and quarantine
in-flight outcomes. Do not move plaintext tokens into production backups.

### Cutover and required evidence

Use versioned reversible schema migrations and validated one-shot export/import.
Move photo bytes to private Blob storage with a publish/delete protocol that
does not expose unowned media or publish metadata for missing objects. Preserve
upload validation, content type/size limits and authorization-checked serving;
any short-lived URL mechanism needs separate authorization/design review with
shared keys remaining disabled. Audit old-object retention/deletion separately.

Existing test seeds are `tests/store.test.ts` (two DB connections, leases/reopen
in the **same process**), `workspace.test.ts`, `pages.test.ts` (CAS/review),
`page-service.test.ts` (same-process thread race), `dot-photo.test.ts` (atomic
replacement/failure/reopen), `connections.test.ts` (revocation/approval), and
`computer.test.ts`. There is **no backend-neutral or export/import parity suite**.
Required future tests, not covered by the compiled-foundation tests:

- Two tenants × two owners: isolation through **all** stores, scoped parents,
  blobs, caches and CopilotKit project/user/thread mappings.
- Independent-process claims, stale completion, revocation, CAS and thread
  reservation races; not merely two connections in one process.
- Approval reuse with different tool-call IDs; crashes before dispatch and after
  dispatch but before receipt; unknown outcomes must not trigger another action.
- Import table/key/reference counts, canonical content hashes, photo bytes,
  ownership/history mappings and documented omissions/transforms.
- Interrupted import and idempotent rerun; write-freeze cutover, separate restore,
  reconnect, and timed rollback **without replaying external actions**.

Rehearse in a separate verification environment, record restore/failover timing
and obtain release evidence before cutover. Do not add dual writes without an
architect-approved reconciliation design. Keep external CopilotKit history until
a separately approved migration is complete. Native Foundry Agents,
Conversations, Routines, Python orchestration, voice and computer-service
replacement are separate future work, not prerequisites for this foundation.

## Release gates — UNIMPLEMENTED / UNVERIFIED

Architect and independent cross-family review; authorized provider/network/Entra
preflight; trusted identity and all-store async migration; least-privilege SQL
runtime provisioning; third-party secret management; connected-action safety;
parity/isolation/concurrency/crash evidence; approved diagnostics/retention/cost
policy; authenticated synthetic SLO measurements and representative load tests;
verified backups, separate restore/failover, regional-DR decision and rehearsed
cutover/rollback are required before production release. Public publication is a
separate review, not an implied step or toggle. **This foundation is not a claim
of production readiness.**

Schema/network references: Context7's Azure catalog was older; current Microsoft
Learn was used for the pinned [ACA environment](https://learn.microsoft.com/azure/templates/microsoft.app/2026-07-01/managedenvironments),
[PostgreSQL server](https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/2025-08-01/flexibleservers),
[Entra administrator](https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/2025-08-01/flexibleservers/administrators),
and [Storage account](https://learn.microsoft.com/azure/templates/microsoft.storage/2025-08-01/storageaccounts)
schemas. Future preflight must also check [PostgreSQL private networking](https://learn.microsoft.com/azure/postgresql/network/concepts-networking-private),
[Entra configuration](https://learn.microsoft.com/azure/postgresql/security/security-entra-configure)
and [ACA custom VNets](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks).

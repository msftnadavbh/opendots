# Private owner backup (pilot limit)

`POST /api/backup` accepts only `{}` with JSON content type, the configured owner
token in `Authorization: Bearer …`, and a present explicitly configured `Origin`.
The fixed server database is exported in full, including private content and any
stored integration credentials. Tokenless local mode does not enable export.
Bearer possession authorizes the full export; this is not fresh human reauthentication.
There is no GUI export button. `node deployment/azure/pilot.mjs backup` verifies the live
owned VM/output binding, reads private `.env.pilot`, and downloads over trusted HTTPS
with the bearer header and configured Origin. Redirects are refused. Only a complete
file matching its length, SHA256, SQLite integrity and table manifest is published
alongside its durable manifest in the private operator backup directory.

The response is a private SQLite attachment with a byte length, whole-file SHA256,
and base64 canonical per-table manifest. Treat the file and manifest as sensitive.
Restore into an isolated local workspace and check integrity, manifest, and photos
before relying on a backup. No model, scheduler, or integration needs to start.

Ordinary `npm test` runs the safe authorization/metadata cases; filesystem-pressure,
memory-exhaustion and process-death tests require explicit
`OPENDOTS_BACKUP_TEST_SANDBOX=1` in a disposable Node24 container with exactly64MiB
tmpfs at `/tmp`. A wrong opted-in profile fails before allocation, and pressure
allocations are capped independently. CI runs this sandbox suite as a mandatory step;
do not count skipped host-only stress tests as resource-limit verification.

**Pilot capacity:** the app requires the existing Linux `/tmp` 64MiB tmpfs with at
least 32MiB currently free. The source database file and complete snapshot must fit 32MiB; data is never
omitted to fit. Larger workspaces require a separately reviewed storage design.
The tmpfs is shared, not reserved: concurrent pressure can cause a clean failure.
The worker has a20-second timeout guardian, kernel-enforced32MiB file limit,
1GiB address-space limit, 128MiB old heap, 8MiB semi-space, and no core dumps.
The full request/stream lasts at most 60 seconds; only one export runs at once,
followed by a 30-second cooldown (409 busy, 429 with Retry-After).

Jobs use private `/tmp/opendots-backup-*` directories and 0600 files. A guardian
survives HTTP-parent death and cleans up after worker completion/timeout and pipe
EOF; after successful work it waits at most 65 seconds for release. A failed
cleanup blocks exports in that process. Any leftover matching job directory
blocks exports after restart. Do not delete arbitrary `/tmp` contents: investigate
only that prefix after proving no export is running, or restart the container to
clear its tmpfs. There is no data-directory fallback or automatic orphan deletion.

Before acceptance, verify this resource profile in Azure and restore **all** real
pilot SQLite data, including photos. SQLite exports do **not** contain the external
Intelligence conversation history; preserve the project key, owner ID, and thread IDs,
and back up Intelligence separately. Fixture tests are not deployed acceptance.
The helper/worker/guardian are included in the positive build allowlist/runtime COPY.
The [Azure pilot remains on cloud HOLD](../deployment/azure/README.md); activation
requires separate authorization and the runbook's verification gates.

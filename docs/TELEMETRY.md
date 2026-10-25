# Intelligence signup and OpenDots usage tracking

OpenDots uses the CopilotKit SDK's existing telemetry transport. There is no
separate PostHog SDK or PostHog key to configure in this application.

## Configure the server

Run these commands from the OpenDots root:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

Keep both generated values in the server environment:

| Variable                   | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `CPK_INTELLIGENCE_API_KEY` | Server-only project key for persistent conversations.                                      |
| `CPK_TELEMETRY_ID`         | CLI-issued project binding that the telemetry sink can resolve to an Intelligence account. |

Deploy the values for the selected project together. Do not generate your own
telemetry ID, reuse another project's ID, or put either value in client-side
variables. An API key alone does not give runtime telemetry a resolvable identity.
If the CLI reports an identity provisioning failure, resolve that failure and
run project selection again before claiming account attribution works.

Docker Compose forwards `CPK_TELEMETRY_ID` from `.env` into the app container.
For other deployment environments, copy the CLI-generated identity and its
matching project key into the server environment, then restart the server.
Keep the identity server-side. Leave `OWNER_ID` and conversation/thread IDs
unchanged; they scope app data and are not the signup account identity.

The SDK sends existing runtime events to
`https://telemetry.copilotkit.ai/ingest`. OpenDots adds
`accessibility_title: "OpenDots"`. The current SDK defaults to full sampling
(`1`), and Docker Compose uses the same default. An explicit
`COPILOTKIT_TELEMETRY_SAMPLE_RATE` override is respected.

CopilotKit runtime and browser setup telemetry are enabled by default.
To opt out, set either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`
and restart the API. Both variables accept `true` or `1`. The `npm test` command disables telemetry for ordinary automated fixtures.

## What the events measure

- `intelligence_signup`: an Intelligence account created in Clerk, emitted by
  the existing backend sync with the Clerk user ID as its PostHog `distinct_id`.
- `oss.runtime.instance_created`: the OpenDots runtime handler was created.
- `oss.runtime.copilot_request_created`: a request reached the runtime; this is
  usage evidence, not proof of a successful model answer.

The sink enriches runtime events with `telemetry_id`, and with `clerk_user_id`
when that identity resolves. Runtime and signup events can have different
PostHog `distinct_id` values: join the runtime `clerk_user_id` property to the
signup `distinct_id` rather than assuming a standard person funnel joins them.

This connects completed signups to OpenDots usage. It does not prove OpenDots
was the acquisition source: the account might predate OpenDots. Measuring
acquisition requires carrying a source through the Intelligence signup flow.
OpenDots does not emit a duplicate signup event on startup, login or key entry.

## Validate in PostHog

Delivery and account attribution require access to the telemetry recipient's
PostHog reporting environment; running OpenDots does not grant that access.
With authorization, restart the API, make one chat request, and run:

```sql
SELECT event, timestamp, distinct_id,
       properties.accessibility_title AS app,
       properties.telemetry_id AS telemetry_id,
       properties.clerk_user_id AS clerk_user_id
FROM events
WHERE event IN (
    'oss.runtime.instance_created',
    'oss.runtime.copilot_request_created'
  )
  AND properties.accessibility_title = 'OpenDots'
  AND timestamp >= now() - INTERVAL 1 DAY
ORDER BY timestamp DESC
LIMIT 20
```

Confirm the tag, the expected telemetry identity and the resolved Clerk subject.
Then find that subject's `intelligence_signup` event. To count accounts signed
up in the last 30 days that also used OpenDots in that period:

Run the saved [signup-account query](telemetry/opendots-signups.hogql.sql).
It joins requests to signup accounts by Clerk ID. If a request lacks Clerk
enrichment, it uses the latest resolved startup/runtime event with the same
telemetry identity in the reporting window. This avoids assuming every request
has a resolved account, and avoids joining unrelated installations by IP or
PostHog person ID. The [daily usage query](telemetry/opendots-usage.hogql.sql)
uses the same identity lookup. Both queries exclude marked validation events
from requests and identity lookups.

An HTTP `202` from ingest alone does not prove PostHog delivery. If the event
or identity enrichment is missing, check the deployed server configuration without
printing credentials, then ask the telemetry service owner to inspect ingestion
and identity resolution. Do not infer downstream delivery from local tests.

## Local verification

`npm test` disables production telemetry for ordinary fixtures. The telemetry
tests start fresh processes, intercept SDK fetch calls before importing it,
and check the OpenDots tag, CLI-issued identity header, full sampling, explicit
sampling override, both opt-outs and absence of the project key in the payload.
These checks cover the local SDK contract; production delivery and identity
resolution require the PostHog checks above. Validate a new external signup
separately rather than inferring it from an existing account's runtime event.

Ask the reporting owner to add the OpenDots filter and Clerk-ID join to
its reporting rule. The query counts signup accounts associated with usage,
not signups caused by the template. Local Intelligence evaluation also requires
CopilotKit sign-in, but a runtime event by itself does not establish a new signup.

## Reporting queries and setup identity

The saved [signup-account query](telemetry/opendots-signups.hogql.sql) and
[daily usage query](telemetry/opendots-usage.hogql.sql) exclude marked validation
probes. The [setup-event query](telemetry/opendots-setup.hogql.sql) and
[installation conversion query](telemetry/opendots-setup-conversion.hogql.sql)
report the [browser setup flow](SETUP-TELEMETRY.md). Request counts are attempts,
including requests rejected by the SDK; they are not successful answers. Validate
queries and reporting permissions in the recipient's environment before relying
on a report.

Setup events do not receive Clerk account enrichment from the shared fanout;
only the two exact runtime event types above do. Join setup and runtime by their
shared `installation_id` to associate setup with account-resolved usage. The
runtime continues to use the CLI identity as its transport identity when present;
otherwise it uses the persistent random installation identity. See
[Browser setup telemetry](SETUP-TELEMETRY.md) for collected metadata, queue retention,
and opt-out cleanup.

A request can retain telemetry identity without Clerk enrichment. The reporting
queries therefore use the same-identity startup lookup. A missing request Clerk
ID alone is not evidence that OpenDots lost its identity. The shared sink's
identity resolution is separate from this application's transport wiring.

## Optional Azure Monitor spans

Setting `APPLICATIONINSIGHTS_CONNECTION_STRING` enables a separate Azure Monitor
trace exporter. It sends `agent.turn` spans to the configured Application Insights
destination with channel and outcome attributes and service name `opendots-pilot`.
These application spans do not collect prompts, answers, tool payloads, HTTP
request logs, or credentials. Offline exporter storage is disabled.

The pinned exporter (`1.0.0-beta.46`) also sends Statsbeat to Microsoft's separate
diagnostic store, including resource identifiers, OS/runtime and SDK versions,
and ingestion endpoint health metadata. Customer SDK-stats metrics (telemetry
success/drop/retry counts) go to the configured Application Insights destination.
The SDK also polls remote settings at `https://settings.sdk.monitor.azure.com`,
with an hourly refresh by default; the service and error backoff can adjust it.

For this version, `APPLICATION_INSIGHTS_NO_STATSBEAT=1` disables Statsbeat and
SDK-stats metrics; `APPLICATIONINSIGHTS_SDKSTATS_DISABLED=true` disables SDK-stats
metrics alone. Neither flag stops remote-settings polling. Restart after changes.

This exporter is independent of CopilotKit telemetry: `DO_NOT_TRACK` and
`COPILOTKIT_TELEMETRY_DISABLED` do not control it. Leave
`APPLICATIONINSIGHTS_CONNECTION_STRING` unset and restart to avoid exporter
initialization and all of its spans, SDK diagnostics, and settings traffic.

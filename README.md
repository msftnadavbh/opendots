# OpenDots

A self-hosted workspace for personal AI agents, documents, and conversations.
Organize work in Spaces, give specialist Dots their own instructions and tools,
and review their work in chat.

This is an independent derivative of [CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots),
maintained at [msftnadavbh/opendots](https://github.com/msftnadavbh/opendots).
It uses [CopilotKit](https://github.com/CopilotKit/CopilotKit),
[AG-UI](https://docs.ag-ui.com/introduction), and TanStack AI; it is not an official
CopilotKit, OpenAI, or Microsoft product.

## Quickstart

Use **Node.js 24** and **npm**:

```sh
git clone https://github.com/msftnadavbh/opendots.git
cd opendots
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. You can create Spaces, write pages, and configure
Dots before connecting conversation services.

Chat requires **CopilotKit Intelligence and a model provider**. Follow
[Setup](docs/SETUP.md#conversation-services) to choose hosted Intelligence, local
Docker evaluation, or licensed self-hosting, then configure the app's model and
restart the server. Do not run `copilotkit onboard` here: the integration already
exists. Keep credentials in the server environment, never in source or client-side
variables.

## Features

- **Spaces and pages:** searchable libraries, nested pages, a visual editor with
  slash commands, Markdown source mode, autosave, and stale-edit protection.
  Manual editing works without conversation credentials.
- **Specialist Dots:** names, role instructions, Space access, default page
  destinations, tool permissions, and custom photos.
- **Conversations:** persistent Intelligence Threads, page-specific chat with
  authorized page context, source links, and save-to-page actions.
- **Review and connections:** approve or decline a draft before saving; configure
  per-Dot MCP tools with owner approval for non-read-only actions. See
  [Connections](docs/CONNECTIONS.md).
- **Research and computers:** public-web research through Parallel by default;
  optional per-Dot OpenBot computers with persistent browser profiles, files,
  shell permissions, and human takeover. See [Computer setup](docs/COMPUTERS.md).
- **Connected apps:** optional Composio email, calendar, and other integrations,
  enabled globally and per Dot. These act on real accounts; restrict toolkits and
  start with read-only requests on a test account. A blank toolkit list permits
  every toolkit in the Composio project. See [Composio setup](docs/SETUP.md#composio).
- **Calls and Slack:** separately configured realtime speech with delegated
  compute, call controls and receipts, plus managed Slack threads with explicit
  workspace/user allowlists. See [Calls](docs/SETUP.md#calls) and
  [Slack](docs/SETUP.md#slack).
- **Background work and memory:** scheduled turns in their original conversations,
  user-managed preferences, and optional per-Dot
  [Automatic Learning](docs/SETUP.md#automatic-learning). Published skills require
  review in Intelligence; existing conversations are not enrolled retroactively.

  Scheduled runs interrupted by a worker stop or expired lease wait for explicit
  **Retry after review**. Inspect saved pages and computer actions first: effects
  may already be present even if a run has no final result.

- **Appearance:** system, light, and dark themes.

### Dot photos

Open an existing Dot's settings to replace or remove its photo. Photo changes save
immediately, separately from name/instructions, without interrupting active work.
Choose a JPEG or PNG up to 10 MiB; the browser fits it within 512 × 512 on white
and encodes JPEG. The server decodes and re-encodes it with Sharp, strips metadata,
and stores at most 256 KiB in SQLite. Photos use the workspace's owner authentication
and are cached only in memory for the current authenticated app session. Removing
a photo restores the mascot.

## Data and privacy

- **Conversation storage:** messages, tool calls, and run events live in your
  configured Intelligence deployment, not in a standalone SQLite conversation
  store. Hosted Intelligence sends them to CopilotKit's cloud; local evaluation
  runs Intelligence on your machine. SQLite separately stores pages, workspace
  metadata, photos, thread bindings, plaintext MCP connection tokens, and saved
  tool arguments/results. Treat the database and backups as sensitive; back up
  both storage layers.
- **Model context:** the configured model provider receives conversation context,
  including authorized page content and tool results. Local Intelligence does not
  make a remote model local. Configure the app's model and the Automatic Learning
  model separately.
- **Enabled services:** public-web research sends queries and selected URLs to
  Parallel by default; see [Public-web research](#public-web-research). MCP tools,
  computers, Composio connected apps, speech, and messaging send data to their
  configured services when used. Composio tool arguments and results pass through
  both Composio and the connected app provider. Keep `OWNER_ID` stable after
  connecting accounts.
- **Default telemetry:** CopilotKit SDK usage metadata and bounded browser setup
  events are enabled by default, separately from conversation storage. Setup
  events include a random installation ID and first successful assistant
  activation. Set `DO_NOT_TRACK=1` or `COPILOTKIT_TELEMETRY_DISABLED=true` and restart
  to disable this tracking and purge pending setup events. Optional Azure Monitor
  spans and SDK diagnostics/settings traffic are controlled separately; leave
  `APPLICATIONINSIGHTS_CONNECTION_STRING` unset to avoid initializing that exporter.
  See [Azure Monitor telemetry](docs/TELEMETRY.md#optional-azure-monitor-spans) and
  [Browser setup telemetry](docs/SETUP-TELEMETRY.md).

Review [CopilotKit's privacy policy](https://www.copilotkit.ai/privacy-policy) and
each configured service's privacy and retention settings. Installing or renewing
local Intelligence still requires CopilotKit sign-in and internet access.

## Public-web research

Parallel is the default provider for live research and Dot conversations. Ask a
topic-only question to discover and read up to five sources, or supply URLs to
extract directly. Sources retain their links; this path does not require a browser
worker. Workspace and Dot research permissions, pause, and cancellation still apply.
Sample research is fictional and does not contact a provider.

Queries, requested URLs, a stable session identifier, and the research objective
are sent to `https://search.parallel.ai/mcp`. Memories and complete conversations
are not automatically forwarded, but model-selected objectives may contain
conversation context. Anonymous usage has provider-managed limits; configure
`PARALLEL_API_KEY` server-side for production or higher limits. Errors and empty
results are reported, not replaced with invented evidence.

Set `WEB_SEARCH_PROVIDER=disabled` to disable these research tools, or
`WEB_SEARCH_PROVIDER=browser` for the URL-only public-page reader. See
[Browser tool setup](docs/SETUP.md#browser-tool).

## Documentation

- [Setup and configuration](docs/SETUP.md)
- [Dot computers](docs/COMPUTERS.md) and [MCP connections](docs/CONNECTIONS.md)
- [Telemetry and identity](docs/TELEMETRY.md)
- [Private owner backup](docs/private-backup.md)
- [Azure pilot runbook](deployment/azure/README.md) and
  [production preparation](docs/AZURE-PRODUCTION.md)
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md)

## Development

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. They do not establish live model,
Intelligence, Slack, voice, or Azure readiness; verify your own configured services.
Backup pressure/process-death tests require the disposable container described in
[Private owner backup](docs/private-backup.md), not the operator host.

## Status

**Experimental, single-owner software.** Shared editing, invitations, file
attachments, interactive page embeds, multi-Dot group conversations, and automatic
delegation are not implemented. Schedules are recurring instructions, not a
complete goal or event-trigger system.

The Azure pilot is on **cloud HOLD and has not been activated**. Production
application migration remains unimplemented. The pilot operator has a fixed
executable scope and requires separate authorization; it is not a general-purpose
deployment command or a claim of cloud readiness.

## License

[MIT](LICENSE). Derived from CopilotKit/OpenDots; the original copyright notice
for Atai Barkai is preserved. See [LICENSE](LICENSE) for the full terms.

# Loom Temporal TypeScript pilot

The pilot runs beside the existing Loom application. It uses a separate
webhook listener, Temporal task queue, workspace and SQLite artifact database.
Use an isolated GitHub repository and an App installed only on that repository.
The production Controller and Python Worker are outside the pilot routing.

## Run the tests

From this directory with Node 22.13 or newer:

```bash
npm ci
npm test
```

The workflow test starts a disposable Temporal development server through the
SDK. It downloads the Temporal CLI if necessary. The test uses simulated
GitHub and OpenCode Activities. It covers two Issues, a Worker restart while
waiting for approval, feedback and old approval, explicit publication
authorization, and CI matching. It uses transient test persistence.

## Run an isolated pilot

1. Start an isolated Temporal service and set `TEMPORAL_ADDRESS`,
   `TEMPORAL_NAMESPACE` and `LOOM_TEMPORAL_QUEUE` as needed. The default
   local address is `127.0.0.1:7233`. Use an isolated PostgreSQL-backed
   Temporal service when testing server restart and operational recovery.
2. Set `LOOM_TEMPORAL_REPOSITORY` to the test repository. The configured
   GitHub App resolves its bot account from GitHub and validates its numeric
   account ID when posting or recovering comments.
   Provide the App settings at the absolute `LOOM_GITHUB_APP_CONFIG` path.
   Use the existing Loom App JSON shape with a private PEM.
3. Set `LOOM_TEMPORAL_PROFILES` to an absolute JSON path mapping Issue
   numbers to approved existing files. Set separate absolute directories
   for `LOOM_TEMPORAL_WORKSPACE` and `LOOM_TEMPORAL_DATA`.
   Provide the webhook secret via `GITHUB_WEBHOOK_SECRET_FILE`.
4. Build with `npm run build`, then run `npm run pilot:controller` and
   `npm run pilot:worker`. The Controller listens on loopback port 8788 by
   default. Route only the isolated repository webhook to
   `/webhooks/github` and subscribe to Issues, Issue comments, and Workflow
   runs. The Worker expects the Loom OpenCode sandbox image and an internal
   Docker network with the AgentGateway alias `gateway`. The model is
   configurable through `LOOM_AGENT_DEFAULT_MODEL`.
5. Queue an existing configured Issue with
   `npm run pilot:start -- <Issue number>`, or deliver a signed opened event
   for a configured Issue. Iterate with `@loom <feedback>`, then approve
   the current version with `@loom 通过`. Apply `loom:publish` as a
   repository collaborator when ready to publish. The pilot CI receiver
   accepts the configured Loom PR validation workflow and checks the PR
   number and commit against its draft receipt.
6. To display Activity inputs, outputs, and retry attempts in the existing
   Console, point `LOOM_TEMPORAL_CONSOLE_DB` to the pilot's `pilot.sqlite`
   and give the Console read access. Artifact references are hashes. Keep
   the underlying artifact directory private to the pilot user.

The pilot Worker uses bounded Activity concurrency. The existing Console
controls continue to manage the original Worker registry. Connecting personal
Worker creation, pause, and drain to Temporal queues is a separate integration
step before switching production routing.

# Loom production pipeline

The workflow validates proposed changes without deployment credentials. A push to
`main` starts production deployment after validation. A maintainer can rerun
the workflow on `main` if a running task deferred rollout.

The initial rollout manages the Controller, Worker and console on the existing
loom host. Their SQLite database, systemd policy drop-ins, and credential
files stay on the host. Routing and base infrastructure (Caddy, AgentGateway,
MCP and the base sandbox image) are administered separately.

## One-time provisioning

1. Review and merge this pipeline through a PR in `LeeJim/loom`. Require PR
   review and the CI check on `main`, then create a GitHub Actions environment
   named `production` limited to `main`.
2. In the server's trusted administrative console, create a dedicated
   `loom-deploy` SSH account with a valid shell and no general sudo access.
   Install the reviewed `deploy/receive.sh` as `/usr/local/sbin/loom-release`
   owned by root and mode 0755. Keep this entry point root-owned.
3. Add the dedicated CI key's public key to that account's `authorized_keys`
   with options `restrict,command="sudo -n /usr/local/sbin/loom-release"`.
   Install the following rule using `visudo` in a dedicated sudoers drop-in:

   ```sudoers
   loom-deploy ALL=(root) NOPASSWD: /usr/local/sbin/loom-release ""
   ```

   This grants only the fixed entry point with no arguments. It takes the
   requested SHA on stdin, fetches Loom directly, and requires the SHA to be
   the current tip of `main`.
4. Set `LOOM_DEPLOY_SSH_KEY` as a `production` environment secret. Add
   `LOOM_DEPLOY_HOST` and `LOOM_DEPLOY_KNOWN_HOST` as environment variables.
   The known-host value is a complete OpenSSH known_hosts line from the
   trusted server console for the exact host name in `LOOM_DEPLOY_HOST`.
   Ensure GitHub-hosted runners can reach the configured SSH endpoint.
5. Run **Loom CI and deploy** against `main` and confirm the Actions log
   shows the intended SHA plus successful Controller and console health
   checks. Normal future deployments are triggered by merging PRs.

On failed health checks, the rollout restores the prior Controller and service
overrides. If a workflow execution is active, it exits before changing the
running services. The server retains the release source keyed by commit SHA.

## Console GitHub OAuth

Create a GitHub OAuth App with the Console URL as its homepage and
`https://ai.anyhub.cn/console/oauth/callback` as its authorization callback.
Provide `LOOM_GITHUB_OAUTH_CLIENT_ID` and `LOOM_GITHUB_OAUTH_CLIENT_SECRET`
through a protected environment file for `loom-console.service`. If using a
different HTTPS hostname, set `LOOM_CONSOLE_ORIGIN` to that origin and update
the OAuth callback and Caddy hostname to match.

The Console lets GitHub users with write access to the target repository sign
in. Worker management is scoped to the authenticated user's GitHub ID. The
Console does not retain GitHub user access tokens after login. Sessions expire
after one hour or when the Console restarts.

Install the updated Caddy configuration separately from application rollout.
Test the OAuth callback through Caddy after configuring the service. Public
Console data requires an OAuth session. The loopback snapshot remains available
to the local rollout health check.

## Worker and capability configuration

One supervisor per host manages the workers created in Console. Set
`LOOM_MAX_PARALLEL_WORKERS` on `loom-worker.service` to cap active Issue
claims. The default is two. Each Issue can have only one active claim.
Until the first Console Worker is created, the supervisor runs the existing
execution profiles through an implicit Worker. After creating a Worker, start
it in Console to process those profiles. An Issue-specific Worker must select
an existing profile.

Set `LOOM_GATEWAY_STATUS_URL` on the Console service to the gateway's OpenAI
API base URL. It defaults to `http://127.0.0.1:4000/v1`. Set
`LOOM_MCP_STATUS_URL` to the full private MCP gateway endpoint reachable from
the Console service, for example `http://127.0.0.1:3000/mcp` when an
operator has configured a loopback listener. OpenCode uses the sandbox
gateway at `http://gateway:4000/v1` by default. Keep its sandbox network
internal and keep upstream model credentials on the gateway.

For SkillHub, set `LOOM_SKILLHUB_CATALOG` on the Console service to an
operator-configured HTTPS endpoint or local JSON manifest. The catalog
accepts `{"skills":[{"id":"example","version":"1.0","description":"Example skill"}]}`.
If the endpoint requires a bearer token, set `LOOM_SKILLHUB_TOKEN` in the
protected environment file. Install reviewed, pinned versions at
`<skills-directory>/<id>/<version>/SKILL.md`. The skills directory defaults
to `/opt/loom/skills`; use the same `LOOM_SKILLHUB_SKILLS_DIR` on both
services if you change it. Only installed versions can be assigned to a
Worker, and they are mounted read-only.

## Console runtime

Rollout builds the React Console and Node.js service through `console/Dockerfile`.
The release includes the Node.js runtime and compiled application. The
deployment checks that runtime before changing the Controller or service
overrides. The Console continues to bind to loopback on port 8790 and
use the existing SQLite database.

To run the Console locally with Node.js 22.13 or newer:

```bash
npm ci --prefix console
npm run build --prefix console
LOOM_DB=/absolute/path/to/workflow.sqlite npm start --prefix console
```

Open `http://127.0.0.1:8790/console/`. The same build also works through
Caddy's existing `handle_path /console/*` route. Worker management uses
the configured GitHub OAuth credentials.

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

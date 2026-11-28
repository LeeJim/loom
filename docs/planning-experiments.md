# Planning Agent comparisons

The first comparison uses two pinned configurations and up to 12 paired cases.
Use two OpenCode configurations for prompt comparisons, or OpenCode and Pi
with the same model for a harness comparison. The runner stores an immutable
SHA-256 snapshot before starting a Temporal execution. Running the same
snapshot with the same run key retrieves the same workflow result. Use a new
run key for an independent repetition.

## Isolated setup

- Use a dedicated Temporal namespace and internal Docker network with only
  the experiment AgentGateway available as `gateway:4000`.
- Supply immutable image references as `repository@sha256:...`. OpenCode
  uses the existing sandbox entrypoint. The Pi image must provide
  `pi` and `/bin/sh`, and permit UID 1000 to execute them. Use a Pi build
  supporting JSON mode, custom models, and the documented discovery-disabling
  flags. The build defaults to Pi 1.7.0. To build it with an empty context:
  `docker build -t <registry>/loom-pi - < temporal/pi.Dockerfile`. Push it to
  the experiment registry and use its digest in the manifest.
- Include only approved, redacted snapshot text. Do not supply production
  credentials or Git working directories. The worker creates a fresh read-only
  mount from each case's selected file contents.
- Set the absolute directories `LOOM_EXPERIMENT_DATA` and
  `LOOM_EXPERIMENT_WORKSPACE`, and set `LOOM_EXPERIMENT_NETWORK` if needed.
  Connect to the isolated Temporal instance with `TEMPORAL_ADDRESS` and
  `TEMPORAL_NAMESPACE`.
- With Node 22.13 or newer, run `npm ci --prefix temporal`,
  `npm run build --prefix temporal`, then
  `npm run experiment --prefix temporal -- /absolute/manifest.json run-1`.

## Manifest shape

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "variants": [
    {"id":"baseline","harness":"opencode","image":"registry/opencode@sha256:<64 hex digits>","prompt":"Draft a concise plan."},
    {"id":"candidate","harness":"pi","image":"registry/pi@sha256:<64 hex digits>","prompt":"Draft a concise plan."}
  ],
  "cases": [
    {
      "id":"counter",
      "scenario":"clear",
      "base":"1111111111111111111111111111111111111111",
      "issue":"Plan how to increment the counter by two.",
      "files":{"counter.js":"export const step = 1;"},
      "expected":"proposed"
    }
  ]
}
```

The deterministic score checks the expected status, evidence quotes, file
scope and required plan sections. Evidence is matched to the supplied file
bytes. A human review is needed for semantic correctness and overall plan
quality. Unavailable harnesses are reported as execution failures.

The report and artifact references are stored in `experiments.sqlite` and the
sibling `artifacts` directory. To display reports, grant Console read access
to the SQLite database and its WAL, then set `LOOM_EXPERIMENT_CONSOLE_DB`.
The Console uses its existing authentication and shows results by case and
variant. Starting experiments is an operator command in this iteration.

## Differences to record

The OpenCode baseline uses its read, glob and grep tools. The Pi candidate
uses only read. Record this difference when interpreting harness comparisons.
This runner accepts at most 12 cases, dispatches one pair at a time, and limits
each sandbox to four minutes. The report captures wall time and deterministic
checks. Provider token usage, monetary budgets, configurable worker ownership,
and RSI promotion are follow-up work.

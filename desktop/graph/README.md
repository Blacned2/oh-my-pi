# Kostomp Graph development

The [implementation plan](../docs/kostomp-graph-plan.md) defines the workflow and release gates. Graph modules live under `desktop/graph/` and use the existing OMP RPC and package interfaces. The Desktop Graph dialog starts a separate sidecar and leaves chat on its existing RPC bridge.

## Run from Desktop

Use a full Desktop build with the bundled OMP runtime. Create `graph/profile.json` under the app data directory, normally `%APPDATA%\dev.kostomp.desktop`. The sidecar reports the exact path when the profile is missing. Set a model provider and model ID plus a host-approved Docker profile. A profile looks like this with local values substituted.

```json
{
	"provider": "your-provider",
	"model": "your-model",
	"tester": {
		"dockerPath": "C:\\path\\to\\docker.exe",
		"imageId": "sha256:<local-image-id>",
		"command": ["/absolute/path/to/test-runner", "test"],
		"timeoutMs": 60000
	}
}
```

Provision the model and credentials in `graph/profile-home/.omp/agent/` using the normal OMP profile files. Every worker uses that private profile in a separate headless process. The Graph dialog accepts a clean checkout, an objective and up to 32 approved repository-relative file paths.

**Propose plan** runs a Planner that reads the approved files and proposes Coder tasks with dependencies and per-task file ownership. The host admits a proposal only if every written path is an approved spelling, each file has one owner, dependencies name existing tasks and form no cycle, and no path collides on Windows by case, Unicode form, directory overlap, an 8.3 short name or a differently spelled file in the pinned tree. A rejected proposal is returned to the Planner for correction. The dialog shows the admitted plan. No Coder runs until you choose **Approve and run**. Approval names the exact plan shown. The host rejects it if the plan, `profile.json` settings or source commit changed, then saves the plan and its hash with the run. **Discard plan** drops the proposal and **Cancel** stops planning or the active run.

Each Coder may change only its own files and reads the approved files from the pinned base plus the changes of the tasks it depends on. Tasks run one at a time in dependency order. The host composes all task changes into one candidate. Docker tests it, a separate Reviewer inspects the same tree, and **Show verified patch** rechecks the source commit and checkout before displaying the patch and base SHA for manual use.

**Recent runs** reopens saved runs after the sidecar restarts, including runs created with the earlier fixed single-Coder plan. **Retry node** reruns one eligible step. Steps downstream rerun only when their input artifacts change. **Continue queued work** resumes eligible work after an interruption. A run allows up to three attempts per node and set of inputs. Retries require the original clean base and matching `profile.json` settings. Older snapshots without a saved execution context can be inspected in the history.

## Current contracts

| Module             | Contract                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omp-worker.ts`    | Runs one headless RPC attempt from an empty, host-owned directory and a separate home. Success requires the selected model, registered host tools, a completed prompt and session settlement. Cancellation stops the process tree. Host tools own input and output validation. |
| `plan.ts`          | Validates the versioned node graph before admission and orders prerequisites before dependents.                                                                                                                                                                                |
| `task-plan.ts`     | Admits a proposed task plan against the approved scope, hashes the approved plan and derives the node graph. A Coder node receives every transitive prerequisite's change set; test, review and release receive all Coder artifacts.                                       |
| `run-store.ts`     | Persists attempts, artifacts and a monotonic event sequence in SQLite. Call `currentArtifacts()` for dependency-valid results. The snapshot's node status describes the latest attempt, which may be waiting on a retried upstream node.                                       |
| `scheduler.ts`     | Drives ready work to quiescence, serializes Coder attempts within a run and passes cancellation to the executor. Use one driver per run. After exclusive ownership is acquired on restart and old workers have stopped, call `recoverInterrupted()` before dispatch.           |
| `failure-judge.ts` | Produces an opt-in Jev observation from a provider-approved error summary. The scheduler and release gate do not consume the observation yet.                                                                                                                                  |

The workspace layer in `workspace.ts` pins a clean SHA-1 Git checkout in an independent object database. It applies declared changes to private indexes, verifies actual paths and blob IDs, and serves exact candidate blobs for review. Release requires a successful test and an accepted review for the same candidate tree. A changed source yields `stale_base`.

## Verification

From the repository root, run:

```powershell
bun test desktop/graph/test
bun check --no-script -p desktop/graph/tsconfig.json
bun x oxlint desktop/graph desktop/ui/graph.js
bun x oxfmt --check "desktop/graph/**/*.ts"
cargo check --manifest-path desktop/Cargo.toml
bun desktop/graph/smoke/omp-worker.ts
bun desktop/graph/smoke/graph-service.ts sha256:<local-image-id>
```

Both smoke probes default to `desktop/target/release/runtime`. The worker probe takes another staged runtime directory as the first argument and optionally a different CLI entry point as the second. The mock provider listens on `127.0.0.1` and uses a fixture credential. The worker probe checks a completed host call, a denied target, the exact tools on the wire and cancellation of a launcher with an OMP child. It needs local loopback permission.

The service probe drives the sidecar over its stdin protocol with the mock model and real Docker. It checks that an out-of-scope plan is returned to the Planner, that no run exists before approval and that approval with a stale plan hash fails. It then covers the verified patch, restart, targeted retry and stale source. The image must declare no volumes.

The workspace tests use disposable Git repositories and compare the source index before and after composition. They require a temporary directory where Windows permits Git's atomic index-lock replacement.

## Tester backend

`testCandidateInDocker()` uses the local Docker Desktop Linux engine on Windows. A host-approved profile supplies a preloaded image ID, an absolute container command and a timeout. The image needs `/bin/sh`, `tar`, `xargs` and the project's test runtime. The host never pulls an image during a test. Images with declared volumes are rejected.

The host reads a fresh private Git index for the candidate's file modes and sends only tracked candidate bytes over standard input. Tests receive no host mounts or Docker socket and run with no external network, a read-only container root and writable per-container temporary directories. The snapshot accepts up to 8,192 regular tracked files and 64 MiB of file data. It rejects symlinks and submodules, including unchanged entries. The host binds the container exit code to the tested tree and removes the container before reporting evidence. [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [Git index format](https://git-scm.com/docs/gitformat-index)

Run the standalone smoke probe with the ID of a suitable local image.

```powershell
bun desktop/graph/smoke/docker-tester.ts sha256:<local-image-id>
```

The probe exercises an executable tracked file, attempted access to disposable source and other-run files, a nonzero exit, release gating and cancellation of a live container. It requires access to the local Docker Desktop named pipe.

## Next integration boundaries

- **Parallel Coders** can build on the approved per-task ownership. The scheduler still serializes Coder attempts within a run. Keep the host ownership checks before dispatch.
- **Tester profiles and logs** can build on the host-approved profile consumed by `service.ts`. The workflow stores the candidate tree and exit code as stable evidence. Raw logs stay with the test executor. Sanitize them before display or external classification.
- **Jev** can be added after the Tester produces a sanitized summary. Keep the initial integration in observation mode and record the returned result with its attempt. Verify hosted credentials and data policy before enabling it in a Desktop build.

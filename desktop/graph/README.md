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

Provision the model and credentials in `graph/profile-home/.omp/agent/` using the normal OMP profile files. Each worker attempt runs headless in its own process with a private copy of that directory, which is deleted afterwards. The source profile is never written, so a token refreshed during an attempt is not saved back. API-key profiles are unaffected. The optional `"maxCoders"` field (an integer from 1 to 4, default 2) limits how many Coders run at once. The Graph dialog accepts a clean checkout, an objective and up to 32 approved repository-relative file paths.

**Propose plan** runs a Planner that reads the approved files and proposes Coder tasks with dependencies and per-task file ownership. The host admits a proposal only if every written path is an approved spelling, each file has one owner, dependencies name existing tasks and form no cycle, and no path collides on Windows by case, Unicode form, directory overlap, an 8.3 short name or a differently spelled file in the pinned tree. A rejected proposal is returned to the Planner for correction. The dialog shows the admitted plan. No Coder runs until you choose **Approve and run**. Approval names the exact plan shown. The host rejects it if the plan, `profile.json` settings or source commit changed, then saves the plan and its hash with the run. **Discard plan** drops the proposal and **Cancel** stops planning or the active run.

Each Coder may change only its own files and reads the approved files from the pinned base plus the changes of the tasks it depends on. Coders whose tasks do not depend on each other run at the same time, up to `maxCoders`. Before each dispatch the host rebuilds every write scope from the saved tasks and holds back a Coder whose files collide with a running Coder on Windows. Runs saved before planning keep one Coder at a time. The host composes all task changes into one candidate. Docker tests it, a separate Reviewer inspects the same tree, and **Show verified patch** rechecks the source commit and checkout before displaying the patch and base SHA for manual use. **Cancel** stops every running worker. The sidecar runs one plan or run at a time.

**Recent runs** reopens saved runs after the sidecar restarts, including runs created with the earlier fixed single-Coder plan. **Retry node** reruns one eligible step. Steps downstream rerun only when their input artifacts change. **Continue queued work** resumes eligible work after an interruption. A run allows up to three attempts per node and set of inputs. Retries require the original clean base and matching `profile.json` settings. Older snapshots without a saved execution context can be inspected in the history.

**Show log** displays the output of a step's latest attempt. Today only the Tester records one: its exit code, run time, stdout and stderr, each stream capped at 64 KiB by the Docker backend. ANSI sequences and control characters are removed before the log is saved. Logs are stored per attempt beside the run, survive a sidecar restart, and are not artifacts: a retried test with new output but the same exit code does not rerun review or release. A log from an interrupted or cancelled attempt is discarded.

## Current contracts

| Module             | Contract                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omp-worker.ts`    | Runs one headless RPC attempt from an empty, host-owned directory and a separate home. Success requires the selected model, registered host tools, a completed prompt and session settlement. Cancellation stops the process tree. Host tools own input and output validation. |
| `plan.ts`          | Validates the versioned node graph before admission and orders prerequisites before dependents.                                                                                                                                                                                |
| `task-plan.ts`     | Admits a proposed task plan against the approved scope, hashes the approved plan and derives the node graph. A Coder node receives every transitive prerequisite's change set; test, review and release receive all Coder artifacts.                                       |
| `run-store.ts`     | Persists attempts, artifacts, display logs and a monotonic event sequence in SQLite. Call `currentArtifacts()` for dependency-valid results. `claimReady()` admits a Coder only when its approved write scope is disjoint from every running Coder; without approved tasks, Coders run one at a time. `recordLog()` accepts a log only from the live attempt, and `log()` returns the latest attempt's log. The snapshot's node status describes the latest attempt, which may be waiting on a retried upstream node. |
| `scheduler.ts`     | Drives ready work to quiescence up to the given concurrency and passes cancellation to every running executor. Use one driver per run. After exclusive ownership is acquired on restart and old workers have stopped, call `recoverInterrupted()` before dispatch.                     |
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

The service probe drives the sidecar over its stdin protocol with the mock model and real Docker, using a JWT-refresh plan: one task owns the API contract and the backend and frontend tasks depend on it. It checks that an out-of-scope plan is returned to the Planner, that no run exists before approval, that approval with a stale plan hash fails and that a second plan is rejected while the run is active. The mock model holds the backend and frontend Coders until both have started, which proves they ran at the same time, and checks that both read the contract from the upstream candidate. The test command writes colored stdout and a stderr line; the probe reads the test log back without ANSI sequences, before and after a sidecar restart. It then covers the verified patch, a backend retry with the same result that reruns nothing downstream, and the stale source. The image must declare no volumes.

The workspace tests use disposable Git repositories and compare the source index before and after composition. They require a temporary directory where Windows permits Git's atomic index-lock replacement.

### Packaged Desktop check

The packaged runtime loads the native addon only when its version matches the checkout. Development runs warn about a mismatch, but a packaged sidecar exits before responding. Rebuild the addon with `bun run build:native` after a version bump. On this toolchain, CMake selects Ninja, so put a `ninja.exe` on `PATH` for that command, for example the one in Visual Studio Build Tools under `Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/stage-runtime.ps1 -NoStats
cd desktop; bunx @tauri-apps/cli@2 build --no-bundle; cd ..
```

`--no-bundle` leaves the version, installer and local update folder unchanged. A second instance can run beside an open Kostomp when it gets its own WebView2 profile. A debugging port lets a CDP client inspect the dialog.

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\kostomp-graph-visual-webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
desktop\target\release\kostomp-desktop.exe
```

Both instances share `%APPDATA%\dev.kostomp.desktop`. Point the Graph profile at a loopback mock model, as the service probe does, then remove `graph\` afterwards. The last check covered the proposed plan, approval, two dependent Coders, Docker, review and the verified patch. The source checkout stayed clean.

## Tester backend

`testCandidateInDocker()` uses the local Docker Desktop Linux engine on Windows. A host-approved profile supplies a preloaded image ID, an absolute container command and a timeout. The image needs `/bin/sh`, `tar`, `xargs` and the project's test runtime. The host never pulls an image during a test. Images with declared volumes are rejected.

The host reads a fresh private Git index for the candidate's file modes and sends only tracked candidate bytes over standard input. Tests receive no host mounts or Docker socket and run with no external network, a read-only container root and writable per-container temporary directories. The snapshot accepts up to 8,192 regular tracked files and 64 MiB of file data. It rejects symlinks and submodules, including unchanged entries. The host binds the container exit code to the tested tree and removes the container before reporting evidence. [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [Git index format](https://git-scm.com/docs/gitformat-index)

Run the standalone smoke probe with the ID of a suitable local image.

```powershell
bun desktop/graph/smoke/docker-tester.ts sha256:<local-image-id>
```

The probe exercises an executable tracked file, attempted access to disposable source and other-run files, a nonzero exit, release gating and cancellation of a live container. It requires access to the local Docker Desktop named pipe.

## Next integration boundaries

- **Concurrent runs** are not supported. The sidecar runs one plan or run at a time. Parallel Coders run within that one run.
- **Tester profiles** can build on the host-approved profile consumed by `service.ts`. The workflow stores the candidate tree and exit code as stable evidence and the sanitized output as a separate display log.
- **Coder and Reviewer logs** are not recorded yet. Their worker transcripts stay inside the headless OMP attempt.
- **Jev** can classify the sanitized test log once a provider-approved summary is cut from it. Keep the initial integration in observation mode and record the returned result with its attempt. Verify hosted credentials and data policy before enabling it in a Desktop build.

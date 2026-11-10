# Kostomp Graph development

The [implementation plan](../docs/kostomp-graph-plan.md) defines the workflow and release gates. Graph modules live under `desktop/graph/` and use the existing OMP RPC and package interfaces. The Desktop Graph dialog starts a separate sidecar and leaves chat on its existing RPC bridge.

## Run from Desktop

Graph lives in the chat sidebar. **New graph**, under **New chat**, opens the Graph pane in place of the chat workspace, and the **Graphs** list in the same sidebar reopens saved runs. Picking a chat or **New chat** returns to the chats. Choose a project from the selector (the projects your chats opened) or use **Browse…** for another Git repository, then write the objective. The scope is the whole repository: Graph does not ask for a file list.

Use a full Desktop build with the bundled OMP runtime. Open **Settings > Graph** to set the model provider and model ID, the host-approved Docker tester, the parallel Coder limit, the optional failure judge and whether Graph accepts a dirty checkout. The page reads and writes `graph/profile.json` under the app data directory, normally `%APPDATA%\dev.kostomp.desktop`, and refuses to save while a plan or run is active. You can still edit the file by hand. A profile looks like this with local values substituted.

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

Provision the model and credentials in `graph/profile-home/.omp/agent/` using the normal OMP profile files. Each worker attempt runs headless in its own process with a private copy of that directory, which is deleted afterwards. The source profile is never written, so a token refreshed during an attempt is not saved back. API-key profiles are unaffected. The optional `"maxCoders"` field (an integer from 1 to 4, default 2) limits how many Coders run at once. The optional `"allowDirty": true` lets Graph plan, run, retry and export on a checkout with uncommitted changes. Graph still reads only the committed `HEAD`, so the agents never see those edits and the patch can conflict with them. The field is not part of the profile hash, so toggling it keeps saved plans and runs valid. The Graph composer accepts a checkout (clean unless `allowDirty` is set) and an objective.

**Propose plan** runs a Planner that explores the pinned repository (the read tool lists directories and reads files) and proposes Coder tasks with dependencies and per-task file ownership. A task may create new files. The host admits a proposal only if every written path is a portable repository-relative path, each file has one owner, dependencies name existing tasks and form no cycle, and no path collides on Windows by case, Unicode form, directory overlap, an 8.3 short name or a differently spelled file in the pinned tree. A rejected proposal is returned to the Planner for correction. The dialog shows the admitted plan. No Coder runs until you choose **Approve and run**. Approval names the exact plan shown. The host rejects it if the plan, `profile.json` settings or source commit changed, then saves the plan and its hash with the run. **Discard plan** drops the proposal and **Cancel** stops planning or the active run.

Graph saves the latest validated draft before approval and restores it when the sidecar restarts. The dialog identifies its repository and objective. A successful approval consumes the draft and saves the run together. **Discard plan** deletes the saved draft. If a replacement proposal fails or is cancelled, the previous draft remains available.

**Edit plan** lets you add or remove Coder tasks and change their instructions, dependencies and file assignments within the repository. Saving validates the edited draft against the same source and profile and assigns the plan a new hash when its content changes. Rejected edits leave the saved draft available. The revised plan still requires explicit approval.

Each Coder may change only its own files and reads the repository from the pinned base plus the changes of the tasks it depends on. Coders whose tasks do not depend on each other run at the same time, up to `maxCoders`. Before each dispatch the host rebuilds every write scope from the saved tasks and holds back a Coder whose files collide with a running Coder on Windows. Runs saved before planning keep one Coder at a time. The host composes all task changes into one candidate. Docker tests it, a separate Reviewer inspects the same tree, and **Show verified patch** rechecks the source commit and checkout before displaying the patch and base SHA for manual use. **Cancel** stops every running worker. The sidecar runs one plan or run at a time.

The **Graphs** list reopens saved runs after the sidecar restarts, including runs created with the earlier fixed single-Coder plan. The **Dependency map** shows the run's step order and live state. Select a step to see its attempt, prerequisites, and any owned files or errors. **Show log** and **Retry node** appear for steps that have a log or can be retried. Steps downstream rerun only when their input artifacts change. **Continue queued work** resumes eligible work after an interruption. A run allows up to three attempts per node and set of inputs. Retries require the original clean base and matching `profile.json` settings. Older snapshots without a saved execution context can be inspected in the history.

New runs start with a Context Manager node. It ranks lines from each task's owned files and from the repository files whose paths best match the objective and task briefs (up to 24, UTF-8 only) against each task's brief and objective. A Coder receives up to four short excerpts with file and line references. Prerequisite changes are listed separately from the base excerpts and remain readable through the existing file tool. The Context Manager skips unreadable and oversized files. Earlier saved plans keep their original nodes and can still resume.

The Reviewer submits a verdict and, when requesting changes, up to eight findings with an owned file, issue and expected change. Graph can automatically retry a Coder if it is the only Coder after a test failure, or if it owns every finding from the review. A run allows at most two automatic repairs. The retry includes bounded, cleaned feedback and the Coder's previous patch for reference; the Coder submits a replacement patch under its original write scope. A changed candidate must pass the test and review again. When Graph cannot pick one owner or has exhausted its retry budget, the dialog shows why the candidate did not pass. **Retry node** can pass the failing test log or the selected Coder's review findings to that Coder. Reviews saved before structured findings cannot route a repair by file.

**Show log** displays the log of a step's latest attempt. The Tester records its exit code, run time, stdout and stderr, each stream capped at 64 KiB by the Docker backend. Coder and Reviewer attempts record a worker summary: each host tool call with its clipped arguments, each tool result or rejection, the assistant's replies, and the phase in which a failed attempt stopped. A failed attempt keeps its summary. ANSI sequences and control characters are removed before a log is saved. Logs are stored per attempt beside the run, survive a sidecar restart, and are not artifacts: a retried test with new output but the same exit code does not rerun review or release. A log from an interrupted or cancelled attempt is discarded. **Logs** and **Verified patch** are collapsible sections; showing a log or the patch opens its section.

The **planner** log is available before approval and includes proposal rejections. The sidecar keeps the latest finished planning log across restarts. Approval attaches the transcript that produced the draft, even if a later planning attempt failed or the draft was edited. Discarding the draft clears the unapproved planning log.

To observe test failures with Jev, add the optional `failureJudge` object to `profile.json` and make the provider's API key available to the Desktop process. For TypeSafe, use `TYPESAFE_API_KEY`.

```json
{
	"failureJudge": {
		"provider": "typesafe",
		"model": "jev-1.14.0",
		"timeoutMs": 2500
	}
}
```

Choose a bundled native judgment model. `timeoutMs` accepts 1–5000 ms. An optional `baseUrl` overrides the catalog endpoint with HTTPS or loopback HTTP. After a nonzero test exit, Graph sends the exit code and fixed diagnostic labels such as `Assertion failure` or `Timeout`. Source code, patches, test commands, and raw output stay out of the request. The latest observation appears in **Logs** and is saved with its test attempt. Test, repair, review and release still use their original evidence. An unavailable judgment records its reason and the workflow continues.

## Current contracts

| Module             | Contract                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `omp-worker.ts`    | Runs one headless RPC attempt from an empty, host-owned directory and a separate home. Success requires the selected model, registered host tools, a completed prompt and session settlement. Cancellation stops the process tree. Host tools own input and output validation. An optional `transcript` receives one display line per tool call, tool result and assistant reply. |
| `plan.ts`          | Validates the versioned node graph before admission and orders prerequisites before dependents.                                                                                                                                                                                |
| `task-plan.ts`     | Admits a proposed task plan (portable repository-relative paths, one owner per file), hashes the approved plan and derives the node graph. A Coder node receives every transitive prerequisite's change set; test, review and release receive all Coder artifacts.                                       |
| `run-store.ts`     | Persists attempts, artifacts, display logs and a monotonic event sequence in SQLite. Call `currentArtifacts()` for dependency-valid results. `claimReady()` admits a Coder only when its approved write scope is disjoint from every running Coder; without approved tasks, Coders run one at a time. `recordLog()` accepts a log only from the live attempt, and `log()` returns the latest attempt's log. The snapshot's node status describes the latest attempt, which may be waiting on a retried upstream node. |
| `scheduler.ts`     | Drives ready work to quiescence up to the given concurrency and passes cancellation to every running executor. Use one driver per run. After exclusive ownership is acquired on restart and old workers have stopped, call `recoverInterrupted()` before dispatch.                     |
| `failure-judge.ts` | Classifies fixed test diagnostic labels with a configured native judge and records an optional observation beside the Tester result. |
| `workflow.ts`      | Turns an approved run into executor calls. `proposeGraphPlan()` admits the Planner's proposal; `runApprovedGraph()` gives each Coder its view, captures and composes change sets, binds test and review evidence to one candidate tree and records display logs beside the artifacts. |
| `agent-executors.ts` | Builds the Planner, Coder and Reviewer workers with their host tools and prompts, and the Docker Tester. Each worker gets read and directory-listing access to the repository and exactly one result tool. |
| `service.ts`       | The sidecar. Owns the data directory lease, the profile, the saved draft and the single active run. Answers one JSON request per stdin line (see below). |

The workspace layer in `workspace.ts` pins a clean SHA-1 Git checkout in an independent object database. It applies declared changes to private indexes, verifies actual paths and blob IDs, and serves exact candidate blobs for review. Release requires a successful test and an accepted review for the same candidate tree. A changed source yields `stale_base`.

### Sidecar protocol and data

The Desktop bridge (`desktop/src/graph.rs`) exposes one Tauri command, `graph_request`, and forwards each request as one JSON line to the sidecar. The sidecar answers `{ ok, data }` or `{ ok: false, error }` on one line. The Graph view polls `status` while visible.

| Operation | Effect |
| --- | --- |
| `status` | Selected run, node states, retryable and resumable steps, steps with logs, test failure observation, release status, active planning and the current draft. |
| `list`, `open` | Recent runs (up to 50) and run selection. |
| `compose` | Return to the composer and retain the current draft. |
| `plan`, `edit`, `approve`, `discard` | Start the Planner, validate and save a draft revision, approve the shown draft by ID and hash, or drop it. |
| `retry`, `resume`, `cancel` | Retry one eligible step, continue queued work, or stop planning or the active run. |
| `log`, `patch` | The latest attempt's log for a step, and the verified patch after a fresh source check. |

The data directory `%APPDATA%\dev.kostomp.desktop\graph` holds `profile.json`, `profile-home\`, `runs.sqlite` (draft, latest planning result, runs, events, artifacts and logs) and the `sidecar` lock.

## Verification

From the repository root, run:

```powershell
bun test desktop/graph/test
bun check --no-script -p desktop/graph/tsconfig.json
bun x oxlint desktop/graph
bun build --no-bundle desktop/ui/graph.js --outfile target/graph-syntax-check.js
bun x oxfmt --check "desktop/graph/**/*.ts"
cargo check --manifest-path desktop/Cargo.toml
bun desktop/graph/smoke/omp-worker.ts
bun desktop/graph/smoke/graph-service.ts sha256:<local-image-id>
```

The repository lint configuration skips `.js` files, so the `bun build --no-bundle` line is the syntax check for the dialog script. It writes the transpiled script to `--outfile`; without it the script goes to stdout, and silencing that with `> NUL` in a bash shell creates a file named `NUL` that Windows cannot delete. To discard output, use `/dev/null` in bash or `$null` in PowerShell.

Both smoke probes default to `desktop/target/release/runtime`. The worker probe takes another staged runtime directory as the first argument and optionally a different CLI entry point as the second. The mock provider listens on `127.0.0.1` and uses a fixture credential. The worker probe checks a completed host call, a denied target, the exact tools on the wire and cancellation of a launcher with an OMP child. It needs local loopback permission.

The service probe drives the sidecar over its stdin protocol with the mock model and real Docker, using a JWT-refresh plan: one task owns the API contract and the backend and frontend tasks depend on it. It checks that a restart restores the exact draft without creating a run and that consumed and discarded drafts stay deleted. It rejects an out-of-scope Planner proposal and user edit, verifies that an approved edit reaches the Coder, and rejects approval with a stale source or plan hash. The mock model holds the backend and frontend Coders until both have started, which proves they ran at the same time, and checks that both read the contract from the upstream candidate. It also checks that the Reviewer cannot file an out-of-scope finding, that a valid backend finding reaches only that Coder, and that findings spanning two owners block export with a reason. The probe verifies that worker logs and sanitized Docker output are available after a restart. It checks the verified patch, a backend retry with the same result that reruns nothing downstream, and stale source rejection. The image must declare no volumes.

The workspace tests use disposable Git repositories and compare the source index before and after composition. They require a temporary directory where Windows permits Git's atomic index-lock replacement.

### Packaged Desktop check

The packaged runtime loads the native addon only when its version matches the checkout. Development runs only warn about a mismatch. `stage-runtime.ps1` therefore loads the staged addon with the staged Bun and an empty natives cache, and stops with a `bun run build:native` hint when it does not load. Rebuild the addon after every version bump, including upstream merges. On this toolchain, CMake selects Ninja, so put a `ninja.exe` on `PATH` for that command, for example the one in Visual Studio Build Tools under `Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja`.

If the sidecar exits before answering, the Desktop bridge appends the `error:` line from its stderr to the dialog message, for example when another Kostomp instance already owns the Graph data directory.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/stage-runtime.ps1 -NoStats
cd desktop; bunx @tauri-apps/cli@2 build --no-bundle; cd ..
```

`--no-bundle` leaves the version, installer and local update folder unchanged. A second instance can run beside an open Kostomp when it gets its own WebView2 profile. A debugging port lets a CDP client inspect the dialog.

The second instance also starts a chat. Keep that chat away from your real sessions: use a new WebView2 profile each time, start the app from an empty folder, and point `PI_CODING_AGENT_DIR` at a private agent directory. Otherwise the chat reopens the folder's latest session, and a session already open in your instance is forked into a new session file on every launch. The private directory needs a `models.yml` for the loopback mock model and a `config.yml` with `modelRoles.default` set to it; chat sessions then stay in that directory.

```powershell
$check = New-Item -ItemType Directory -Path "$env:TEMP\kostomp-graph-check-$(New-Guid)"
New-Item -ItemType Directory -Path "$check\chat-folder", "$check\chat-agent" | Out-Null
# Write chat-agent\models.yml and chat-agent\config.yml for the mock model here.
$env:WEBVIEW2_USER_DATA_FOLDER = "$check\webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
$env:PI_CODING_AGENT_DIR = "$check\chat-agent"
Start-Process -FilePath (Resolve-Path desktop\target\release\kostomp-desktop.exe) -WorkingDirectory "$check\chat-folder"
```

Both instances share `%APPDATA%\dev.kostomp.desktop`. Point the Graph profile at the loopback mock model, as the service probe does, then remove `graph\` and the check directory afterwards.

The last packaged checks covered the proposed plan, approval, parallel Coders, Docker, review, Coder and test logs, the collapsible sections and the verified patch. A chat in the same instance answered before the run, while both Coders were running and after the release. The source checkout stayed clean.

## Tester backend

`testCandidateInDocker()` uses the local Docker Desktop Linux engine on Windows. A host-approved profile supplies a preloaded image ID, an absolute container command and a timeout. The image needs `/bin/sh`, `tar`, `xargs` and the project's test runtime. The host never pulls an image during a test. Images with declared volumes are rejected.

The host reads a fresh private Git index for the candidate's file modes, writes a temporary archive, and streams it to the container over standard input. The snapshot accepts up to 16,384 regular tracked files and 256 MiB of file data. It rejects symlinks and submodules, including unchanged entries. Tests run with a 384 MiB temporary workspace, a read-only container root, and no network or host mounts. The host binds the container exit code to the tested tree and removes the container before reporting evidence. [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [Git index format](https://git-scm.com/docs/gitformat-index)

Run the standalone smoke probe with the ID of a suitable local image.

```powershell
bun desktop/graph/smoke/docker-tester.ts sha256:<local-image-id>
```

The probe exercises an executable tracked file, attempted access to disposable source and other-run files, a nonzero exit, release gating and cancellation of a live container. It requires access to the local Docker Desktop named pipe.

## Scope boundaries

- The sidecar runs one plan or run at a time. Parallel Coders work within that run.
- Each profile specifies one host-approved Tester command.
- Jev runs in observation mode. The Windows smoke probe uses a local System One fixture to verify request contents, authentication, persistence and provider failure.

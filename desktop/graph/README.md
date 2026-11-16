# Kostomp Graph development

The [implementation plan](../docs/kostomp-graph-plan.md) defines the workflow and release gates. Graph modules live under `desktop/graph/` and use the existing OMP RPC and package interfaces. The Desktop Graph dialog starts a separate sidecar and leaves chat on its existing RPC bridge.

## Run from Desktop

Graph lives in the chat sidebar. **New graph**, under **New chat**, opens the Graph pane in place of the chat workspace, and the **Graphs** list in the same sidebar reopens saved runs. Picking a chat or **New chat** returns to the chats. Choose a project from the selector (the projects your chats opened) or use **Browse…** for another Git repository, then write the objective. The scope is the whole repository: Graph does not ask for a file list.

The Graph pane sits flush against the sidebar, without a left-hand gutter, at every window width.

The **Sessions**, **Graphs** and **Designs** sidebar tabs switch to icons only when the tab strip's content width is 260 px or less. Wider strips show the labels again; tooltips and accessible tab names remain available in both layouts.

The objective composer is a compact command dock below the agent map: the top strip holds the project selector, repository path and **Browse…**, followed by a full-width objective field and **Propose plan** in the lower-right corner. On narrow panes the path and project badge are hidden to keep the controls usable. The dock follows the light or dark theme; proposing a plan still requires both a project and a non-empty objective.

Chat rows in the sidebar and **Sessions** list, and Graph rows in the sidebar and **Graphs** list, have a **Delete session permanently** / **Delete graph run permanently** button. Deletion requires confirmation and stops the selected session's running work before removing its saved conversation or run, logs and artifacts. Deleting the last chat opens a fresh chat. Chats held by another OMP process cannot be deleted. The **×** buttons still only close rows; they do not delete saved history. Graph deletion does not modify the source repository.

Assistant messages keep their **copy** action below the message card, outside its border; it appears on hover or keyboard focus after streaming finishes.

New chats center the suggestions and message input together. Once the transcript has content, the input returns to the bottom. The Activity panel starts collapsed in every chat; **Show activity** in the upper-right opens it, and **Hide activity** collapses it again.

Use a full Desktop build with the bundled OMP runtime. Open **Settings > Graph** to set the model provider and model ID, the host-approved Docker tester, the parallel Coder limit, the optional failure judge and whether Graph accepts a dirty checkout. The page reads and writes `graph/profile.json` under the local app data directory, normally `%LOCALAPPDATA%\dev.kostomp.desktop`, and refuses to save while a plan or run is active. You can still edit the file by hand. A profile looks like this with local values substituted.

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

When `graph/profile-home/.omp/agent/` holds no credential database, a worker uses the accounts signed in to the app: each attempt gets a consistent snapshot of the app's `agent.db`, never the live file. Saving the profile validates the Tester settings (an absolute `dockerPath`, a `sha256:` image ID, an absolute container command, a timeout of 1–300000 ms), and the same check runs before every plan, approval, retry and resume, so a Tester that cannot run is reported before any model is used. Saved plans and runs depend only on the provider, the model and the Tester settings: changing `maxCoders`, `failureJudge` or `allowDirty` keeps them valid. A `profile.json` that is not valid JSON is reported on the Settings page, which still opens so the profile can be saved again.

**Propose plan** runs a Planner that explores the pinned repository (the read tool lists directories and reads files) and proposes Coder tasks with dependencies and per-task file ownership. A task may create new files. The host admits a proposal only if every written path is a portable repository-relative path, each file has one owner, dependencies name existing tasks and form no cycle, and no path collides on Windows by case, Unicode form, directory overlap, an 8.3 short name or a differently spelled file in the pinned tree. A rejected proposal is returned to the Planner for correction. The dialog shows the admitted plan. No Coder runs until you choose **Approve and run**. Approval names the exact plan shown. The host rejects it if the plan, `profile.json` settings or source commit changed, then saves the plan and its hash with the run. **Discard plan** drops the proposal and **Cancel** stops planning or the active run.

Planning refuses a repository the Tester could never package: a tracked symlink or submodule, more than 16,384 tracked files, or an object store borrowed from another repository (`git clone --shared` or `--reference`). A task cannot own a path that is a directory in the pinned tree or that lies beneath an existing file.

Graph saves the latest validated draft before approval and restores it when the sidecar restarts. The dialog identifies its repository and objective. A successful approval consumes the draft and saves the run together. **Discard plan** deletes the saved draft. If a replacement proposal fails or is cancelled, the previous draft remains available.

**Edit plan** lets you add or remove Coder tasks and change their instructions, dependencies and file assignments within the repository. Saving validates the edited draft against the same source and profile and assigns the plan a new hash when its content changes. Rejected edits leave the saved draft available. The revised plan still requires explicit approval.

Each Coder may change only its own files and reads the repository from the pinned base plus the changes of the tasks it depends on. Coders whose tasks do not depend on each other run at the same time, up to `maxCoders`. Before each dispatch the host rebuilds every write scope from the saved tasks and holds back a Coder whose files collide with a running Coder on Windows. Runs saved before planning keep one Coder at a time. The host composes all task changes into one candidate. Docker tests it, a separate Reviewer inspects the same tree, and **Show verified patch** rechecks the source commit and checkout before displaying the patch and base SHA for manual use. **Cancel** stops every running worker. The sidecar runs one plan or run at a time.

The **Graphs** list reopens saved runs after the sidecar restarts, including runs created with the earlier fixed single-Coder plan. The **Agents** map shows the run's step order and live state. Select a step to see its attempt, prerequisites, any owned files or errors, and its live activity. **Retry node** appears for steps that can be retried. Steps downstream rerun only when their input artifacts change. Closing the app during a run interrupts its live steps instead of cancelling the run. **Continue queued work** resumes an interrupted run, and **Resume cancelled run** continues a run stopped with **Cancel**; both keep the results already produced. A step allows up to three attempts per set of inputs, and a planned Coder five, so a manual retry is still possible after the two automatic repairs. An attempt stopped by Cancel or by closing the app does not count. Retries require the original clean base and matching `profile.json` settings. Older snapshots without a saved execution context can be inspected in the history.

Hold the left mouse button and drag anywhere in the **Agents** diagram, including on a node, to pan in any direction. A normal node click still opens its details; dragging does not. The **+** and **−** buttons, Ctrl with the mouse wheel, and the `+`, `-` and `0` keys on the focused diagram zoom around the pointer or the centre. **Fit** resets panning and fits the diagram to the view. Opening the step details keeps the zoom and brings the selected step into view.

The Graph pane opens on the agent map. The prompt box sits under the map, and the map exists before any plan does: the Planner node appears first and turns active while it plans, then the proposed Coder, test, review and release steps appear as queued nodes. Select a node to see **Live activity** in the inspector: each file read, host tool call, tool result and agent reply as it happens, for the Planner, every Coder and the Reviewer. A node you have not selected yourself follows whichever step is running. The Tester has no transcript; its output appears when it finishes.

The status line names the outcome: a failed or interrupted step, a paused or cancelled run, or why the release needs input (the failed test's exit code or the review's request). While another run or a plan holds the sidecar, the pane says so, and **Open active run** switches to the run that is executing. The step details show the attempt out of the allowed attempts, how long the latest attempt ran and a Coder's task brief. Live activity adds new entries without redrawing the ones on screen, and the log is fetched only when it has grown. The pane asks for status every 800 ms while work is running, every three seconds otherwise, and not at all while the window is hidden; if the sidecar fails, it retries with growing pauses of up to 30 seconds. The sidecar starts with the first Graph request, so an app that never opens Graph never starts it. **New graph** carries a dot while a proposed plan waits for review. **Discard plan** asks for confirmation, and the verified patch has a **Copy patch** button. Ctrl+Enter in the objective field proposes the plan.

The **Graph runs** list shows 50 runs at a time, newest first; **Load older runs** appends the next 50. The runs open in the sidebar are remembered by the app itself, so they appear at launch without starting the sidecar and stay there however old they are; a row goes when its run is deleted or no longer exists. When a run or a plan ends while the Graph pane is not on screen (a chat is open, or the window is hidden in the tray), a toast names the objective and the outcome, and clicking it opens that run or the proposed plan. Work stopped with **Cancel**, **Discard plan** or by deleting the run raises no toast.

New runs start with a Context Manager node. It ranks lines from each task's owned files and from the repository files whose paths best match the objective and task briefs (up to 24, UTF-8 only) against each task's brief and objective. Only a line that mentions one of the task's terms qualifies; letter case and accents do not matter. A Coder receives up to four short excerpts with file and line references. Prerequisite changes are listed separately from the base excerpts and remain readable through the existing file tool. The Context Manager skips unreadable and oversized files. Earlier saved plans keep their original nodes and can still resume.

Graph validates each Coder patch against the pinned base and approved files when the worker submits it. A rejected patch returns the reason to the Coder so it can correct and resubmit within the same attempt. The first validated patch is the one used to compose the candidate.

A rejection says what to fix: it names the out-of-scope paths and the approved files, the unsupported kind of change (rename or copy, symlink, submodule, file mode change) or the size limit. Blank context lines that lost their leading space are repaired before the patch is applied. Workers read files larger than 64 KiB in line ranges. A worker that ends its turn without submitting its result is reminded up to twice within the same attempt, and an attempt that runs a tool the host did not register is stopped. The Reviewer receives the candidate's diff (up to 48,000 characters) and reads full files from the base or the candidate.

The Reviewer submits a verdict and, when requesting changes, up to eight findings with an owned file, issue and expected change. Graph can automatically retry a Coder if it is the only Coder after a test failure, or if it owns every finding from the review. A run allows at most two automatic repairs. The retry includes bounded, cleaned feedback and the Coder's previous patch for reference; the Coder submits a replacement patch under its original write scope. A changed candidate must pass the test and review again. When Graph cannot pick one owner or has exhausted its retry budget, the dialog shows why the candidate did not pass. **Retry node** can pass the failing test log or the selected Coder's review findings to that Coder. Reviews saved before structured findings cannot route a repair by file.

A step's **Live activity** shows the log of its latest attempt, refreshed while the attempt runs. The Tester records its exit code, run time, stdout and stderr. Each stream is capped at 64 KiB: stdout keeps its first 16 KiB and last 48 KiB with the number of omitted bytes between them, so a runner's closing summary survives. Coder, Planner and Reviewer attempts record a worker summary: each host tool call with its clipped arguments, each tool result or rejection, the assistant's replies, and the phase in which a failed attempt stopped. A failed, interrupted or cancelled attempt keeps the summary written so far. ANSI sequences and control characters are removed before a log is saved. Logs are stored per attempt beside the run, survive a sidecar restart, and are not artifacts: a retried test with new output but the same exit code does not rerun review or release. **Verified patch** is a collapsible section; showing the patch opens it.

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
| `omp-worker.ts`    | Runs one headless RPC attempt from an empty, host-owned directory and a separate home. Success requires the selected model, registered host tools, a completed prompt and session settlement. Cancellation stops the process tree. Host tools own input and output validation. An optional `transcript` receives one display line per tool call, tool result and assistant reply. A tool call outside the registered host tools aborts the attempt. With `isDone` and `reminder`, a prompt that completes without a result is followed by up to two reminder prompts. |
| `plan.ts`          | Validates the versioned node graph before admission and orders prerequisites before dependents.                                                                                                                                                                                |
| `task-plan.ts`     | Admits a proposed task plan (portable repository-relative paths, one owner per file), hashes the approved plan and derives the node graph. A Coder node receives every transitive prerequisite's change set; test, review and release receive all Coder artifacts.                                       |
| `run-store.ts`     | Persists attempts, artifacts, display logs and a monotonic event sequence in SQLite. Call `currentArtifacts()` for dependency-valid results. `claimReady()` admits a Coder only when its approved write scope is disjoint from every running Coder; without approved tasks, Coders run one at a time. `recordLog()` accepts a log only from the live attempt, and `log()` returns the latest attempt's log. The snapshot's node status describes the latest attempt, which may be waiting on a retried upstream node. `cancel()` leaves a run with nothing running or ready untouched. `resume()` returns cancelled nodes, and interrupted nodes whose inputs are current, to the queue; an attempt stopped by `cancel()` or `recoverInterrupted()` is refunded. |
| `scheduler.ts`     | Drives ready work to quiescence up to the given concurrency and passes cancellation to every running executor. Use one driver per run. An abort with the reason `GRAPH_SHUTDOWN` interrupts live attempts; any other abort cancels the run. After exclusive ownership is acquired on restart and old workers have stopped, call `recoverInterrupted()` before dispatch.                     |
| `profile.ts`       | Validates `profile.json`, checks the Tester settings and computes the identity saved plans and runs are bound to (provider, model and Tester). A hash saved with the earlier formula, which included `maxCoders` and `failureJudge`, is still accepted. |
| `failure-judge.ts` | Classifies fixed test diagnostic labels with a configured native judge and records an optional observation beside the Tester result. |
| `workflow.ts`      | Turns an approved run into executor calls. `proposeGraphPlan()` admits the Planner's proposal; `runApprovedGraph()` gives each Coder its view, captures and composes change sets, binds test and review evidence to one candidate tree and records display logs beside the artifacts. |
| `agent-executors.ts` | Builds the Planner, Coder and Reviewer workers with their host tools and prompts, and the Docker Tester. Each worker gets read and directory-listing access to the repository (line ranges for large files; only the Reviewer can read the candidate) and exactly one result tool. |
| `service.ts`       | The sidecar. Owns the data directory lease, the profile, the saved draft and the single active run. Answers one JSON request per stdin line (see below). Closed stdin is app exit: live attempts become interrupted and the run stays resumable. |

The workspace layer in `workspace.ts` pins a clean SHA-1 Git checkout in an independent object database. It applies declared changes to private indexes, verifies actual paths and blob IDs, and serves exact candidate blobs for review. Its scratch repository turns rename detection off, so results do not depend on the user's `diff.renames`. The test archive of a candidate is built once per candidate tree inside the scratch and replaced when a new candidate is tested. Release requires a successful test and an accepted review for the same candidate tree. A changed source yields `stale_base`.

The sidecar keeps one copy of the object database, for the last pinned commit: planning, plan edits and every run, retry or resume of that commit reuse it instead of copying the source objects again. Pinning a different commit makes a new copy, which replaces and deletes the kept one when its workspace closes. The kept copy is deleted when the sidecar exits.

### Sidecar protocol and data

The Desktop bridge (`desktop/src/graph.rs`) exposes one Tauri command, `graph_request`, and forwards each request as one JSON line to the sidecar. The sidecar answers `{ ok, data }` or `{ ok: false, error }` on one line. The Graph view polls `status` while visible.

The bridge waits 30 seconds for an answer, or 300 seconds for `edit` and `delete`, which wait for work in the sidecar. A sidecar that does not answer in time is killed and the next request starts a new one. A malformed answer line fails that request only. App exit and updates stop the sidecar without waiting for a request in flight: its stdin is closed, it gets five seconds to exit, then its process tree is killed, and no request starts a sidecar while the app is closing. The sidecar runs with the data directory as its working directory and with `%TEMP%\kostomp-graph-scratch` as its temporary directory. After it holds the data-directory lock, it removes what a killed sidecar left there: object-database copies, worker homes and tester archives.

| Operation | Effect |
| --- | --- |
| `status` | Selected run, node states with the latest attempt's start and end time, retryable and resumable steps, steps with logs and each log's length (`logSizes`), test failure observation, release status, active planning and the current draft. `activeRun` names the run that is executing, whichever run is selected, and `cancelling` is set while its workers are being stopped. `finished` describes the latest run or plan that ended on its own (`at`, `run`, `objective`, `outcome`, `reason`), whichever run is selected; work the user stopped is not reported. |
| `list`, `open` | Saved runs, newest first, 50 per page as `{ runs, more }`; `input.after` names the last run already listed and returns the next older page. Run selection. |
| `compose` | Return to the composer and retain the current draft. |
| `plan`, `edit`, `approve`, `discard` | Start the Planner, validate and save a draft revision, approve the shown draft by ID and hash, or drop it. |
| `delete` | Permanently remove one run by ID with its events, artifacts, logs and test observations. If it is the active run, the sidecar aborts it and waits for the executor to stop before deleting. Other runs, the saved draft and planning log are untouched; deleting the selected run returns to the composer. |
| `retry`, `resume`, `cancel` | Retry one eligible step, continue a paused, interrupted or cancelled run, or stop planning or the active run. |
| `log`, `patch` | The latest attempt's log for a step, and the verified patch after a fresh source check. |

The data directory `%LOCALAPPDATA%\dev.kostomp.desktop\graph` holds `profile.json`, `profile-home\`, `runs.sqlite` (draft, latest planning result, runs, events, artifacts and logs) and the `sidecar` lock. It is machine-local on purpose: the database, the lock and the run paths must not roam. Data saved by earlier builds under `%APPDATA%\dev.kostomp.desktop\graph` is moved there by one directory rename the first time a sidecar starts; if the rename fails because another instance holds the directory, that start keeps using the old location and the move is tried again at the next start.

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

`stage-runtime.ps1` stages the Graph sidecar on every run, also for a shell-only build (`build.ps1` without `full`), because the installer never deletes files of an earlier install: an update that left the sidecar out would run the new UI against the old `runtime\graph`. The sidecar is source code that runs on the installed omp packages, so the script records the omp version it was written for in `runtime\graph\OMP_VERSION`. When that differs from the installed `runtime\OMP_VERSION`, Graph refuses to start and asks for the full build; chat keeps working. After an upstream version bump, ship a full build.

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

Both instances share `%LOCALAPPDATA%\dev.kostomp.desktop\graph`. Point the Graph profile at the loopback mock model, as the service probe does, then remove `graph\` and the check directory afterwards.

The last packaged checks covered the proposed plan, approval, parallel Coders, Docker, review, Coder and test logs, the collapsible sections and the verified patch. A chat in the same instance answered before the run, while both Coders were running and after the release. The source checkout stayed clean.

## Tester backend

`testCandidateInDocker()` uses the local Docker Desktop Linux engine on Windows. A host-approved profile supplies a preloaded image ID, an absolute container command and a timeout. The image needs `/bin/sh`, `tar`, `xargs` and the project's test runtime. The host never pulls an image during a test. Images with declared volumes are rejected.

The test deadline starts when the container starts; preparing the engine check, the image check and the snapshot has its own bound of the same length. A test that passes its deadline is recorded as a failed test with exit code 124 and the output captured so far, and a container killed for memory as exit code 137, so a repair can target the candidate. The bootstrap reports a failure before the test command runs (missing `tar` or `xargs`, a full workspace) with exit code 111 and a `graph-bootstrap:` line on stderr; the host treats it as an infrastructure error, not a test result. Containers carry the label `dev.kostomp.graph=1`, and those left by a killed sidecar are removed before the next test.

The host reads a fresh private Git index for the candidate's file modes and streams one Git blob at a time into a temporary tar archive, then streams the archive to the container over standard input. The snapshot accepts up to 16,384 regular tracked files, without a fixed total byte limit; host memory use still depends on the largest individual blob. It rejects symlinks and submodules, including unchanged entries. The temporary workspace grows with the uncompressed archive: at least 384 MiB, with at least 128 MiB or 50% extra space, whichever is larger. The container memory limit is the workspace size plus 384 MiB because the workspace is a memory-backed tmpfs; the Docker VM must have enough RAM for the extracted project and test runtime. The container root stays read-only, with no network or host mounts. The host binds the container exit code to the tested tree and removes the container before reporting evidence. [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [Git index format](https://git-scm.com/docs/gitformat-index)

Run the standalone smoke probe with the ID of a suitable local image that also provides `sha256sum`.

```powershell
bun desktop/graph/smoke/docker-tester.ts sha256:<local-image-id>
```

The probe exercises an executable tracked file, attempted access to disposable source and other-run files, a nonzero exit, release gating and cancellation of a live container. It also tests a 400 MiB tracked asset snapshot, exceeding both the former 256 MiB snapshot limit and 384 MiB workspace, and verifies every asset's SHA-256 inside the container. It requires access to the local Docker Desktop named pipe.

## Scope boundaries

- The sidecar runs one plan or run at a time. Parallel Coders work within that run.
- Each profile specifies one host-approved Tester command.
- Jev runs in observation mode. The Windows smoke probe uses a local System One fixture to verify request contents, authentication, persistence and provider failure.

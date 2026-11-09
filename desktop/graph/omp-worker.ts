import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RpcClient, type RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree, untilAborted } from "@oh-my-pi/pi-utils";
import { systemProcessEnv } from "./process-env";

export interface OmpWorkerOptions {
	bunPath: string;
	cliPath: string;
	/** An empty, host-owned directory. Repository access is mediated by the supplied tools. */
	cwd: string;
	/** A host-owned home with any required model credentials provisioned separately. */
	home: string;
	provider: string;
	model: string;
	tools: RpcClientCustomTool[];
	prompt: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Run one headless OMP attempt. Tool exposure is not an OS sandbox. */
export async function runOmpWorker(options: OmpWorkerOptions): Promise<void> {
	const { bunPath, cliPath, cwd, home, provider, model, prompt, tools, timeoutMs } = options;
	if (!prompt.trim() || prompt.trimStart().startsWith("/")) {
		throw new Error("Graph workers require a prompt, not a slash command");
	}
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	signal.throwIfAborted();
	if ((await fs.readdir(cwd)).length !== 0) throw new Error("Graph worker directory must be empty");
	const env = {
		...systemProcessEnv(),
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		TEMP: home,
		TMP: home,
		PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
		NO_COLOR: "1",
	};
	const client = new RpcClient({
		provider,
		model,
		args: [
			"--no-ui",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-context-files",
			"--no-lsp",
		],
		spawn: args => {
			signal.throwIfAborted();
			return ptree.spawn([bunPath, "--no-env-file", cliPath, ...args], { cwd, env, stdin: "pipe", signal });
		},
	});
	let completed = false;
	let phase = "starting RPC";
	const unsubscribe = client.onPromptResult(result => {
		completed = result.status === "completed";
	});
	try {
		await untilAborted(signal, async () => {
			await client.start();
			signal.throwIfAborted();
			phase = "checking the worker profile";
			const state = await client.getState();
			if (state.model?.provider !== provider || state.model.id !== model) {
				throw new Error("Graph worker did not select the requested model");
			}
			const names = await client.setCustomTools(tools);
			if (names.length !== tools.length || tools.some(tool => !names.includes(tool.name))) {
				throw new Error("Graph worker did not register the requested tools");
			}
			signal.throwIfAborted();
			phase = "waiting for the prompt result";
			await client.promptAndWait(prompt);
			if (!completed) throw new Error("Graph worker prompt did not complete");
			phase = "waiting for the session to settle";
			await client.waitForSettled();
		});
	} catch (cause) {
		if (options.signal?.aborted) options.signal.throwIfAborted();
		throw new Error(`Graph worker failed while ${phase}`, { cause });
	} finally {
		unsubscribe();
		await client.stop();
	}
}

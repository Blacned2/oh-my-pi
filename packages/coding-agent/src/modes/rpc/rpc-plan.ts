/**
 * Plan mode for RPC hosts (`--mode rpc` and `--mode rpc-ui`).
 *
 * The TUI owns plan mode in `InteractiveMode`; ACP has its own copy of the minimum. This controller
 * is the RPC host's: it enters/exits plan mode on request and consumes the agent's `xd://propose`
 * write by asking the host to approve or refine the plan through the regular `select` dialog.
 * Headless hosts (no dialog surface) auto-approve so the agent is never stranded in plan mode.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import { normalizePlanTitle, type PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../../plan-mode/plan-autosave";
import { readPlanFile } from "../../plan-mode/plan-files";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import type { AgentSession } from "../../session/agent-session";

export type RpcPlanOp = "get" | "enter" | "exit";

export interface RpcPlanCommand {
	op: RpcPlanOp;
}

export interface RpcPlanState {
	/** Plan artifact the agent drafts (`local://PLAN.md` unless a prior plan chose another). */
	planFilePath: string;
}

export interface RpcPlanResult {
	/** Current plan-mode state; `null` when plan mode is off. */
	plan: RpcPlanState | null;
}

export type RpcPlanSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "getPlanModeState"
	| "setPlanModeState"
	| "setPlanProposalHandler"
	| "setPlanReferencePath"
	| "preparePlanForReview"
	| "getEnabledToolNames"
	| "setActiveToolsByName"
	| "hasBuiltInTool"
	| "getGoalModeState"
>;

/** Host dialog used to ask for plan approval; `undefined` for hosts without a UI. */
export type RpcPlanSelect = (title: string, options: string[]) => Promise<string | undefined>;

const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
const APPROVE_OPTION = "Approve and execute";
const REFINE_OPTION = "Refine plan";
/** Plan lines shown in the approval dialog; a full plan would overflow it. */
const PREVIEW_LINES = 12;

export class RpcPlanController {
	readonly #session: RpcPlanSession;
	readonly #select: RpcPlanSelect | undefined;
	/** Active tool set before plan mode; restored on exit/approval. */
	#previousTools: string[] | undefined;

	constructor(session: RpcPlanSession, select: RpcPlanSelect | undefined) {
		this.#session = session;
		this.#select = select;
	}

	async handle(command: RpcPlanCommand): Promise<RpcPlanResult> {
		switch (command.op) {
			case "get":
				return this.#result();
			case "enter":
				await this.#enter();
				return this.#result();
			case "exit":
				await this.#exit();
				return this.#result();
			default:
				throw new Error(`Unknown plan op: ${JSON.stringify(command)}`);
		}
	}

	#result(): RpcPlanResult {
		const state = this.#session.getPlanModeState();
		return { plan: state?.enabled ? { planFilePath: state.planFilePath } : null };
	}

	async #enter(): Promise<void> {
		const session = this.#session;
		if (session.getPlanModeState()?.enabled) return;
		if (!cfgPlanEnabled.get(session.settings)) {
			throw new Error("Plan mode is disabled (plan.enabled).");
		}
		if (session.getGoalModeState()) {
			throw new Error("Exit goal mode first.");
		}
		const previous = session.getPlanModeState();
		const previousTools = session.getEnabledToolNames();
		// Plan approval is a `write` to `xd://propose` and the plan draft is written with `write`:
		// it must be active. A shadowing extension `write` has no `xd://` transport, so drop it.
		const tools = session.hasBuiltInTool("write")
			? [...new Set([...previousTools, "write"])]
			: previousTools.filter(name => name !== "write");
		session.setPlanModeState({
			enabled: true,
			planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
			workflow: previous?.workflow ?? "parallel",
			reentry: previous !== undefined,
		});
		try {
			await session.setActiveToolsByName(tools);
		} catch (error) {
			session.setPlanModeState(previous);
			throw error;
		}
		this.#previousTools = previousTools;
		session.setPlanProposalHandler(title => this.#propose(title));
	}

	async #exit(): Promise<void> {
		const session = this.#session;
		if (!session.getPlanModeState()?.enabled) return;
		session.setPlanProposalHandler(null);
		session.setPlanModeState(undefined);
		await this.#restoreTools();
	}

	async #restoreTools(): Promise<void> {
		const tools = this.#previousTools;
		this.#previousTools = undefined;
		if (!tools) return;
		try {
			await this.#session.setActiveToolsByName(tools);
		} catch (error) {
			logger.warn("Failed to restore tools after plan mode", { error });
		}
	}

	async #propose(title: string): Promise<{ content: { type: "text"; text: string }[]; details: PlanApprovalDetails }> {
		const session = this.#session;
		const state = session.getPlanModeState();
		if (!state?.enabled) throw new ToolError("Plan mode is not active.");
		const { details } = await session.preparePlanForReview(title);
		if (!details) throw new ToolError("Plan review produced no plan details.");
		const planContent =
			(await readPlanFile(details.planFilePath, {
				localProtocolOptions: {
					getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
					getSessionId: () => session.sessionManager.getSessionId(),
				},
				cwd: session.sessionManager.getCwd(),
			})) ?? "";
		const approved = await this.#approve(details.title, planContent);
		if (!approved) {
			// Refinement keeps plan mode on; target the reviewed file on the next planning turn.
			if (state.planFilePath !== details.planFilePath) {
				session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
			}
			const slug = normalizePlanTitle(details.title).title;
			return {
				content: [
					{
						type: "text",
						text: `Plan refinement requested. Update the plan file, then write ${slug} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}
		session.setPlanReferencePath(details.planFilePath);
		session.setPlanProposalHandler(null);
		session.setPlanModeState(undefined);
		await this.#restoreTools();
		let autosaveFailed = false;
		try {
			await autosaveApprovedPlan({
				settings: session.settings,
				cwd: session.sessionManager.getCwd(),
				title: details.title,
				planContent,
			});
		} catch (error) {
			logger.warn("Failed to autosave approved plan", { error });
			autosaveFailed = true;
		}
		return {
			content: [
				{
					type: "text",
					text: `Plan approved at ${details.planFilePath}. Plan mode exited; proceed with the implementation.${
						autosaveFailed ? " (Plan autosave failed; continuing.)" : ""
					}`,
				},
			],
			details,
		};
	}

	/** Only the explicit approve choice approves: dismissal, cancel, or timeout means refine. */
	async #approve(title: string, planContent: string): Promise<boolean> {
		if (!this.#select) return true;
		const lines = planContent.split("\n");
		const preview = lines.slice(0, PREVIEW_LINES).join("\n") + (lines.length > PREVIEW_LINES ? "\n…" : "");
		const choice = await this.#select(`Approve plan "${title}" and start implementation?\n\n${preview}`, [
			APPROVE_OPTION,
			REFINE_OPTION,
		]);
		return choice === APPROVE_OPTION;
	}
}

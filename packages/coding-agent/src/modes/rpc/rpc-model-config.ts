/**
 * Model-scope and per-agent model settings for RPC hosts: the data behind the CLI's
 * `/models` scope editor and the `/agents` hub model chips, without the TUI.
 */
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { filterAvailableModelsByEnabledPatterns } from "../../config/model-resolver";
import { cfgEnabledModels } from "../../config/model-settings";
import type { AgentSession } from "../../session/agent-session";
import { createAgentsHubDeps } from "../agents-hub-deps";

export interface RpcModelCatalogModel {
	id: string;
	name: string;
	scoped: boolean;
	/** Thinking efforts valid as a `:level` suffix on this model; empty when none. */
	efforts: string[];
}

export interface RpcModelCatalogProvider {
	provider: string;
	models: RpcModelCatalogModel[];
}

export interface RpcModelCatalog {
	enabledModels: string[];
	providers: RpcModelCatalogProvider[];
}

export interface RpcAgentModelEntry {
	name: string;
	description: string;
	source: string;
	disabled: boolean;
	/** Frontmatter `model` patterns of the agent definition. */
	agentModel?: string[];
	/** Saved `task.agentModelOverrides` entry, comma-joined. */
	overrideModel?: string;
	/** `provider/id[:level]` the agent would run on now. */
	effectiveModel?: string;
}

/** Every connected (authenticated or keyless) provider's chat models, each marked in/out of `enabledModels`. */
export async function getRpcModelCatalog(session: AgentSession): Promise<RpcModelCatalog> {
	await session.modelRegistry.awaitBackgroundRefresh();
	const available = session.modelRegistry.getAvailable();
	const enabledModels = [...cfgEnabledModels.get(session.settings)];
	const scoped = new Set(
		filterAvailableModelsByEnabledPatterns(available, enabledModels, session.settings).map(
			model => `${model.provider}/${model.id}`,
		),
	);
	const byProvider = new Map<string, RpcModelCatalogModel[]>();
	for (const model of available) {
		let models = byProvider.get(model.provider);
		if (!models) {
			models = [];
			byProvider.set(model.provider, models);
		}
		models.push({
			id: model.id,
			name: model.name,
			scoped: scoped.has(`${model.provider}/${model.id}`),
			efforts: [...getSupportedEfforts(model)],
		});
	}
	const providers = [...byProvider.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, models]) => ({ provider, models }));
	return { enabledModels, providers };
}

/** Persist `enabledModels`; an empty list scopes to every available model. The live scope follows via the settings watcher. */
export function setRpcEnabledModels(session: AgentSession, patterns: string[]): void {
	const cleaned = [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
	cfgEnabledModels.set(session.settings, cleaned);
}

function hubDeps(session: AgentSession): AgentsHubDeps {
	const active = session.model;
	return createAgentsHubDeps(
		getProjectDir(),
		session.settings,
		session.modelRegistry,
		() => session.effectiveExtensionRoots,
		active ? `${active.provider}/${active.id}` : undefined,
		session.settings.getModelRole("default"),
		model => session.effectiveServiceTier(model),
	);
}

/** Discovered task agents with their saved model override and the model each resolves to. */
export async function getRpcAgentModels(session: AgentSession): Promise<RpcAgentModelEntry[]> {
	const deps = hubDeps(session);
	const agents = await deps.loadAgents();
	return agents.map(agent => ({
		name: agent.name,
		description: agent.description,
		source: agent.source,
		disabled: agent.disabled,
		agentModel: agent.model,
		overrideModel: agent.overrideModel,
		effectiveModel: deps.resolvePatterns(deps.effectiveModelPatterns(agent)),
	}));
}

/** Save (or with an empty/absent `model`, clear) the `task.agentModelOverrides` entry for `agent`. */
export async function setRpcAgentModel(session: AgentSession, agent: string, model: string | undefined): Promise<void> {
	const deps = hubDeps(session);
	const agents = await deps.loadAgents();
	if (!agents.some(entry => entry.name === agent)) throw new Error(`Unknown agent: ${agent}`);
	const value = model?.trim();
	deps.setAgentOverride("model", agent, value ? value : undefined);
}

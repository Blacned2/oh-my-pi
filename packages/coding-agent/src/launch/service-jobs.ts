/**
 * Services a session started through `bash name=…` live in the launch broker, not in the
 * `AsyncJobManager`, so job listings would miss them. These helpers present a session's own
 * services as job rows (and stop one by name) for clients that render a background-jobs panel.
 */
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { AsyncJobSnapshotItem } from "../session/agent-session-types";
import { existingDaemonClientForProject } from "./client";

const DEFAULT_RECENT_LIMIT = 10;

function serviceJobStatus(daemon: DaemonSnapshot): AsyncJobSnapshotItem["status"] {
	if (!TERMINAL_STATES[daemon.state]) return "running";
	if (daemon.state === "failed" || (daemon.exitCode !== undefined && daemon.exitCode !== 0)) return "failed";
	return "completed";
}

function serviceJobRow(daemon: DaemonSnapshot): AsyncJobSnapshotItem {
	const status = serviceJobStatus(daemon);
	return {
		id: daemon.name,
		type: "bash",
		status,
		label: daemon.name,
		intent: daemon.name,
		startTime: daemon.startedAt,
		endTime: status === "running" ? undefined : (daemon.exitedAt ?? daemon.startedAt),
	};
}

/**
 * Running and recently ended services `owner` started in `cwd`'s project broker, as job rows.
 * Empty without contacting a broker when this process never opened a connection to it.
 */
export async function listServiceJobRows(
	cwd: string,
	owner: string,
	recentLimit = DEFAULT_RECENT_LIMIT,
): Promise<{ running: AsyncJobSnapshotItem[]; recent: AsyncJobSnapshotItem[] }> {
	const client = await existingDaemonClientForProject(cwd);
	if (!client) return { running: [], recent: [] };
	const result = await client.request({ op: "list" });
	if (result.op !== "list") return { running: [], recent: [] };
	const owned = result.daemons.filter(daemon => daemon.owner === owner);
	return {
		running: owned.filter(daemon => !TERMINAL_STATES[daemon.state]).map(serviceJobRow),
		recent: owned
			.filter(daemon => TERMINAL_STATES[daemon.state])
			.sort((left, right) => (right.exitedAt ?? right.createdAt) - (left.exitedAt ?? left.createdAt))
			.slice(0, recentLimit)
			.map(serviceJobRow),
	};
}

/** Stop the live service `name` that `owner` started. `false` when there is no such running service. */
export async function stopOwnedServiceJob(cwd: string, owner: string, name: string): Promise<boolean> {
	const client = await existingDaemonClientForProject(cwd);
	if (!client) return false;
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") return false;
	const daemon = listed.daemons.find(entry => entry.name === name && entry.owner === owner);
	if (!daemon || TERMINAL_STATES[daemon.state]) return false;
	await client.request({ op: "stop", name, timeoutMs: 5_000 });
	return true;
}

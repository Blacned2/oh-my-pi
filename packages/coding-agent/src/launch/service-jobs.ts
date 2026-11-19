/**
 * Services a session started through `bash name=…` live in the omp daemon as `proc` units, not
 * in the `AsyncJobManager`, so job listings would miss them. These helpers present a session's
 * own services as job rows (and stop one by name) for clients that render a background-jobs panel.
 */
import { TERMINAL_STATES } from "@oh-my-pi/pi-tui/apps/ps-data";
import { canonicalProjectDir, existingDaemonClient } from "../daemon/client";
import { projectScope, type UnitSnapshot } from "../daemon/protocol";
import type { AsyncJobSnapshotItem } from "../session/agent-session-types";

const DEFAULT_RECENT_LIMIT = 10;
/** Unit kind of every named service. */
const SERVICE_KIND = "proc";

function serviceJobStatus(unit: UnitSnapshot): AsyncJobSnapshotItem["status"] {
	if (!TERMINAL_STATES[unit.state]) return "running";
	// "failed" is an unexpected exit; "exited" with a nonzero code is a deliberate stop (SIGTERM/kill).
	if (unit.state === "failed") return "failed";
	return unit.exitCode !== undefined && unit.exitCode !== 0 ? "cancelled" : "completed";
}

function serviceJobRow(unit: UnitSnapshot): AsyncJobSnapshotItem {
	const status = serviceJobStatus(unit);
	return {
		id: unit.key,
		type: "bash",
		status,
		label: unit.key,
		intent: unit.key,
		startTime: unit.startedAt,
		endTime: status === "running" ? undefined : (unit.exitedAt ?? unit.startedAt),
	};
}

/** `owner`'s service units in `cwd`'s project; undefined when this process never connected to the daemon. */
async function ownedServiceUnits(cwd: string, owner: string): Promise<UnitSnapshot[] | undefined> {
	const client = await existingDaemonClient();
	if (!client) return undefined;
	const scope = projectScope(await canonicalProjectDir(cwd));
	const { units } = await client.request({ op: "list", scope, kind: SERVICE_KIND });
	return units.filter(unit => unit.owner === owner);
}

/**
 * Running and recently ended services `owner` started in `cwd`'s project, as job rows.
 * Empty without contacting the daemon when this process never opened a connection to it.
 */
export async function listServiceJobRows(
	cwd: string,
	owner: string,
	recentLimit = DEFAULT_RECENT_LIMIT,
): Promise<{ running: AsyncJobSnapshotItem[]; recent: AsyncJobSnapshotItem[] }> {
	const owned = await ownedServiceUnits(cwd, owner);
	if (!owned) return { running: [], recent: [] };
	return {
		running: owned.filter(unit => !TERMINAL_STATES[unit.state]).map(serviceJobRow),
		recent: owned
			.filter(unit => TERMINAL_STATES[unit.state])
			.sort((left, right) => (right.exitedAt ?? right.createdAt) - (left.exitedAt ?? left.createdAt))
			.slice(0, recentLimit)
			.map(serviceJobRow),
	};
}

/** Stop the live service `name` that `owner` started. `false` when there is no such running service. */
export async function stopOwnedServiceJob(cwd: string, owner: string, name: string): Promise<boolean> {
	const client = await existingDaemonClient();
	if (!client) return false;
	const scope = projectScope(await canonicalProjectDir(cwd));
	const { units } = await client.request({ op: "list", scope, kind: SERVICE_KIND });
	const unit = units.find(entry => entry.key === name && entry.owner === owner);
	if (!unit || TERMINAL_STATES[unit.state]) return false;
	await client.request({ op: "stop", unit: { kind: SERVICE_KIND, scope, key: name }, timeoutMs: 5_000 });
	return true;
}

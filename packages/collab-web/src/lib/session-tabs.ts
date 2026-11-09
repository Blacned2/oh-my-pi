/**
 * Recent-sessions tab model. A collab link embeds the room key (`roomid#key`), so the list lives in
 * `sessionStorage` (dies with the tab) rather than `localStorage`.
 */

export interface SessionTab {
	/**
	 * Join link. Empty for a tab discovered on this machine: its link is only
	 * asked of the host when the user selects the tab, so it never sits in state.
	 */
	link: string;
	name: string;
	title: string;
	/** Host instance this tab was discovered from or opened through. */
	hostId?: string;
	/** Room generation of that host; a host that rotates rooms is a new tab. */
	generation?: number;
}

/** A live session the local directory reported; carries no link. */
export interface DiscoveredSession {
	instanceId: string;
	generation: number;
	sessionName: string | null;
	cwd: string;
}

/** Stable identity of a tab: its link, or the host and generation for a link-less discovered one. */
export function tabKey(tab: SessionTab): string {
	return tab.link || `local:${tab.hostId}:${tab.generation}`;
}

export const MAX_SESSION_TABS = 8;
const STORAGE_KEY = "omp.collab.tabs";

function isTab(value: unknown): value is SessionTab {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.link === "string" &&
		v.link !== "" &&
		typeof v.name === "string" &&
		typeof v.title === "string" &&
		(v.hostId === undefined || typeof v.hostId === "string") &&
		(v.generation === undefined || typeof v.generation === "number")
	);
}

export function loadTabs(): SessionTab[] {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isTab).slice(0, MAX_SESSION_TABS) : [];
	} catch {
		return [];
	}
}

export function saveTabs(tabs: readonly SessionTab[]): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
	} catch {
		// storage unavailable — tabs just won't survive a reload
	}
}

/** Adds or refreshes a tab (deduped by link). The newest tab goes last; the oldest is dropped past the cap. */
export function upsertTab(tabs: readonly SessionTab[], tab: SessionTab): SessionTab[] {
	const existing = tabs.find(t => t.link === tab.link);
	if (existing) {
		return tabs.map(t =>
			t.link === tab.link
				? {
						...t,
						name: tab.name,
						title: tab.title || t.title,
						hostId: tab.hostId ?? t.hostId,
						generation: tab.generation ?? t.generation,
					}
				: t,
		);
	}
	const next = [...tabs, { ...tab, title: tab.title || "session" }];
	return next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next;
}

export function removeTab(tabs: readonly SessionTab[], link: string): SessionTab[] {
	return tabs.filter(t => t.link !== link);
}

/** The tab to activate after closing the tab with `key`: the right neighbour, else the left one, else null. */
export function neighbourTab(tabs: readonly SessionTab[], key: string): SessionTab | null {
	const i = tabs.findIndex(t => tabKey(t) === key);
	if (i < 0) return null;
	return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

function basename(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

/**
 * The tabs to show: the tabs joined or pasted in this browser first, then the
 * host's live sessions that none of them already represents. A session is
 * represented by a manual tab opened through the same host and room
 * generation; a rotated room is a new session. `dismissed` keys (from
 * {@link tabKey}) hide a discovered tab the user closed.
 */
export function mergeDiscoveredTabs(
	manual: readonly SessionTab[],
	discovered: readonly DiscoveredSession[],
	dismissed: ReadonlySet<string>,
): SessionTab[] {
	const merged = [...manual];
	for (const session of discovered) {
		if (manual.some(t => t.hostId === session.instanceId && t.generation === session.generation)) continue;
		const tab: SessionTab = {
			link: "",
			name: "",
			title: session.sessionName || basename(session.cwd) || "session",
			hostId: session.instanceId,
			generation: session.generation,
		};
		if (!dismissed.has(tabKey(tab))) merged.push(tab);
	}
	return merged;
}

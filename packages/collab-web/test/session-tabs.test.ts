import { describe, expect, it } from "bun:test";
import {
	type DiscoveredSession,
	MAX_SESSION_TABS,
	mergeDiscoveredTabs,
	neighbourTab,
	removeTab,
	type SessionTab,
	tabKey,
	upsertTab,
} from "../src/lib/session-tabs";

const tab = (n: number, title = `t${n}`): SessionTab => ({ link: `room${n}#key`, name: "guest", title });

describe("session tabs", () => {
	it("re-joining a link refreshes its tab instead of duplicating it, keeping the title when the new one is empty", () => {
		const tabs = upsertTab([tab(1, "first")], { ...tab(1), title: "" });
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.title).toBe("first");
		expect(upsertTab(tabs, tab(1, "renamed"))[0]?.title).toBe("renamed");
	});

	it("drops the oldest tab past the cap", () => {
		let tabs: SessionTab[] = [];
		for (let i = 0; i < MAX_SESSION_TABS + 2; i++) tabs = upsertTab(tabs, tab(i));
		expect(tabs).toHaveLength(MAX_SESSION_TABS);
		expect(tabs[0]?.link).toBe("room2#key");
	});

	it("picks the right neighbour, then the left, after a close", () => {
		const tabs = [tab(1), tab(2), tab(3)];
		expect(neighbourTab(tabs, "room2#key")?.link).toBe("room3#key");
		expect(neighbourTab(tabs, "room3#key")?.link).toBe("room2#key");
		expect(neighbourTab([tab(1)], "room1#key")).toBeNull();
		expect(removeTab(tabs, "room2#key").map(t => t.link)).toEqual(["room1#key", "room3#key"]);
	});
});

describe("discovered session tabs", () => {
	const session = (id: string, generation = 1, over: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
		instanceId: id,
		generation,
		sessionName: null,
		cwd: "/work/project",
		...over,
	});
	const none = new Set<string>();

	it("appends live sessions after the pasted tabs as link-less tabs, titled by name or folder", () => {
		const merged = mergeDiscoveredTabs(
			[tab(1)],
			[session("host-aaaa", 1, { sessionName: "Refactor" }), session("host-bbbb", 2, { cwd: "C:\\Work\\kostomp" })],
			none,
		);
		expect(merged.map(t => t.title)).toEqual(["t1", "Refactor", "kostomp"]);
		expect(merged.slice(1).every(t => t.link === "")).toBe(true);
		expect(merged[2]).toMatchObject({ hostId: "host-bbbb", generation: 2 });
	});

	it("hides a live session already opened as a manual tab, but a rotated room shows up again", () => {
		const opened: SessionTab = { ...tab(1), hostId: "host-aaaa", generation: 1 };
		expect(mergeDiscoveredTabs([opened], [session("host-aaaa", 1)], none)).toHaveLength(1);
		const rotated = mergeDiscoveredTabs([opened], [session("host-aaaa", 2)], none);
		expect(rotated).toHaveLength(2);
		expect(rotated[1]?.generation).toBe(2);
	});

	it("keeps a closed discovered tab hidden for its generation only", () => {
		const closed = new Set([tabKey({ link: "", name: "", title: "", hostId: "host-aaaa", generation: 1 })]);
		expect(mergeDiscoveredTabs([], [session("host-aaaa", 1)], closed)).toEqual([]);
		expect(mergeDiscoveredTabs([], [session("host-aaaa", 2)], closed)).toHaveLength(1);
	});

	it("keys discovered tabs apart from each other and from links, so closing one picks the right neighbour", () => {
		const merged = mergeDiscoveredTabs([tab(1)], [session("host-aaaa"), session("host-bbbb")], none);
		const keys = merged.map(tabKey);
		expect(new Set(keys).size).toBe(3);
		const second = keys[1];
		if (!second) throw new Error("expected a discovered tab");
		expect(neighbourTab(merged, second)?.hostId).toBe("host-bbbb");
		expect(neighbourTab(merged, keys[2] ?? "")?.hostId).toBe("host-aaaa");
	});
});

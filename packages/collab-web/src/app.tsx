import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { useI18n } from "./lib/i18n";
import { DirectoryError, fetchLocalLink } from "./lib/local-directory";
import {
	loadTabs,
	mergeDiscoveredTabs,
	neighbourTab,
	removeTab,
	type SessionTab,
	saveTabs,
	tabKey,
	upsertTab,
} from "./lib/session-tabs";
import { useGuestSnapshot } from "./lib/use-guest";
import { useLocalSessions } from "./lib/use-local-sessions";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";

interface Creds {
	link: string;
	name: string;
}

/** Host and room generation a link was resolved from, remembered on its tab. */
interface TabOrigin {
	hostId: string;
	generation: number;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [tabs, setTabs] = useState<SessionTab[]>(loadTabs);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const [activeLink, setActiveLink] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);
	const local = useLocalSessions();
	const { t } = useI18n();

	useEffect(() => {
		saveTabs(tabs);
	}, [tabs]);

	// Only the pasted/opened tabs are persisted; discovered ones are re-listed from the host.
	const shownTabs = useMemo(
		() => mergeDiscoveredTabs(tabs, local.sessions, dismissed),
		[tabs, local.sessions, dismissed],
	);

	const connect = useCallback((link: string, name: string, origin?: TabOrigin): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setTabs(prev =>
			upsertTab(prev, { link, name, title: "", hostId: origin?.hostId, generation: origin?.generation }),
		);
		setActiveLink(link);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		setActiveLink(null);
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const selectTab = useCallback(
		(tab: SessionTab): void => {
			if (tab.link) {
				connect(tab.link, tab.name);
				return;
			}
			// Discovered tab: the host hands out its link only now, for this one session.
			const { hostId, generation } = tab;
			if (hostId === undefined || generation === undefined) return;
			void (async () => {
				const target = { instanceId: hostId, generation };
				try {
					let url: string;
					try {
						url = await fetchLocalLink(local.token, target, "control");
					} catch (err) {
						if (!(err instanceof DirectoryError) || err.code !== "access_unavailable") throw err;
						url = await fetchLocalLink(local.token, target, "view");
					}
					connect(url, storedName(), { hostId, generation });
				} catch {
					setConnectError(t("tabs.localFailed"));
				}
			})();
		},
		[connect, local.token, t],
	);

	const closeTab = useCallback(
		(tab: SessionTab): void => {
			// A discovered session stays listed by the host; remember the close so it doesn't come back.
			if (tab.hostId !== undefined && tab.generation !== undefined) {
				const dismissedKey = tabKey({
					link: "",
					name: "",
					title: "",
					hostId: tab.hostId,
					generation: tab.generation,
				});
				setDismissed(prev => new Set(prev).add(dismissedKey));
			}
			if (tab.link) setTabs(prev => removeTab(prev, tab.link));
			if (!tab.link || tab.link !== activeLink) return;
			const next = neighbourTab(shownTabs, tabKey(tab));
			if (next) selectTab(next);
			else leave();
		},
		[activeLink, shownTabs, selectTab, leave],
	);

	const renameTab = useCallback((link: string, title: string): void => {
		setTabs(prev =>
			prev.some(t => t.link === link && t.title !== title)
				? prev.map(t => (t.link === link ? { ...t, title } : t))
				: prev,
		);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client) {
		return (
			<ConnectScreen
				defaultName={storedName()}
				error={connectError}
				onConnect={connect}
				tabs={shownTabs}
				onSelectTab={selectTab}
				onCloseTab={closeTab}
				pairToken={local.token}
				pairProblem={local.problem}
				onPairToken={local.setToken}
			/>
		);
	}
	return (
		<Session
			client={client}
			tabs={shownTabs}
			activeLink={activeLink}
			onLeave={leave}
			onRejoin={rejoin}
			onSelectTab={selectTab}
			onCloseTab={closeTab}
			onRenameTab={renameTab}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	tabs: readonly SessionTab[];
	activeLink: string | null;
	onLeave(): void;
	onRejoin(): void;
	onSelectTab(tab: SessionTab): void;
	onCloseTab(tab: SessionTab): void;
	onRenameTab(link: string, title: string): void;
}

function Session({
	client,
	tabs,
	activeLink,
	onLeave,
	onRejoin,
	onSelectTab,
	onCloseTab,
	onRenameTab,
}: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);
	useEffect(() => {
		if (activeLink && snap.header?.title) onRenameTab(activeLink, snap.header.title);
	}, [activeLink, snap.header?.title, onRenameTab]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				tabs={tabs}
				activeLink={activeLink}
				onToggleRail={toggleRail}
				onLeave={onLeave}
				onSelectTab={onSelectTab}
				onCloseTab={onCloseTab}
				onNewTab={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail glass">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onLeave}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}

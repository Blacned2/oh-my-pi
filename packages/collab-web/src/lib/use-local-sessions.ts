import type { CollabDirectoryEntry } from "@oh-my-pi/pi-wire";
import { useCallback, useEffect, useState } from "react";
import { DirectoryError, fetchLocalSessions, loadDirectoryToken, saveDirectoryToken } from "./local-directory";

const POLL_MS = 5000;

export interface LocalSessions {
	token: string;
	sessions: readonly CollabDirectoryEntry[];
	/** `unauthorized` when the host rejected the saved token; `unreachable` while no host answers. */
	problem: "unauthorized" | "unreachable" | null;
	setToken(token: string): void;
}

/** Polls the loopback session directory while a token is saved and the page is visible. */
export function useLocalSessions(): LocalSessions {
	const [token, setTokenState] = useState(loadDirectoryToken);
	const [sessions, setSessions] = useState<readonly CollabDirectoryEntry[]>([]);
	const [problem, setProblem] = useState<LocalSessions["problem"]>(null);

	const setToken = useCallback((next: string): void => {
		const trimmed = next.trim();
		saveDirectoryToken(trimmed);
		setTokenState(trimmed);
		setProblem(null);
		if (!trimmed) setSessions([]);
	}, []);

	useEffect(() => {
		if (!token) return;
		const controller = new AbortController();
		const poll = async (): Promise<void> => {
			if (document.visibilityState === "hidden") return;
			try {
				const next = await fetchLocalSessions(token, controller.signal);
				setSessions(next);
				setProblem(null);
			} catch (err) {
				if (controller.signal.aborted) return;
				setSessions([]);
				setProblem(err instanceof DirectoryError && err.code === "unauthorized" ? "unauthorized" : "unreachable");
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), POLL_MS);
		return () => {
			clearInterval(timer);
			controller.abort();
		};
	}, [token]);

	return { token, sessions, problem, setToken };
}

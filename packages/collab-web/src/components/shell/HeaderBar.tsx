import type { SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { LogOut, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import { type MessageKey, useI18n } from "../../lib/i18n";
import type { SessionTab } from "../../lib/session-tabs";
import { OmpMark } from "./OmpMark";
import { SessionTabs } from "./SessionTabs";
import { SettingsMenu } from "./SettingsMenu";

const PHASE_LABEL: Record<ConnectionPhase, MessageKey> = {
	connecting: "phase.connecting",
	waiting: "phase.waiting",
	live: "phase.live",
	reconnecting: "phase.reconnecting",
	ended: "phase.ended",
};

export interface HeaderBarProps {
	header: SessionHeader | null;
	state: SessionState | null;
	phase: ConnectionPhase;
	readOnly: boolean;
	subCount: number;
	railOpen: boolean;
	tabs: readonly SessionTab[];
	activeLink: string | null;
	onToggleRail(): void;
	onLeave(): void;
	onSelectTab(tab: SessionTab): void;
	onCloseTab(tab: SessionTab): void;
	onNewTab(): void;
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const HeaderBar = memo(function HeaderBar({
	header,
	state,
	phase,
	readOnly,
	subCount,
	railOpen,
	tabs,
	activeLink,
	onToggleRail,
	onLeave,
	onSelectTab,
	onCloseTab,
	onNewTab,
}: HeaderBarProps): ReactNode {
	const { t } = useI18n();
	const title = header?.title ?? state?.sessionName ?? t("header.untitled");
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header glass">
			<div className="sh-tabbar">
				<span className="sh-brand" aria-label={t("brand.aria")}>
					<OmpMark />
				</span>
				<SessionTabs
					tabs={tabs}
					activeLink={activeLink}
					phase={phase}
					onSelect={onSelectTab}
					onClose={onCloseTab}
					onNew={onNewTab}
				/>
				<div className="sh-tabbar-right">
					{state && state.participants.length > 0 && (
						<span className="sh-avatars">
							{state.participants.map((p, i) => (
								<span
									key={`${p.name}:${i}`}
									className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
									title={`${p.name} · ${p.role}${p.readOnly ? ` · ${t("header.viewOnly")}` : ""}`}
								>
									{(p.name[0] ?? "?").toUpperCase()}
								</span>
							))}
						</span>
					)}
					<SettingsMenu tabs={tabs} activeLink={activeLink} onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
					<button
						type="button"
						className={
							railOpen ? "sh-btn sh-btn-icon sh-btn-on glass-control" : "sh-btn sh-btn-icon glass-control"
						}
						onClick={onToggleRail}
						title={railOpen ? t("header.hideAgents") : t("header.showAgents")}
					>
						<PanelRight size={14} />
						{subCount > 0 && <span className="sh-badge">{subCount}</span>}
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon glass-control"
						onClick={onLeave}
						title={t("header.leave")}
					>
						<LogOut size={14} />
					</button>
				</div>
			</div>
			<div className="sh-info">
				<div className="sh-info-left">
					<span className="sh-title" title={title}>
						{title}
					</span>
					{state?.cwd && (
						<span className="sh-cwd" title={state.cwd}>
							{shortenPath(state.cwd)}
						</span>
					)}
				</div>
				<div className="sh-info-right">
					<span
						className={`sh-status sh-status-${phase} glass-pill`}
						title={t("header.connection", { phase: t(PHASE_LABEL[phase]) })}
					>
						<span className={`sh-dot sh-dot-${phase}`} />
						{t(PHASE_LABEL[phase])}
					</span>
					{readOnly && (
						<span className="sh-chip glass-pill" title={t("header.readOnlyHint")}>
							{t("header.readOnly")}
						</span>
					)}
					{state?.model && <span className="sh-chip sh-chip-meta glass-pill">{state.model.name}</span>}
					{state?.thinkingLevel && <span className="sh-chip sh-chip-meta glass-pill">{state.thinkingLevel}</span>}
					{pct != null && (
						<span
							className={pct > 80 ? "sh-gauge sh-gauge-warn glass-pill" : "sh-gauge glass-pill"}
							title={t("header.context", { percent: fmtPercent(pct) })}
						>
							<span className="sh-gauge-track">
								<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
							</span>
							<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
						</span>
					)}
				</div>
			</div>
		</header>
	);
});

import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { useI18n } from "../../lib/i18n";
import { type SessionTab, tabKey } from "../../lib/session-tabs";

export interface SessionTabsProps {
	tabs: readonly SessionTab[];
	activeLink: string | null;
	phase: ConnectionPhase;
	onSelect(tab: SessionTab): void;
	onClose(tab: SessionTab): void;
	onNew(): void;
}

/** Sessions joined in this browser tab. Only the active one holds a live connection; the rest reconnect on click. */
export const SessionTabs = memo(function SessionTabs({
	tabs,
	activeLink,
	phase,
	onSelect,
	onClose,
	onNew,
}: SessionTabsProps): ReactNode {
	const { t } = useI18n();
	return (
		<div className="sh-tabs" role="tablist" aria-label={t("tabs.aria")}>
			{tabs.map(tab => {
				const active = tab.link !== "" && tab.link === activeLink;
				return (
					<div
						key={tabKey(tab)}
						className={active ? "sh-tab sh-tab-active glass-control" : "sh-tab glass-control"}
					>
						<button
							type="button"
							role="tab"
							aria-selected={active}
							className="sh-tab-main"
							title={tab.title}
							onClick={() => (active ? undefined : onSelect(tab))}
						>
							<span className={active ? `sh-dot sh-dot-${phase}` : "sh-dot sh-dot-idle"} />
							<span className="sh-tab-title">{tab.title}</span>
						</button>
						<button
							type="button"
							className="sh-tab-close"
							aria-label={t("tabs.closeNamed", { title: tab.title })}
							title={t("tabs.close")}
							onClick={() => onClose(tab)}
						>
							<X size={12} />
						</button>
					</div>
				);
			})}
			<button type="button" className="sh-tab-new" onClick={onNew} title={t("tabs.new")} aria-label={t("tabs.new")}>
				<Plus size={14} />
			</button>
		</div>
	);
});

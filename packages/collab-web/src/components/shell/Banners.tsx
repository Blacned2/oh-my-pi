import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import { useI18n } from "../../lib/i18n";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	loading: GuestSnapshot["loading"];
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, loading, onRejoin, onNewLink }: BannersProps): ReactNode {
	const { t } = useI18n();
	const progress = loading && loading.total > 0 ? ` ${Math.floor((loading.received / loading.total) * 100)}%` : "";
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner glass" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting" ? t("banner.connecting") : t("banner.joining", { progress })}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner glass" role="status">
				<span className="sh-banner-dot" />
				{t("banner.reconnecting", { progress })}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label={t("banner.ended")}>
				<div className="sh-ended-card glass">
					<div className="sh-ended-title">{t("banner.ended")}</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary glass-control" onClick={onRejoin}>
							{t("banner.rejoin")}
						</button>
						<button type="button" className="sh-btn glass-control" onClick={onNewLink}>
							{t("banner.newLink")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}

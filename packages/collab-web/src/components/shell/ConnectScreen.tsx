import { ArrowRight, Lock } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import type { SessionTab } from "../../lib/session-tabs";
import { OmpMark } from "./OmpMark";
import { SessionTabs } from "./SessionTabs";
import { SettingsMenu } from "./SettingsMenu";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
	/** Sessions already joined in this browser tab; shown as a strip so "+" doesn't lose them. */
	tabs?: readonly SessionTab[];
	onSelectTab?(tab: SessionTab): void;
	onCloseTab?(tab: SessionTab): void;
	/** Token pairing this page with the omp hosts on this machine; empty until pasted. */
	pairToken?: string;
	pairProblem?: "unauthorized" | "unreachable" | null;
	onPairToken?(token: string): void;
}

export function ConnectScreen({
	defaultName,
	error,
	onConnect,
	tabs = [],
	onSelectTab,
	onCloseTab,
	pairToken = "",
	pairProblem = null,
	onPairToken,
}: ConnectScreenProps): ReactNode {
	const { t } = useI18n();
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [pairDraft, setPairDraft] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError(t("connect.empty"));
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || t("connect.namePlaceholder"));
	};

	const shown = localError ?? error;

	return (
		<div className="sh-connect">
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand">
					<OmpMark />
					<span>omp</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">collab</span>
				</div>
				<SettingsMenu tabs={tabs} onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
			</div>
			{tabs.length > 0 && (
				<div className="sh-connect-tabs">
					<SessionTabs
						tabs={tabs}
						activeLink={null}
						phase="ended"
						onSelect={tab => onSelectTab?.(tab)}
						onClose={tab => onCloseTab?.(tab)}
						onNew={() => undefined}
					/>
				</div>
			)}
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<h1 className="sh-connect-title">{t("connect.title")}</h1>
					<p className="sh-connect-sub">{t("connect.sub")}</p>
				</div>
				<label className="sh-field">
					<span className="sh-field-label">{t("connect.link")}</span>
					<input
						className="sh-input sh-input-mono"
						type="text"
						value={link}
						onChange={e => setLink(e.target.value)}
						placeholder="ws://host:port/r/room.key"
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">{t("connect.linkHint", { cmd: "/collab" })}</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">{t("connect.name")}</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder={t("connect.namePlaceholder")}
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{onPairToken && (
					<label className="sh-field">
						<span className="sh-field-label">{t("connect.pair")}</span>
						{pairToken ? (
							<button type="button" className="sh-btn" onClick={() => onPairToken("")}>
								{t("connect.pairForget")}
							</button>
						) : (
							<input
								className="sh-input sh-input-mono"
								type="password"
								value={pairDraft}
								onChange={e => setPairDraft(e.target.value)}
								onPaste={e => {
									const pasted = e.clipboardData.getData("text").trim();
									if (!pasted) return;
									e.preventDefault();
									onPairToken(pasted);
								}}
								onBlur={() => {
									if (pairDraft.trim()) onPairToken(pairDraft);
								}}
								spellCheck={false}
								autoComplete="off"
							/>
						)}
						<span className="sh-field-hint">
							{pairProblem === "unauthorized"
								? t("connect.pairUnauthorized", { cmd: "omp collab pair" })
								: pairProblem === "unreachable"
									? t("connect.pairUnreachable")
									: t("connect.pairHint", { cmd: "omp collab pair" })}
						</span>
					</label>
				)}
				{shown && <div className="sh-connect-error">{shown}</div>}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					{t("connect.submit")} <ArrowRight size={14} />
				</button>
				<div className="sh-connect-foot">
					<Lock size={12} />
					{t("connect.foot")}
				</div>
			</form>
		</div>
	);
}

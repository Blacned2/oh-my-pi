import { Monitor, Moon, Settings, Sun, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { LOCALE_NAME, LOCALES, type MessageKey, useI18n } from "../../lib/i18n";
import { type SessionTab, tabKey } from "../../lib/session-tabs";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

const THEMES: readonly { value: ThemePreference; icon: typeof Sun; label: MessageKey }[] = [
	{ value: "system", icon: Monitor, label: "theme.system" },
	{ value: "light", icon: Sun, label: "theme.light" },
	{ value: "dark", icon: Moon, label: "theme.dark" },
];

export interface SettingsMenuProps {
	/** Sessions joined in this browser tab. */
	tabs?: readonly SessionTab[];
	activeLink?: string | null;
	onSelectTab?(tab: SessionTab): void;
	onCloseTab?(tab: SessionTab): void;
}

/** Gear button + popover: interface language, theme, and the sessions joined in this browser tab. */
export function SettingsMenu({ tabs = [], activeLink = null, onSelectTab, onCloseTab }: SettingsMenuProps): ReactNode {
	const { t, locale, setLocale } = useI18n();
	const { preference, setPreference } = useThemePreference();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent): void => {
			if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="sh-settings" ref={rootRef}>
			<button
				type="button"
				className={open ? "sh-theme-toggle sh-theme-toggle-on" : "sh-theme-toggle"}
				onClick={() => setOpen(v => !v)}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={t("settings.open")}
				title={t("settings.open")}
			>
				<Settings size={16} />
			</button>
			{open && (
				<div className="sh-settings-pop" role="dialog" aria-label={t("settings.title")}>
					<div className="sh-settings-head">
						<span className="sh-settings-title">{t("settings.title")}</span>
						<button
							type="button"
							className="sh-settings-x"
							onClick={() => setOpen(false)}
							aria-label={t("settings.close")}
							title={t("settings.close")}
						>
							<X size={14} />
						</button>
					</div>

					<div className="sh-settings-group">
						<span className="sh-settings-label">{t("settings.language")}</span>
						<div className="sh-seg" role="radiogroup" aria-label={t("settings.language")}>
							{LOCALES.map(code => (
								<button
									key={code}
									type="button"
									role="radio"
									aria-checked={locale === code}
									className={locale === code ? "sh-seg-btn sh-seg-on" : "sh-seg-btn"}
									onClick={() => setLocale(code)}
								>
									{LOCALE_NAME[code]}
								</button>
							))}
						</div>
					</div>

					<div className="sh-settings-group">
						<span className="sh-settings-label">{t("theme.label")}</span>
						<div className="sh-seg" role="radiogroup" aria-label={t("theme.label")}>
							{THEMES.map(({ value, icon: Icon, label }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={preference === value}
									className={preference === value ? "sh-seg-btn sh-seg-on" : "sh-seg-btn"}
									onClick={() => setPreference(value)}
								>
									<Icon size={13} />
									{t(label)}
								</button>
							))}
						</div>
					</div>

					<div className="sh-settings-group">
						<span className="sh-settings-label">{t("settings.sessions")}</span>
						{tabs.length === 0 ? (
							<p className="sh-settings-empty">{t("settings.sessionsEmpty")}</p>
						) : (
							<ul className="sh-settings-sessions">
								{tabs.map(tab => {
									const active = tab.link !== "" && tab.link === activeLink;
									return (
										<li key={tabKey(tab)} className={active ? "sh-sess sh-sess-active" : "sh-sess"}>
											<div className="sh-sess-info">
												<span className="sh-sess-title" title={tab.title}>
													{tab.title}
												</span>
												<span className="sh-sess-meta">
													{tab.name}
													{active ? ` · ${t("settings.sessionActive")}` : ""}
												</span>
											</div>
											{!active && onSelectTab && (
												<button
													type="button"
													className="sh-btn sh-sess-btn"
													onClick={() => {
														setOpen(false);
														onSelectTab(tab);
													}}
												>
													{t("settings.sessionOpen")}
												</button>
											)}
											{onCloseTab && (
												<button
													type="button"
													className="sh-btn sh-sess-btn"
													onClick={() => onCloseTab(tab)}
													aria-label={`${t("settings.sessionRemove")}: ${tab.title}`}
												>
													{t("settings.sessionRemove")}
												</button>
											)}
										</li>
									);
								})}
							</ul>
						)}
						<p className="sh-settings-note">{t("settings.sessionsNote")}</p>
					</div>
				</div>
			)}
		</div>
	);
}

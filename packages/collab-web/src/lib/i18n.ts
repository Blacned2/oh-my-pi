import { useSyncExternalStore } from "react";

/**
 * Interface language. Turkish is the default; the choice persists in `localStorage`. Covers the
 * guest shell (connect screen, header, tabs, composer, banners, transcript chrome). Tool renderers
 * are shared with the HTML session export and stay English.
 */
export type Locale = "tr" | "en";

export const LOCALES: readonly Locale[] = ["tr", "en"];
export const DEFAULT_LOCALE: Locale = "tr";

/** Native names, shown in the language picker regardless of the active locale. */
export const LOCALE_NAME: Readonly<Record<Locale, string>> = { tr: "Türkçe", en: "English" };

const STORAGE_KEY = "omp-collab-locale";

const en = {
	"brand.aria": "omp collab",
	"theme.label": "Theme",
	"theme.system": "System",
	"theme.light": "Light",
	"theme.dark": "Dark",
	"settings.open": "Settings",
	"settings.title": "Settings",
	"settings.close": "Close",
	"settings.language": "Language",
	"settings.sessions": "My sessions",
	"settings.sessionsEmpty": "You have not joined any session in this browser tab yet.",
	"settings.sessionActive": "active",
	"settings.sessionOpen": "Open",
	"settings.sessionRemove": "Remove",
	"settings.sessionsNote": "Kept only while this browser tab is open; the join link holds the room key.",
	"phase.connecting": "Connecting",
	"phase.waiting": "Joining",
	"phase.live": "Live",
	"phase.reconnecting": "Reconnecting",
	"phase.ended": "Ended",
	"header.hideAgents": "hide agents",
	"header.showAgents": "show agents",
	"header.leave": "leave session",
	"header.connection": "connection: {phase}",
	"header.readOnly": "read-only",
	"header.readOnlyHint": "you joined with a read-only link — watching only",
	"header.viewOnly": "view-only",
	"header.context": "context · {percent}",
	"header.untitled": "session",
	"tabs.aria": "sessions",
	"tabs.close": "close tab",
	"tabs.closeNamed": "close {title}",
	"tabs.new": "join another session",
	"connect.title": "Join a live session",
	"connect.sub":
		"Watch an omp agent work in real time — transcript, tool calls and subagents — and prompt it from here.",
	"connect.link": "Join link",
	"connect.linkHint": "Run {cmd} in any omp session to get one.",
	"connect.name": "Display name",
	"connect.namePlaceholder": "guest",
	"connect.submit": "Connect",
	"connect.empty": "Paste a join link first.",
	"connect.pair": "Local sessions token",
	"connect.pairHint": "Run {cmd} on this machine and paste the token to list its live sessions as tabs.",
	"connect.pairUnauthorized": "The host rejected this token. Run {cmd} again.",
	"connect.pairUnreachable": "No omp host answered on this machine.",
	"connect.pairForget": "Forget token",
	"tabs.localFailed": "Could not open that session. It may have ended; try again.",
	"connect.foot": "End-to-end encrypted. The room key stays in the link and never reaches the relay.",
	"banner.connecting": "Connecting to relay…",
	"banner.joining": "Joining session…{progress}",
	"banner.reconnecting": "Reconnecting…{progress}",
	"banner.ended": "Session ended",
	"banner.rejoin": "Rejoin",
	"banner.newLink": "New link",
	"composer.askPlaceholder": "type your response…",
	"composer.submit": "Submit",
	"composer.submitTitle": "submit response",
	"composer.cancel": "Cancel",
	"composer.stop": "Stop",
	"composer.stopTitle": "stop the current turn",
	"composer.send": "Send",
	"composer.sendTitle": "send (Enter)",
	"composer.queued": "queued ",
	"composer.readOnlyPlaceholder": "Read-only session — watching only",
	"composer.livePlaceholder": "Prompt the host agent…",
	"composer.waitingPlaceholder": "Waiting for the session…",
	"composer.hint": "Enter sends · Shift+Enter new line · ↑ history",
	"composer.hintReadOnly": "Read-only",
	"transcript.empty": "no activity yet",
	"transcript.thinking": "thinking…",
	"transcript.branchSummary": "branch summary",
	"transcript.compacted": "context compacted · {tokens} tokens",
	"transcript.showEarlier": "show {count} earlier",
	"transcript.toBottom": "Back to bottom",
	"toast.dismiss": "dismiss",
	"agents.session": "Session",
	"agents.none": "No subagents yet",
	"agents.close": "close",
	"agents.cost": "cost",
	"agents.tools": "tools",
	"agents.noTranscript": "no transcript available",
	"agents.messagePlaceholder": "message {name}…",
	"agents.send": "send",
} as const;

export type MessageKey = keyof typeof en;

const tr: Readonly<Record<MessageKey, string>> = {
	"brand.aria": "omp collab",
	"theme.label": "Tema",
	"theme.system": "Sistem",
	"theme.light": "Açık",
	"theme.dark": "Koyu",
	"settings.open": "Ayarlar",
	"settings.title": "Ayarlar",
	"settings.close": "Kapat",
	"settings.language": "Dil",
	"settings.sessions": "Oturumlarım",
	"settings.sessionsEmpty": "Bu tarayıcı sekmesinde henüz bir oturuma katılmadın.",
	"settings.sessionActive": "aktif",
	"settings.sessionOpen": "Aç",
	"settings.sessionRemove": "Kaldır",
	"settings.sessionsNote": "Yalnızca bu tarayıcı sekmesi açıkken saklanır; katılım linki oda anahtarını içerir.",
	"phase.connecting": "Bağlanıyor",
	"phase.waiting": "Katılıyor",
	"phase.live": "Canlı",
	"phase.reconnecting": "Yeniden bağlanıyor",
	"phase.ended": "Bitti",
	"header.hideAgents": "ajanları gizle",
	"header.showAgents": "ajanları göster",
	"header.leave": "oturumdan ayrıl",
	"header.connection": "bağlantı: {phase}",
	"header.readOnly": "salt okunur",
	"header.readOnlyHint": "salt okunur linkle katıldın — yalnızca izliyorsun",
	"header.viewOnly": "yalnızca izleyici",
	"header.context": "bağlam · {percent}",
	"header.untitled": "oturum",
	"tabs.aria": "oturumlar",
	"tabs.close": "sekmeyi kapat",
	"tabs.closeNamed": "{title} sekmesini kapat",
	"tabs.new": "başka bir oturuma katıl",
	"connect.title": "Canlı bir oturuma katıl",
	"connect.sub":
		"Bir omp ajanını gerçek zamanlı izle — konuşma, araç çağrıları ve alt ajanlar — ve buradan komut ver.",
	"connect.link": "Katılım linki",
	"connect.linkHint": "Link almak için herhangi bir omp oturumunda {cmd} çalıştır.",
	"connect.name": "Görünen ad",
	"connect.namePlaceholder": "misafir",
	"connect.submit": "Bağlan",
	"connect.empty": "Önce bir katılım linki yapıştır.",
	"connect.pair": "Yerel oturum anahtarı",
	"connect.pairHint": "Bu makinede {cmd} çalıştırıp çıkan anahtarı yapıştır; canlı oturumlar sekme olarak listelenir.",
	"connect.pairUnauthorized": "Host bu anahtarı reddetti. {cmd} komutunu yeniden çalıştır.",
	"connect.pairUnreachable": "Bu makinede yanıt veren bir omp host'u yok.",
	"connect.pairForget": "Anahtarı sil",
	"tabs.localFailed": "Oturum açılamadı. Bitmiş olabilir; yeniden dene.",
	"connect.foot": "Uçtan uca şifreli. Oda anahtarı linkte kalır, röleye hiç ulaşmaz.",
	"banner.connecting": "Röleye bağlanılıyor…",
	"banner.joining": "Oturuma katılınıyor…{progress}",
	"banner.reconnecting": "Yeniden bağlanılıyor…{progress}",
	"banner.ended": "Oturum bitti",
	"banner.rejoin": "Yeniden katıl",
	"banner.newLink": "Yeni link",
	"composer.askPlaceholder": "yanıtını yaz…",
	"composer.submit": "Gönder",
	"composer.submitTitle": "yanıtı gönder",
	"composer.cancel": "Vazgeç",
	"composer.stop": "Durdur",
	"composer.stopTitle": "çalışan turu durdur",
	"composer.send": "Gönder",
	"composer.sendTitle": "gönder (Enter)",
	"composer.queued": "sırada ",
	"composer.readOnlyPlaceholder": "Salt okunur oturum — yalnızca izliyorsun",
	"composer.livePlaceholder": "Host ajana komut ver…",
	"composer.waitingPlaceholder": "Oturum bekleniyor…",
	"composer.hint": "Enter gönderir · Shift+Enter yeni satır · ↑ geçmiş",
	"composer.hintReadOnly": "Salt okunur",
	"transcript.empty": "henüz hareket yok",
	"transcript.thinking": "düşünüyor…",
	"transcript.branchSummary": "dal özeti",
	"transcript.compacted": "bağlam sıkıştırıldı · {tokens} token",
	"transcript.showEarlier": "{count} öncekini göster",
	"transcript.toBottom": "En alta git",
	"toast.dismiss": "kapat",
	"agents.session": "Oturum",
	"agents.none": "Henüz alt ajan yok",
	"agents.close": "kapat",
	"agents.cost": "maliyet",
	"agents.tools": "araçlar",
	"agents.noTranscript": "konuşma kaydı yok",
	"agents.messagePlaceholder": "{name} ajanına mesaj…",
	"agents.send": "gönder",
};

const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { tr, en };

export type MessageParams = Readonly<Record<string, string | number>>;

/** Looks up `key` in `locale` and fills `{name}` placeholders from `params`. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
	const template = MESSAGES[locale][key];
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}

function isLocale(value: unknown): value is Locale {
	return value === "tr" || value === "en";
}

function readStoredLocale(): Locale {
	try {
		const stored = globalThis.localStorage.getItem(STORAGE_KEY);
		return isLocale(stored) ? stored : DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

let locale: Locale = readStoredLocale();
const listeners = new Set<() => void>();

function applyDocumentLanguage(): void {
	if (typeof document !== "undefined") document.documentElement.lang = locale;
}

applyDocumentLanguage();

export function getLocale(): Locale {
	return locale;
}

export function setLocale(next: Locale): void {
	locale = next;
	try {
		globalThis.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Persistence is best-effort; the in-memory choice still applies.
	}
	applyDocumentLanguage();
	for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Active locale plus a bound `t()`; re-renders the caller when the language changes. */
export function useI18n(): { locale: Locale; t: Translate; setLocale: (next: Locale) => void } {
	const current = useSyncExternalStore(subscribe, () => locale, getLocale);
	return {
		locale: current,
		t: (key, params) => translate(current, key, params),
		setLocale,
	};
}

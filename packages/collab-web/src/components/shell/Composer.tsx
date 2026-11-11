import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import { useI18n } from "../../lib/i18n";
import { loadPromptHistory, pushPrompt, savePromptHistory } from "../../lib/prompt-history";

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const { t } = useI18n();
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner glass">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder={t("composer.askPlaceholder")}
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary glass-control"
					onClick={() => onSubmit(draft)}
					title={t("composer.submitTitle")}
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">{t("composer.submit")}</span>
				</button>
			</div>
		</div>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
}: ComposerProps): ReactNode {
	const { t } = useI18n();
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const queued = queuedMessageCount;
	const canSend = canPrompt && text.trim().length > 0;

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);

	// In-memory recall of this session's sent prompts (newest last). `historyIndexRef` is -1
	// while the user is editing a fresh draft, which is stashed in `draftRef` during recall.
	const historyRef = useRef<string[] | null>(null);
	historyRef.current ??= loadPromptHistory();
	const historyIndexRef = useRef(-1);
	const draftRef = useRef("");

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		historyRef.current = pushPrompt(historyRef.current ?? [], trimmed);
		savePromptHistory(historyRef.current);
		historyIndexRef.current = -1;
		draftRef.current = "";
		setText("");
	}, [client, live, readOnly, text]);

	const recall = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
		const history = historyRef.current ?? [];
		const el = e.currentTarget;
		const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
		const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
		if (e.key === "ArrowUp" && history.length > 0 && (atStart || historyIndexRef.current >= 0 || !el.value)) {
			if (historyIndexRef.current === -1) {
				draftRef.current = el.value;
				historyIndexRef.current = history.length - 1;
			} else if (historyIndexRef.current > 0) {
				historyIndexRef.current -= 1;
			}
			setText(history[historyIndexRef.current] ?? "");
			return true;
		}
		if (e.key === "ArrowDown" && historyIndexRef.current >= 0 && atEnd) {
			if (historyIndexRef.current < history.length - 1) {
				historyIndexRef.current += 1;
				setText(history[historyIndexRef.current] ?? "");
			} else {
				historyIndexRef.current = -1;
				setText(draftRef.current);
			}
			return true;
		}
		return false;
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
			return;
		}
		if (!composingRef.current && !e.nativeEvent.isComposing && recall(e)) e.preventDefault();
	};

	if (uiRequest && canPrompt) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button
						type="button"
						className="sh-btn glass-control"
						onClick={() => client.sendUiResponse(uiRequest.reqId)}
					>
						{t("composer.cancel")}
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop glass-control"
							onClick={() => client.sendAbort()}
							disabled={!live}
							title={t("composer.stopTitle")}
						>
							<Square size={11} /> <span className="sh-btn-label">{t("composer.stop")}</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className={`sh-composer-inner glass${canPrompt ? "" : " sh-composer-inner-off"}`}>
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => {
						historyIndexRef.current = -1;
						setText(e.target.value);
					}}
					onKeyDown={onKeyDown}
					onCompositionStart={onCompositionStart}
					onCompositionEnd={onCompositionEnd}
					placeholder={
						readOnly
							? t("composer.readOnlyPlaceholder")
							: live
								? t("composer.livePlaceholder")
								: t("composer.waitingPlaceholder")
					}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-bar">
					<span className="sh-composer-hint">
						{canPrompt ? t("composer.hint") : readOnly ? t("composer.hintReadOnly") : null}
					</span>
					<div className="sh-composer-actions">
						{busy && queued > 0 && (
							<span className="sh-queued">
								<span className="sh-queued-label">{t("composer.queued")}</span>×{queued}
							</span>
						)}
						{busy && !readOnly && (
							<button
								type="button"
								className="sh-btn sh-btn-stop glass-control"
								onClick={() => client.sendAbort()}
								disabled={!live}
								title={t("composer.stopTitle")}
							>
								<Square size={11} /> <span className="sh-btn-label">{t("composer.stop")}</span>
							</button>
						)}
						<button
							type="button"
							className="sh-btn sh-btn-send glass-control"
							onClick={send}
							disabled={!canSend}
							title={t("composer.sendTitle")}
						>
							<SendHorizontal size={12} /> <span className="sh-btn-label">{t("composer.send")}</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
});

import type { ReactNode } from "react";
import { useRef, useState } from "react";

export interface RailPrompt {
	id: string;
	text: string;
}

interface PromptRailProps {
	prompts: readonly RailPrompt[];
	activeId: string | null;
	onJump: (id: string) => void;
}

interface Hover {
	id: string;
	top: number;
}

/**
 * Left-edge prompt map: one tick per user prompt, the active one highlighted.
 * Hovering a tick previews the prompt text; clicking scrolls the transcript to it.
 */
export function PromptRail({ prompts, activeId, onJump }: PromptRailProps): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [hover, setHover] = useState<Hover | null>(null);
	const hovered = hover === null ? undefined : prompts.find(prompt => prompt.id === hover.id);

	return (
		<div className="tr-rail" ref={wrapRef} onMouseLeave={() => setHover(null)}>
			<div className="tr-rail-ticks">
				{prompts.map(prompt => (
					<button
						type="button"
						key={prompt.id}
						className={`tr-rail-tick${prompt.id === activeId ? " tr-rail-tick--active" : ""}`}
						aria-label={prompt.text.slice(0, 80)}
						onClick={() => onJump(prompt.id)}
						onMouseEnter={event => {
							const wrap = wrapRef.current;
							if (wrap === null) return;
							const rect = event.currentTarget.getBoundingClientRect();
							setHover({ id: prompt.id, top: rect.top + rect.height / 2 - wrap.getBoundingClientRect().top });
						}}
					/>
				))}
			</div>
			{hover !== null && hovered !== undefined && (
				<div className="tr-rail-card glass-control" style={{ top: hover.top }}>
					{hovered.text}
				</div>
			)}
		</div>
	);
}

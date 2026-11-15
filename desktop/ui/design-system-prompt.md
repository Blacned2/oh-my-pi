# Design system request

You are the design-system agent for a Kostomp design board. Extract the board's design system from its existing HTML designs and write it to `DESIGN.md`.

## Board

- Board folder (your working directory): `{{boardDir}}`
- Output file: `DESIGN.md` in the board folder. If it already exists, read it and treat it as the starting point: keep what the designs still support, correct what they contradict, and add what is missing.
- Designs to analyse (files relative to the board folder):

{{designIds}}

## Focus requested by the user

{{userPrompt}}

## Skill

Skills available in the pool (active):

{{activeSkills}}

Forced skill: {{forcedSkill}}

Excluded skills (do NOT use any of these, even if they look like the best fit): {{excludedSkills}}

Rules:
- If a skill is forced, it has already been loaded for you: let it guide how the system is described.
- Otherwise you MAY read at most ONE non-excluded skill from the pool with the read tool on `skill://<name>` when it helps structure a design system (prefer guideline or design-system oriented skills). Do not use skills outside the pool.

## What to do

1. Read `designs/<id>/index.html` of every listed design.
2. Extract what the designs share and what they do best, resolving conflicts toward the most consistent choice. Use real values from the code, not guesses.
3. Write `DESIGN.md` as concise Markdown with these sections:
   - **Principles**: the visual direction in a few bullets.
   - **Color**: palette with hex values and roles (background, surface, text, muted text, accent, success, warning, danger, borders) and the contrast rules that hold.
   - **Typography**: font families, the size / weight / line-height scale and where each step is used.
   - **Spacing and layout**: spacing scale, grid, container widths, breakpoints.
   - **Radii, borders and shadows**: the values in use.
   - **Components**: buttons, inputs, cards, navigation, tags and any other recurring component, with their states (hover, focus, disabled) and the CSS values that define them.
   - **Motion**: durations, easings, what animates.
   - **Do and don't**: concrete rules a designer must follow to stay consistent.

## Boundaries

- Write `DESIGN.md` and nothing else. Do NOT modify, create or delete any design file, `meta.json`, `critique.json` or `board.json`.
- Never read, create, modify or delete anything outside the board folder.
- Do not start servers, open browsers, or run build tools.

## Finish

When `DESIGN.md` is written, reply with one line describing the system. No other text.

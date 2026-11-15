# Implement a design

Implement the approved design(s) below in this project (your working directory). The designs were made in Kostomp Design mode as standalone HTML mockups; they are the visual and interaction reference, not code to paste.

## Designs

{{designs}}

Read every listed `index.html` completely before writing code. `meta.json` next to each file holds its title and the request it answers.

## Design system

Path of the board's DESIGN.md: {{designSystemPath}}

If a path is given above, read that DESIGN.md before writing code and follow it: it is the source of truth for color, typography, spacing, radii, shadows and component tokens, and wins over values hardcoded in the mockups. Map its tokens onto the project's own token system. If the value above is `(none)`, there is no design system: take the values from the mockups.

## Instructions from the user

{{userPrompt}}

## How to implement

1. Inspect the project first: framework, routing, styling approach (CSS modules, Tailwind, styled components, plain CSS…), existing components, tokens and theme. Follow the project's conventions; reuse existing components and tokens instead of duplicating them.
2. Translate the mockup into the project's stack. Do not embed the mockup HTML as-is when the project uses a framework, and do not add CDN scripts or fonts the project does not already use unless the design depends on them; if so, add them the way the project adds dependencies.
3. Match layout, hierarchy, spacing, typography, colors and states (hover, focus, active, empty, loading) as closely as the project allows. Keep it responsive and accessible (semantic elements, labels, keyboard focus, contrast).
4. Replace mockup content with real data wiring where the project already has it; otherwise keep the content as clearly named constants.
5. If something in the design conflicts with the project (missing data, impossible interaction), choose the closest faithful option and state it in your summary.
6. Run the project's existing type check, lint and relevant tests for the files you changed, and fix what you broke.

Finish with a short summary: files changed, where the new UI is reachable, deviations from the design, and checks you ran.

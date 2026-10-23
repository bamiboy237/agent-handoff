---
name: agent-handoff
description: Hand off your coding agent to the cloud.
colors:
  ground: "#0e0e0e"
  raised: "#191919"
  ink: "#ffffff"
  ink-1: "rgba(255, 255, 255, 0.9)"
  ink-2: "rgba(255, 255, 255, 0.62)"
  ink-3: "rgba(255, 255, 255, 0.5)"
  rule: "#202020"
  rule-strong: "#373737"
  veil: "rgba(255, 255, 255, 0.1)"
  accent: "#78e772"
  accent-soft: "rgba(120, 231, 114, 0.18)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 400
    lineHeight: 1.1
  heading:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: "34px"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "28px"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  code:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "14px"
  label:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "12px"
rounded:
  none: "0"
  window: "4px"
spacing:
  gutter: "20px"
  cell: "32px"
  section: "80px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#000000"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "28px"
    padding: "0 8px"
  button-ghost:
    backgroundColor: "{colors.veil}"
    textColor: "rgba(255, 255, 255, 0.8)"
    rounded: "{rounded.none}"
    height: "28px"
  command:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    typography: "{typography.code}"
    rounded: "{rounded.none}"
    height: "44px"
---

# agent-handoff design system

## Overview

A flat near-black sheet divided by hairlines. Type is small and light, borders do the structuring, and white is the one solid color. The page has four parts in a fixed order: hero, terminal demo, questions, footer. The look follows the restrained developer-tool style of dark, hairline-ruled sites: neutral ground, square corners, mono for anything you type or run, and one neon green for live state.

## Colors

- **Ground and raised:** neutral near-black `#0e0e0e`, with `#191919` for the footer band. No blue tint.
- **Inks:** white at 100% for headings and active labels, 90% for the headline, 62% for answers and the command, 50% for quiet labels. Every text color meets 4.5:1 on the ground and on the footer band.
- **Rules:** `#202020` for cell borders and grid gaps, `#373737` for control borders and inactive diagram nodes.
- **Accent (green):** used only for work in transit. That covers the `$` prompt, the traveled line, its head, and the active node. Never use it for decoration or as a button color.
- **Inside the demo only:** Claude Code orange and green, OpenCode blue and gray panels, and macOS traffic-light colors.

## Typography

- **Geist** (variable, self-hosted) carries headings, body, and answers. Weight stays at 400 everywhere. Hierarchy comes from size and opacity.
- **Geist Mono** (variable, self-hosted) is for the command, buttons, diagram labels, and the brand name. Labels are 12px and sentence case. Nothing is set in all caps.
- **Geist Pixel Grid** (self-hosted) sets the large wordmark in the footer, at 12% white, as decoration.
- **Paper Mono** is kept only inside the demo terminal, because the terminal's glyph widths were tuned to it.
- Scale: 12 label, 14 code, 16 body, 20 question, 28 section heading, 36 headline.

## Layout

- The page margin is 20px at every width. Content is at most 1400px, centered. The nav and hero use a 1440px outer limit.
- The nav is sticky and 64px tall with a blurred 72% ground. The brand sits left. A ghost GitHub icon button and the white Install button sit right.
- The hero is a 540px column: headline, then the install command in a 44px bordered box with a white copy button. A field of 1px dots thins out toward the left and bottom behind it.
- Demo and questions are bordered cells (`1px #202020`) 80px apart. The demo cell stacks the handoff diagram over a dotted stage that holds the terminal window, which is at most 1040px wide. The questions cell has a header row, then a six-column hairline grid: three cells across, then two.
- Cell padding is 32px on desktop and 20px on phones.
- At 960px and below the questions become two columns. At 720px and below they become one column, the diagram turns vertical, the window goes edge to edge, and nav buttons grow to 44px.
- The footer is a raised band with 60px side padding: logo mark and GitHub link on one row, the pixel wordmark, then the Install button and copyright.

## Elevation & Depth

- No shadows on controls or cells. Depth comes from hairlines and the raised footer. The terminal window has one soft ambient shadow and a `#373737` border.

## Shapes

- Square corners everywhere. The terminal window has a 4px radius, because it depicts a macOS window. Diagram nodes are 12px squares.

## Components

- **Install button:** white fill, black 12px mono text, 28px tall, with a chevron that nudges 2px right on hover. Hover lowers the fill to 88% white. Press scales to 0.97 over 160ms.
- **Ghost button:** 10% white fill, 12% white border, 80% white content. Hover raises fill, border, and content. The GitHub button is icon only.
- **Command:** `$` in green, the command in 62% white, and a white square copy button. The copy icon swaps to a check for 1.6 seconds. A hidden status line announces the result.
- **Handoff diagram:** `.demo[data-stage]` drives it, and demo.js sets stages 0 to 4. Three 12px nodes (laptop session, cloud sandbox, draft PR) joined by a dashed hairline. The traveled segment is a 1px green line that slides in over 2400ms, and a 5px green head marks where the work is.
- **Demo window:** Ghostty with a transparent title bar, running Claude Code and OpenCode.
- **Play button:** a 56px white square with a play icon, centered over a dimmed poster frame. Pressing it starts the story and allows sound. When the story ends it becomes a 24px ghost square with a replay icon in the title bar. Both buttons are icon only, and the label is for screen readers.
- **Question cell:** 20px question in `#f4f4f4`, 16px answer in 62% white.
- **Footer:** `#191919`, mono 12px links that drop to 70% opacity on hover.

## Do's and Don'ts

- Do let hairlines and whitespace separate things. Prefer a border to a shadow.
- Do keep green for work in transit.
- Do animate only transform and opacity, apart from color fades. Use ease-out for entrances and keep UI motion under 300ms. The diagram's 2400ms travel is explanatory motion, not UI motion.
- Do respect reduced motion: scenes appear finished, the line jumps to its state, there is no head dot, and controls do not scale.
- Do keep a visible 2px white focus ring on every control.
- Don't add eyebrows, all-caps labels, section numbers, gradient text, or rounded cards.
- Don't pair an icon with a word that says the same thing.
- Don't autoplay sound. It plays only after the visitor presses play, and it uses real recordings: CC0 keypresses and OpenCode's agent and tool sounds.

---
name: agent-handoff
description: Hand off your coding agent to the cloud.
colors:
  ground: "#0a0c10"
  panel: "#10131a"
  ink: "#e8edf5"
  ink-2: "#a4aebe"
  ink-3: "#7c8698"
  rule: "rgba(152, 172, 206, 0.1)"
  rule-strong: "rgba(152, 172, 206, 0.2)"
  grid: "rgba(152, 172, 206, 0.085)"
  accent: "#6aa4ff"
  accent-soft: "rgba(106, 164, 255, 0.16)"
typography:
  display:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(40px, 3.4vw + 22px, 72px)"
    fontWeight: 620
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  heading:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 560
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  ui:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "Paper Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Paper Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  sharp: "2px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  window: "12px"
  pill: "999px"
spacing:
  s1: "8px"
  s2: "16px"
  s3: "24px"
  s4: "32px"
  s5: "48px"
  s6: "64px"
  s7: "96px"
  s8: "128px"
  s9: "160px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: "34px"
    padding: "0 14px"
  button-primary-hover:
    backgroundColor: "#ffffff"
  command-box:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.lg}"
    padding: "6px 6px 6px 16px"
  copy-button:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "0 12px"
  play-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    height: "44px"
  title-block:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "16px"
---

# agent-handoff design system

## Overview

The page is a technical drawing of one handoff, set on a dark sheet. A drafting grid sits behind the hero and fades out downward. Hairline rules divide the page, crop marks frame the demo window, and the footer is a drawing title block. The handoff diagram is a dimension line across the top of the demo: three nodes (laptop session, cloud sandbox, draft PR) joined by a dashed line that turns solid blue as the work travels. The demo window is a Ghostty window that runs Claude Code and OpenCode.

## Colors

- **Ground and panel:** cool near-black. The ground lives on `html`, so the grid can sit beneath body content.
- **Inks:** `ink` for headings and active labels, `ink-2` for body and answers, `ink-3` for labels and quiet metadata. All three meet 4.5:1 on the ground.
- **Accent (measure blue):** used only for work in transit. That covers the traveled line, the active node, the line's head, the focus ring, and text selection. Never use it for decoration or as a button color.
- **Inside the demo only:** Claude Code orange and green, OpenCode's blue (`#5cb1ec`) and gray panels, and macOS traffic-light colors.

## Typography

- **Archivo** (variable, self-hosted) carries display, headings, body, and UI. Display is set at 112% width and weight 620 with tight tracking and balanced wrapping. Headings use 108% width, and body uses 100%.
- **Paper Mono** (variable, self-hosted) is for code, paths, commands, diagram labels, and the title block. Do not use it as decoration for prose.
- Window titles use the system UI font, because macOS draws them that way.

## Layout

- The sheet is 1120px wide, which is twenty 56px grid cells, so its edges land on grid lines. The gutter is 16px.
- Spacing comes from an 8px scale (`s1` to `s9`). The hero opens with 96px above the headline and 64px below the command, so the window's title bar and the Play button sit inside a 1440x900 first viewport. Sections are separated by 128 to 160px on desktop and 96px on phones. `main` clips horizontal overflow, so the glow behind the demo never widens the page.
- Questions use a two-column grid on desktop (question 5fr, answer 7fr) and stack on phones.
- At 720px and below, the diagram turns vertical, the crop marks hide, and the window title left-aligns after the traffic lights.

## Elevation & Depth

- The demo window lifts off the sheet with light, not darkness: a white hairline edge at 10%, a black outer ring, a deep ambient shadow, and a cool blue spill. The command box and the play button use layered contact and mid shadows.
- Top edges carry a 1px inner highlight (`rgba(255,255,255,0.06–0.08)`).
- A soft cool radial light sits behind the demo at 20% strength. The window surface (`#111419`) sits clearly above the ground.
- Borders are semi-transparent cool rules, never opaque grays.

## Shapes

- Corner radius scales with the element: 2px for the title block and diagram nodes, 6px for small buttons, 8px for the nav button, 10px for the command box, 12px for the window, and full pills only for the play button.
- Diagram nodes are 11px squares. Crop marks are 14px L-shapes, 12px outside the window's corners.

## Components

- **Install button:** ink on ground. On hover it turns white. On press it scales to 0.97 over 160ms with ease-out.
- **Command box:** panel surface with a strong rule, an inner highlight, and a copy button whose label blurs between "copy" and "copied".
- **Handoff diagram:** `.demo[data-stage]` drives it, and demo.js sets stages 0 to 4. The node columns are a fixed 12px, so the line meets its nodes the way a dimension line meets its extension lines. Node labels hang underneath in ink-2. The traveled segment is a 2px blue stroke that slides in over 2400ms on the strong ease-in-out curve, and a blue head dot marks where the work is right now.
- **Demo window:** Ghostty with its transparent title bar. The bar shares the terminal's background, has no divider, and shows colored traffic lights.
- **Play button:** the window shows a poster frame under a dim scrim until play is pressed, with the pill placed high enough to sit inside the first viewport. Pressing play starts the story and allows sound. When the story ends, the button becomes a small Replay chip in the title bar.
- **Title block footer:** three cells separated by hairline rules: name, GitHub, year.

## Do's and Don'ts

- Do make every drafting mark measure or label something real.
- Do keep blue for work in transit.
- Do animate only transform and opacity, apart from color fades. Use ease-out for entrances and keep UI motion under 300ms. The diagram's 2400ms travel is explanatory motion, not UI motion.
- Do respect reduced motion: scenes appear finished, the line jumps to its state, and there is no head dot.
- Don't add eyebrows, section numbers, gradient text, or cards.
- Don't use italic serif headlines or warm tones. That is Reelcall's world.
- Don't autoplay sound. It plays only after the visitor presses play, and it uses real recordings: CC0 keypresses and OpenCode's agent and tool sounds.

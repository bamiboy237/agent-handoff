# Mobile viewer: Zed-inspired redesign

The supplied Zed agent-panel screenshot is the visual reference. This changes
the built-in watch page for Claude Code, Codex and Pi, plus OpenCode's startup
fallback. OpenCode's own web app and the marketing site are unchanged.

## What carries over

- Black conversation surface with a single hairline below the title.
- Neutral `#191919` prompt and code blocks, `#cccccc` text, and `#373737`
  control borders. No blue chat bubbles, floating panel, gradients or shadows.
- Full-width, left-aligned monospace prompts; proportional assistant text and
  regular-weight headings.
- A flush bottom composer: expand at the upper right, agent and status at the
  lower left, outlined send at the lower right.
- 16px chrome icons with a rendered 1.2px outline, small corner radii, and muted
  controls. Tap areas are 44px rather than desktop-sized targets.
- Copy actions below responses and visible chevrons for folded tool calls.

## Adaptations for handoff

Only functioning controls appear. The agent identity and live run state replace
Zed's model/effort selectors; a PR icon appears when a result is available.
The lock describes link-based access, not end-to-end encryption. Unsupported
attachment, new-thread and model-switching controls are not shown.

The composer expands without losing the draft, collapses with its button or
Escape, and returns to the conversation after a successful send. Safe-area
insets, dynamic viewport height, a 16px textarea (avoiding iOS focus zoom),
reduced motion and keyboard focus are preserved.

This is a close visual adaptation, not a claim of pixel-identical Zed rendering:
the existing embedded fonts and OpenCode tool icons remain. New chrome icons
are original inline outlines; no Zed application source or icon assets were
imported. The watch server still has no runtime dependencies or external assets.

## Review screenshots

These are browser captures of the actual watch page served with a **synthetic
Claude Code transcript**, not a live cloud run. All use device scale factor 2.

| Conversation, 390 × 844 CSS px | Expanded tools, 390 × 844 CSS px |
| --- | --- |
| ![Mobile conversation](images/watch-zed-mobile.png) | ![Expanded diff and shell output](images/watch-zed-tools.png) |

![Desktop layout, 1280 × 900 CSS px](images/watch-zed-desktop.png)

## Reproduce

Use Node.js 22 or later (CI uses 24):

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:watch
```

To refresh the screenshots:

```sh
WATCH_SCREENSHOT_DIR=docs/images npm run test:watch
```

The test starts the real watch server in a temporary directory. It checks
authentication, SSE rendering, tool/diff/shell expansion, copying, composer
expansion and draft preservation, failed sends, successful inbox delivery,
completion/error states, the PR link, stream reconnect and replay, scroll
pinning, and overflow at phone, landscape and desktop dimensions.

Chromium's mobile emulation is not a substitute for a physical iPhone:
Safari's software keyboard and hardware safe areas still need a device check.

# agent-handoff design system

The landing page answers one question: can my coding agent keep working when I leave my laptop? The product preview runs an engineering session through the actual viewer.

## Direction

The reference is the [Figma page](https://www.figma.com/design/HDo81e6bG8TwB6xhWdVu42/Untitled?node-id=1-2). Its useful traits are a quiet navigation bar, short left-aligned copy, large product views, and space between sections.

The page uses a left-aligned introduction over the viewer. The viewer does the explaining. Its controls open the transcript, changes, and checks.

## Colors and type

`site/styles.css` defines the landing-page tokens.

| Role | Token | Value |
| --- | --- | --- |
| Page | `--ground` | `#0e0e0e` |
| Product surround and footer | `--surface` | `#171717` |
| Selected and pressed controls | `--hover` | `#242424` |
| Primary text | `--ink` | `#f2f0eb` |
| Secondary text | `--muted` | `#a2a29d` |
| Dividers | `--rule` | `#303030` |

Geist sets the interface and page copy. Geist Mono sets the install command. Geist Pixel sets the decorative footer wordmark. Fonts are served locally. The viewer keeps its own Inter and IBM Plex Mono fonts through the shared renderer.

Headlines use regular weight and a 34px to 44px range. Section headings use 28px to 36px. Body text uses 16px. Controls keep 44px touch areas.

## Layout

- Content has a 1280px maximum width and fluid 20px to 56px side margins.
- A compact row of view controls sits above the app at every width.
- The app is an iframe, not a rebuilt image of the interface. Its transcript scrolls independently from its composer.
- The mobile section contains a browser capture of the same viewer. On phones, the capture takes the available width.
- Supported agents and providers have one section. The setup command follows it.

Surrounds have a 6px or 8px radius. Controls use 4px corners, except the primary call to action. No gradient, dot field, fake window controls, or ornamental status badges appear on the landing page.

## Interaction

The session starts when the preview enters view. Complete messages, tool calls, diffs, failures, and results arrive over time. Playback pauses offscreen and in a hidden tab. The view controls can jump ahead without making the reader wait. Reset starts the session again.

Follow-up messages enter the transcript. The agent finishes the current task, then checks the requested retry, signature, or migration path. Other requests receive a question rather than an unrelated success reply.

View changes, tool disclosure, and copy feedback are immediate. There is no letter-by-letter typing, audio, or section-entry animation. Hover styles apply only to a fine pointer that supports hover.

Keyboard focus has a visible outline. The page includes a skip link. The install command has clipboard feedback and a text-selection fallback. The viewer retains its own focus, reduced-motion, and touch behavior.

## Shared viewer

`remote/watch-page.mjs` renders both the live watch page and the landing-page preview. The live connection uses the watch server's event stream and message endpoint. The site connection in `scripts/site-playback.mjs` runs the session from `scripts/site-session.mjs`. Both use the same client, styles, tool rendering, and composer.

`npm run build:site` writes `site/preview.html`. The generated file is ignored by Git. The Pages workflow builds it before uploading `site/`.

## Evidence

The Chromium and WebKit browser checks run against the site under `/agent-handoff/`, matching the GitHub Pages path. Controlled browser clocks check event timing, pause and resume, the failed check and correction, completion, and follow-up replies. Layout checks cover 320px through 1440px, including touch input, focus, and clipboard fallback.

Screenshots are in `docs/images/landing-*.png`. The mobile capture used on the page is `site/assets/viewer-mobile.png`.

# Preview the landing page

Run the site from the repository root:

```sh
npm run preview:site
```

Open `http://127.0.0.1:4173/`. The server builds the embedded viewer before serving the page. Set `SITE_PORT` to use another port.

## Check the page

```sh
npm run test:site
WATCH_BROWSER=webkit npm run test:site
npm run test:watch
WATCH_BROWSER=webkit npm run test:watch
```

The site tests serve the generated files under `/agent-handoff/`. They check the same relative paths that GitHub Pages uses.

The viewer starts when it enters view and pauses offscreen. Changes and Checks jump to those parts of the session. Reset starts over. Follow-up messages produce additional checks after the main task finishes.

## Refresh the screenshots

```sh
SITE_SCREENSHOT_DIR=docs/images npm run test:site
```

The captures include the desktop page, the mobile page at 390 × 844, and the app at the same mobile size.

| View | Capture |
| --- | --- |
| Desktop product preview | [Preview](images/landing-desktop-preview.png) |
| Full desktop page | [Page](images/landing-desktop.png) |
| Mobile first viewport | [First viewport](images/landing-mobile-first.png) |
| Full mobile page | [Page](images/landing-mobile.png) |
| Mobile product section | [Viewer section](images/landing-mobile-viewer.png) |
| Mobile app | [App](images/landing-app-mobile.png) |
| Session start | [Start](images/landing-live-start.png) |
| Real-time playback | [Running](images/landing-live-running.png) |
| Failed regression check | [Failure](images/landing-live-failure.png) |
| Completed session | [Result](images/landing-live-completed.png) |

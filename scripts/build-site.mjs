import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWatchPage } from "../remote/watch-page.mjs";
import { previewConnection } from "./site-playback.mjs";
import { session } from "./site-session.mjs";

export async function buildSite() {
  await writeFile(new URL("../site/preview.html", import.meta.url), renderWatchPage({
    agent: "claude",
    connect: previewConnection,
    data: session,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
  console.log("Built site/preview.html from the watch viewer.");
}

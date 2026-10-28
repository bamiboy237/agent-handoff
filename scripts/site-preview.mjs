import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./build-site.mjs";

const root = fileURLToPath(new URL("../site/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };

export function serveSite({ port = 0, base = "/" } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === base.slice(0, -1)) {
      res.writeHead(302, { location: base });
      return res.end();
    }
    if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end(); }
    const path = resolve(root, decodeURIComponent(url.pathname.slice(base.length)) || "index.html");
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); return res.end(); }
    try {
      const content = await readFile(path);
      res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSite();
  const server = serveSite({ port: Number(process.env.SITE_PORT || 4173) });
  server.on("listening", () => console.log(`Landing page: http://127.0.0.1:${server.address().port}/`));
}

#!/usr/bin/env node
// agent-handoff entry point.
//   agent-handoff               MCP server over stdio (what agents launch)
//   agent-handoff --http <port> MCP server over streamable HTTP on localhost
//   agent-handoff setup         choose a sandbox provider and register the server with agents
//   agent-handoff status|work|logs|send|ssh|attach|stop   check in on a handoff (see cli.ts)
// Each mode imports only what it uses, so `setup` starts without loading the server.
import { createServer as createHttpServer } from "node:http";

const MCP_PATH = "/mcp";

// Stateless: each request gets its own server and transport. Handoff state
// lives in files, so nothing is lost between requests.
async function serveHttp(port: number): Promise<void> {
  const { createServer } = await import("./server.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const http = createHttpServer(async (req, res) => {
    if (req.url !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  // Localhost only: the tools can push code and start paid sandboxes.
  http.listen(port, "127.0.0.1", () => {
    console.error(`agent-handoff MCP server listening on http://127.0.0.1:${port}${MCP_PATH}`);
  });
}

const [command, value] = process.argv.slice(2);

if (command === "setup") {
  const { runSetup } = await import("./configure.js");
  await runSetup();
} else if (command && ["status", "work", "logs", "send", "ssh", "attach", "stop"].includes(command)) {
  const { runCheckIn } = await import("./cli.js");
  await runCheckIn(command, process.argv.slice(3));
} else if (command === "--http") {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) {
    console.error("usage: agent-handoff --http <port>");
    process.exit(2);
  }
  await serveHttp(port);
} else if (command === undefined) {
  const { createServer } = await import("./server.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await createServer().connect(new StdioServerTransport());
} else {
  console.error("usage: agent-handoff [setup | status | work | logs | send | ssh | attach | stop | --http <port>]");
  process.exit(2);
}

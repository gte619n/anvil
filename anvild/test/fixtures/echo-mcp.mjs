#!/usr/bin/env node
// Minimal MCP stdio server (newline-delimited JSON-RPC) for the MCP integration tests (Phase C1).
// Tools:
//   ping     → "pong <text>"
//   envkeys  → JSON { keys: sorted NAMES of this process's environment variables (never values),
//                     argv: the arguments after the script, cwd }
// Runs under node or bun. Flag: --crash (exit 3 before answering anything).
import { createInterface } from "node:readline";

if (process.argv.includes("--crash")) {
  console.error("echo-mcp: crashing on purpose");
  process.exit(3);
}

const tools = [
  { name: "ping", description: "Returns pong plus the given text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "envkeys", description: "Returns the names (never values) of this server process's environment variables.", inputSchema: { type: "object", properties: {} } },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const call = (name, args) => {
  if (name === "ping") return { content: [{ type: "text", text: `pong ${args?.text ?? ""}`.trim() }] };
  if (name === "envkeys") {
    return { content: [{ type: "text", text: JSON.stringify({ keys: Object.keys(process.env).sort(), argv: process.argv.slice(2), cwd: process.cwd() }) }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // a notification
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo-mcp", version: "0.0.1" } } });
  }
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: call(m.params?.name, m.params?.arguments) });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
});

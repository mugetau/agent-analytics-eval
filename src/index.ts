/**
 * Stdio entry point: `npm run serve`.
 * Point any MCP client at it, e.g. in Claude Desktop / Claude Code:
 *   { "command": "npx", "args": ["tsx", "/absolute/path/to/src/index.ts"] }
 * Logs go to stderr only: stdout is reserved for the MCP protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateEvents } from "./events.js";
import { createServer } from "./server.js";

const events = generateEvents();
const server = createServer(events);
await server.connect(new StdioServerTransport());
console.error(`agent-analytics MCP server ready (${events.length} synthetic events)`);

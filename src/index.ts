/**
 * Stdio entry point: `npm run serve`.
 * Point any MCP client at it, e.g. in Claude Desktop / Claude Code:
 *   { "command": "npx", "args": ["tsx", "/absolute/path/to/src/index.ts"] }
 * Set ANALYTICS_VARIANT to pick another documentation level (default: short; see src/variants.ts).
 * Logs go to stderr only: stdout is reserved for the MCP protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateEvents } from "./events.js";
import { createServer } from "./server.js";
import { resolveVariant } from "./variants.js";

const events = generateEvents();
const variant = resolveVariant(process.env.ANALYTICS_VARIANT);
const server = createServer(events, variant);
await server.connect(new StdioServerTransport());
console.error(`agent-analytics MCP server ready (${events.length} synthetic events, variant: ${variant.name})`);

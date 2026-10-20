import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AnalyticsEvent } from "../events.js";
import { createServer } from "../server.js";
import { FULL, type Variant } from "../variants.js";

/** Starts the MCP server in-process and returns a connected MCP client. Same protocol path as stdio. */
export async function connectInMemory(events: AnalyticsEvent[], variant: Variant = FULL): Promise<Client> {
  const server = createServer(events, variant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "agent-analytics-eval", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

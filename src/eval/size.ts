/**
 * Offline, free measurement of how much the tool definitions weigh, per variant.
 *
 *   npm run tools:size
 *
 * The definitions are re-sent to the model on every turn, so this cost is multiplied by the number of
 * turns in a run. Characters are exact; tokens are a rough estimate (characters / 3 for JSON schemas),
 * so use the agent runs' real input-token numbers for the final claim.
 */
import { generateEvents } from "../events.js";
import { VARIANTS } from "../variants.js";
import { connectInMemory } from "./connect.js";

const events = generateEvents();
const rows: { name: string; descriptions: string; chars: number }[] = [];
for (const v of Object.values(VARIANTS)) {
  const client = await connectInMemory(events, v);
  const { tools } = await client.listTools();
  rows.push({ name: v.name, descriptions: v.descriptions, chars: JSON.stringify(tools).length });
  await client.close();
}
const base = rows.find((r) => r.name === "full")!.chars;
console.log("variant".padEnd(18) + "descriptions".padEnd(14) + "chars".padEnd(8) + "~tokens".padEnd(9) + "vs full");
for (const r of rows) {
  const delta = r.chars === base ? "" : `${(((r.chars - base) / base) * 100).toFixed(0)}%`;
  console.log(r.name.padEnd(18) + r.descriptions.padEnd(14) + String(r.chars).padEnd(8) + String(Math.round(r.chars / 3)).padEnd(9) + delta);
}

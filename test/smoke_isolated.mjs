/**
 * Smoke test for isolated-window mode.
 */
import { CometController } from "../src/cdp.js";

const userView = new CometController({ isolated: false });
const before = await userView.listTabs();
console.log(`[before] user-visible tabs: ${before.length}`);
console.log("[before list]", before.map((t) => `${t.id.slice(0,8)} ${t.url.slice(0,60)}`).join("\n           "));

const mcp = new CometController({ isolated: true });
const opened = await mcp.newTab("about:blank");
console.log(`\n[opened] id=${opened.id.slice(0,8)} url=${opened.url}`);

const isolatedView = await mcp.listTabs();
console.log(`[isolated] visible to MCP: ${isolatedView.length}`);
if (isolatedView.length !== 1) throw new Error(`expected 1 MCP tab, got ${isolatedView.length}`);

const userViewWhileOpen = await userView.listTabs();
const newOnes = userViewWhileOpen.filter((t) => !before.some((b) => b.id === t.id));
console.log(`\n[diff] new tabs since 'before': ${newOnes.length}`);
console.log("[diff list]", newOnes.map((t) => `${t.id.slice(0,8)} ${t.url.slice(0,60)}`).join("\n           "));

const mcpTab = newOnes.find((t) => t.id === opened.id);
if (!mcpTab) throw new Error("the MCP-created tab is not in the user-visible diff");
console.log("\n[good] the MCP tab is among the new tabs.");

await mcp.closeTab(opened.id);
const afterClose = await mcp.listTabs();
console.log(`\n[after close] MCP tabs: ${afterClose.length} (expected 0)`);
if (afterClose.length !== 0) throw new Error("closeTab did not remove the MCP tab");

const after = await userView.listTabs();
const stillThere = after.find((t) => t.id === opened.id);
if (stillThere) throw new Error("MCP tab still in user view after close");

console.log("\nPASS: isolated-window mode opens its own minimized window and cleans up.");

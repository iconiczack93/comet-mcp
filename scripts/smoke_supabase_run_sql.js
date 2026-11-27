#!/usr/bin/env node
// Smoke test for the supabase.run_sql workflow.
//
// Usage:
//   node scripts/smoke_supabase_run_sql.js <project_ref> [sql]
//
// Example (read-only, safe):
//   node scripts/smoke_supabase_run_sql.js <project_ref> "select now() as ts, current_user;"
//
// You must already be logged into Supabase in the Comet browser, and Comet
// must be running with --remote-debugging-port=9224.

import { CometController, COMET_LAUNCH_COMMAND } from "../src/cdp.js";
import { runSql } from "../src/workflows/supabase.js";

const [, , project, sqlArg] = process.argv;
const sql = sqlArg || "select now() as ts, current_user;";

if (!project) {
  console.error("Usage: node scripts/smoke_supabase_run_sql.js <project_ref> [sql]");
  process.exit(2);
}

const controller = new CometController();

try {
  // Confirm the browser is reachable before we send the workflow.
  await controller.listTabs();
} catch (err) {
  console.error(err?.message || String(err));
  console.error(`Launch Comet with: ${COMET_LAUNCH_COMMAND}`);
  process.exit(1);
}

console.error(`[smoke] running supabase.run_sql on project=${project} (${sql.length} chars)`);
const t0 = Date.now();
let result;
try {
  result = await runSql(controller, { project, sql, timeout_ms: 90000, keep_open: false });
} finally {
  // Defensive cleanup — the workflow already closes its own tab, but if the
  // runSql call threw before returning we still want a clean exit.
  if (result?.tab_id) {
    await controller.closeTab(result.tab_id).catch(() => {});
  }
}
console.log(JSON.stringify({ result, wall_ms: Date.now() - t0 }, null, 2));
process.exit(result.ok ? 0 : 1);

#!/usr/bin/env node
// Probe what an SQL error looks like in the Supabase editor — toast? inline?
//
// Usage:
//   COMET_MCP_ISOLATED=1 node scripts/probe_supabase_error.js <project_ref>

import { CometController } from "../src/cdp.js";

const [, , project] = process.argv;
if (!project) {
  console.error("Usage: COMET_MCP_ISOLATED=1 node scripts/probe_supabase_error.js <project_ref>");
  process.exit(2);
}

const controller = new CometController();

await controller.newTab(`https://supabase.com/dashboard/project/${project}/sql/new`);
await new Promise((r) => setTimeout(r, 4000));
await controller.waitForSelector(".monaco-editor .view-lines", { timeoutMs: 20000 });

// Set an intentionally invalid SQL.
await controller.evalJs(
  `(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setValue("select nonexistent_function_xyz();");
    ed.focus();
    return true;
  })()`,
  { awaitPromise: false },
);

await new Promise((r) => setTimeout(r, 500));
await controller.click({ selector: '[data-testid="sql-run-button"]' }, { timeoutMs: 5000 });
console.log("[probe] clicked Run on invalid SQL — waiting 6s");
await new Promise((r) => setTimeout(r, 6000));

const result = await controller.evalJs(
  `(() => {
    const body = (document.body.innerText || "");
    // Find anything that looks like a postgres error
    const errLines = body.split("\\n").filter(l => /error|failed|does not exist|unknown function|syntax|invalid/i.test(l)).slice(0, 12);
    // Toasts
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast], .sonner-toast, [role="status"], [class*="toast"], [class*="Toast"]'))
      .map(t => (t.innerText || "").trim()).filter(Boolean).slice(0, 10);
    // Elements with class names containing 'error' / 'destructive'
    const errEls = Array.from(document.querySelectorAll('[class*="error"], [class*="Error"], [class*="destructive"], [data-state="error"]'))
      .map(e => ({ cls: (e.className || "").toString().slice(0, 80), text: (e.innerText || "").trim().slice(0, 200) }))
      .filter(e => e.text)
      .slice(0, 10);
    return { errLines, toasts, errEls };
  })()`,
  { awaitPromise: false },
);

console.log(JSON.stringify(result, null, 2));
process.exit(0);

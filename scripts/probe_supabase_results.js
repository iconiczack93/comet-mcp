#!/usr/bin/env node
// v2 probe: click the actual Run button via data-testid, then look broadly
// for where Supabase renders SQL results (toast, panel, grid, etc).
//
// Usage:
//   COMET_MCP_ISOLATED=1 node scripts/probe_supabase_results.js <project_ref>

import { CometController } from "../src/cdp.js";

const [, , project] = process.argv;
if (!project) {
  console.error("Usage: COMET_MCP_ISOLATED=1 node scripts/probe_supabase_results.js <project_ref>");
  process.exit(2);
}

const controller = new CometController();

await controller.newTab(`https://supabase.com/dashboard/project/${project}/sql/new`);
await new Promise((r) => setTimeout(r, 4000));
await controller.waitForSelector(".monaco-editor .view-lines", { timeoutMs: 20000 });

// Set the SQL and focus the editor.
await controller.evalJs(
  `(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setValue("select now() as ts, current_user;");
    ed.focus();
    return true;
  })()`,
  { awaitPromise: false },
);

await new Promise((r) => setTimeout(r, 500));

// Snapshot baseline data-testid set BEFORE the run.
const before = await controller.evalJs(
  `(() => Array.from(document.querySelectorAll("[data-testid], [data-test]"))
     .map(el => el.getAttribute("data-testid") || el.getAttribute("data-test")))()`,
  { awaitPromise: false },
);

// Click Run via the stable testid.
await controller.click({ selector: '[data-testid="sql-run-button"]' }, { timeoutMs: 5000 });
console.log("[probe] clicked sql-run-button — waiting 6s for execution + render");
await new Promise((r) => setTimeout(r, 6000));

// Snapshot data-testid set AFTER the run.
const after = await controller.evalJs(
  `(() => Array.from(document.querySelectorAll("[data-testid], [data-test]"))
     .map(el => el.getAttribute("data-testid") || el.getAttribute("data-test")))()`,
  { awaitPromise: false },
);

const beforeSet = new Set(before);
const newTestids = [...new Set(after)].filter((t) => !beforeSet.has(t));
console.log("\n=== New data-testid values after run ===");
console.log(JSON.stringify(newTestids, null, 2));

// Look for any element whose text contains the query result fragment.
const matches = await controller.evalJs(
  `(() => {
    const out = [];
    const seen = new WeakSet();
    function walk(el, depth=0) {
      if (!el || seen.has(el) || depth > 12) return;
      seen.add(el);
      const txt = (el.innerText || "");
      if (/current_user|ts$|postgres|2026-/i.test(txt) && txt.length < 800) {
        const path = [];
        let n = el;
        while (n && n !== document.body && path.length < 6) {
          const t = n.getAttribute && n.getAttribute("data-testid");
          const c = (n.className || "").toString().split(/\\s+/)[0];
          path.unshift(t ? \`[data-testid=\${t}]\` : \`\${n.tagName.toLowerCase()}.\${c}\`);
          n = n.parentElement;
        }
        out.push({ path: path.join(" > "), preview: txt.slice(0, 240) });
      }
      for (const c of el.children) walk(c, depth+1);
    }
    walk(document.body);
    // Dedupe by path prefix.
    const dedup = [];
    for (const o of out) {
      if (!dedup.some(d => o.path.startsWith(d.path) || d.path.startsWith(o.path))) dedup.push(o);
    }
    return dedup.slice(0, 8);
  })()`,
  { awaitPromise: false },
);

console.log("\n=== Elements containing result-like text ===");
console.log(JSON.stringify(matches, null, 2));

// Also: full toast scan with broader selectors.
const toasts = await controller.evalJs(
  `(() => {
    const sels = [
      "[data-sonner-toast]", ".sonner-toast", "[role=\\"status\\"]",
      "[data-state=\\"open\\"][data-radix-toast-root]",
      "[class*=\\"toast\\"]", "[class*=\\"Toast\\"]",
      "li[data-styled-toaster]", "[data-rstr-toast]",
    ];
    const out = [];
    sels.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((t) => {
          const txt = (t.innerText || "").trim();
          if (txt) out.push({ sel, text: txt.slice(0, 240) });
        });
      } catch(e) {}
    });
    return out;
  })()`,
  { awaitPromise: false },
);

console.log("\n=== Toast scan (broad) ===");
console.log(JSON.stringify(toasts, null, 2));

process.exit(0);

#!/usr/bin/env node
// One-off DOM probe: navigate to Supabase SQL editor in an isolated MCP
// window, type a query, then inspect the page for Run button candidates and
// result regions. Used to tune selectors for supabase.run_sql.
//
// Usage:
//   COMET_MCP_ISOLATED=1 node scripts/probe_supabase_sql.js <project_ref>

import { CometController } from "../src/cdp.js";

const [, , project] = process.argv;
if (!project) {
  console.error("Usage: COMET_MCP_ISOLATED=1 node scripts/probe_supabase_sql.js <project_ref>");
  process.exit(2);
}

const controller = new CometController();

await controller.newTab(`https://supabase.com/dashboard/project/${project}/sql/new`);
await new Promise((r) => setTimeout(r, 4000));
await controller.waitForSelector(".monaco-editor .view-lines", { timeoutMs: 20000 });

// Set a small query so the editor has content.
await controller.evalJs(
  `(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setValue("select now() as ts;");
    ed.focus();
    return true;
  })()`,
  { awaitPromise: false },
);

// Give the toolbar a moment to settle.
await new Promise((r) => setTimeout(r, 800));

// Probe 1: every visible button in the document — text, aria, id, classes, position.
const buttons = await controller.evalJs(
  `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((b) => ({
        tag: b.tagName.toLowerCase(),
        text: (b.innerText || "").trim().slice(0, 60),
        ariaLabel: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
        dataTest: b.getAttribute("data-test") || b.getAttribute("data-testid"),
        id: b.id || null,
        classes: (b.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 4).join(" "),
        rect: { x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y) },
      }))
      .filter((b) => /run|execute|query/i.test([b.text, b.ariaLabel, b.title, b.dataTest].filter(Boolean).join(" ")));
    return buttons;
  })()`,
  { awaitPromise: false },
);

console.log("=== Run-button candidates ===");
console.log(JSON.stringify(buttons, null, 2));

// Probe 2: trigger the run via Ctrl+Enter, then inspect what shows up.
await controller.press("Control+Enter", {});
await new Promise((r) => setTimeout(r, 2500));

const post = await controller.evalJs(
  `(() => {
    const out = { dialogs: [], toasts: [], dataAttrTargets: [], tablesAfter: 0 };

    // Dialogs / modals
    document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach((d) => {
      out.dialogs.push({
        text: (d.innerText || "").slice(0, 400),
        buttons: Array.from(d.querySelectorAll("button")).map((b) => (b.innerText || "").trim()).filter(Boolean),
      });
    });

    // Toasts (sonner / radix / generic)
    const toastSelectors = [
      "[data-sonner-toast]",
      ".sonner-toast",
      "[role=\\"status\\"]",
      "[data-state=\\"open\\"][data-radix-toast-root]",
      "[class*=\\"toast\\"]",
    ];
    toastSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((t) => {
        const txt = (t.innerText || "").trim();
        if (txt) out.toasts.push({ sel, text: txt.slice(0, 300) });
      });
    });

    // Elements with data-test* / data-testid attrs containing 'sql' or 'result' or 'query'
    document.querySelectorAll("[data-test], [data-testid], [data-state]").forEach((el) => {
      const attrs = {};
      for (const a of el.attributes) {
        if (/^data-/.test(a.name)) attrs[a.name] = a.value;
      }
      const joined = JSON.stringify(attrs).toLowerCase();
      if (/sql|result|query|monaco/.test(joined)) {
        out.dataAttrTargets.push({
          tag: el.tagName.toLowerCase(),
          attrs,
          innerTextLen: (el.innerText || "").length,
        });
      }
    });
    // Cap noise.
    out.dataAttrTargets = out.dataAttrTargets.slice(0, 30);

    // Generic table count, often where results land.
    out.tablesAfter = document.querySelectorAll("table").length;

    return out;
  })()`,
  { awaitPromise: false },
);

console.log("\n=== After Ctrl+Enter ===");
console.log(JSON.stringify(post, null, 2));

process.exit(0);

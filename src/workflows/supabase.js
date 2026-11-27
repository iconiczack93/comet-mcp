// Comet MCP workflow: supabase.run_sql
//
// Opens its own isolated tab, navigates to the SQL editor, loads SQL into
// Monaco, clicks Run, dismisses the destructive-ops modal if present, reads
// the result, and closes the tab on exit (unless keep_open=true).
//
// Composes existing controller primitives — no new CDP plumbing.

const SQL_EDITOR_PATH = (ref) => `https://supabase.com/dashboard/project/${ref}/sql/new`;
const MONACO_READY_SELECTOR = ".monaco-editor .view-lines";
const RUN_BUTTON_SELECTOR = '[data-testid="sql-run-button"]';

const setMonacoValueExpr = (sql) => `
  (async () => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const editors = (window.monaco && window.monaco.editor && window.monaco.editor.getEditors)
        ? window.monaco.editor.getEditors()
        : [];
      if (editors.length) {
        const ed = editors[0];
        ed.setValue(${JSON.stringify(sql)});
        ed.focus();
        const lines = ed.getModel().getLineCount();
        const chars = ed.getModel().getValueLength();
        return { ok: true, lines, chars };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, reason: "monaco_global_unavailable_after_10s" };
  })()
`;

const detectModalExpr = `
  (() => {
    const modal = document.querySelector('[role="dialog"]') || document.querySelector('[role="alertdialog"]');
    if (!modal) return { present: false };
    const text = (modal.innerText || "").slice(0, 600);
    const buttons = Array.from(modal.querySelectorAll('button')).map(b => (b.innerText || "").trim()).filter(Boolean);
    return { present: true, text, buttons };
  })()
`;

const readResultExpr = `
  (() => {
    const body = (document.body && document.body.innerText) || "";

    // Error path: Supabase renders "Failed to run sql query: ERROR: <code>: <msg>"
    // inline in the editor panel (no toast). Capture the whole line for context.
    const errMatch = body.match(/Failed to run sql query:[^\\n]+/);
    if (errMatch) {
      const codeMatch = errMatch[0].match(/ERROR:\\s+(\\w+):/);
      return {
        ok: false,
        source: "inline_error",
        error: errMatch[0].slice(0, 800),
        pg_code: codeMatch ? codeMatch[1] : null,
      };
    }

    // Success path: result panel shows "N row(s) (Limited)" or "N row(s) returned".
    const rowMatch = body.match(/(\\d+)\\s+rows?\\b[^\\n]{0,40}/i);
    if (rowMatch) {
      return {
        ok: true,
        source: "result_panel",
        message: rowMatch[0].trim().slice(0, 200),
        rows: parseInt(rowMatch[1], 10),
      };
    }

    // DDL paths.
    if (/Success\\.\\s+No rows returned/i.test(body)) {
      return { ok: true, source: "result_panel", message: "Success. No rows returned.", rows: 0 };
    }

    return { ok: null, source: "none", message: "no result panel or error within window" };
  })()
`;

export async function runSql(controller, { project, sql, timeout_ms = 60000, keep_open = false } = {}) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  let tab_id = null;
  let cleanup_attempted = false;

  const closeIfOwned = async () => {
    if (cleanup_attempted || !tab_id || keep_open) return;
    cleanup_attempted = true;
    try {
      await controller.closeTab(tab_id);
    } catch (_) { /* best effort */ }
  };

  try {
    if (!project || typeof project !== "string") {
      return { ok: false, stage: "validate", error: "project (ref) is required" };
    }
    if (!sql || typeof sql !== "string") {
      return { ok: false, stage: "validate", error: "sql is required" };
    }

    // 1. Open a fresh isolated tab for this run. In isolated mode this lands
    //    in the MCP-owned minimized window; in non-isolated mode it's a new
    //    foreground tab. Either way, we own it end-to-end.
    let tab;
    try {
      tab = await controller.newTab(SQL_EDITOR_PATH(project));
      tab_id = tab.id;
    } catch (err) {
      return { ok: false, stage: "open_tab", error: err.message || String(err), ms: elapsed() };
    }

    // 2. Wait for Monaco editor surface. Brand-new tabs can race against the
    //    renderer process being ready, so do a short settle, then retry once
    //    on the "Uncaught" race signature before giving up. Real timeouts
    //    (page actually slow) still fall through after the second attempt.
    await new Promise((r) => setTimeout(r, 500));
    let waitErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await controller.waitForSelector(MONACO_READY_SELECTOR, {
          timeoutMs: attempt === 0 ? 12000 : 20000,
          tabId: tab_id,
        });
        waitErr = null;
        break;
      } catch (err) {
        waitErr = err;
        // Retry only on the renderer-not-ready race; fail fast on real timeouts.
        if (!/uncaught/i.test(err.message || "")) break;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (waitErr) {
      return { ok: false, stage: "wait_monaco", error: waitErr.message || String(waitErr), tab_id, ms: elapsed() };
    }

    // 3. Set SQL via Monaco API.
    const setResult = await controller.evalJs(setMonacoValueExpr(sql), {
      awaitPromise: true, timeoutMs: 12000, tabId: tab_id,
    });
    if (!setResult || setResult.ok !== true) {
      return { ok: false, stage: "set_value", error: setResult?.reason || "monaco_setvalue_failed", tab_id, ms: elapsed() };
    }

    // Small settle so the Run button registers the editor has content.
    await new Promise((r) => setTimeout(r, 400));

    // 4. Run — prefer the stable testid; fall back to text, then keyboard.
    let runMethod = "testid";
    try {
      await controller.click({ selector: RUN_BUTTON_SELECTOR }, { timeoutMs: 5000, tabId: tab_id });
    } catch (_) {
      runMethod = "text";
      try {
        await controller.click({ text: "Run" }, { timeoutMs: 3000, tabId: tab_id });
      } catch (_2) {
        runMethod = "keyboard";
        try {
          await controller.press("Control+Enter", { tabId: tab_id });
        } catch (err) {
          return { ok: false, stage: "trigger_run", error: err.message || String(err), tab_id, ms: elapsed() };
        }
      }
    }

    // 5. Handle destructive-ops modal if it appears.
    await new Promise((r) => setTimeout(r, 1000));
    const modal = await controller.evalJs(detectModalExpr, { awaitPromise: false, timeoutMs: 4000, tabId: tab_id });
    let modal_handled = null;
    if (modal && modal.present) {
      const buttons = modal.buttons || [];
      const preferred =
        buttons.find((b) => /run destructive/i.test(b)) ||
        buttons.find((b) => /^run/i.test(b)) ||
        buttons.find((b) => /confirm/i.test(b)) ||
        buttons.find((b) => /i (understand|accept)/i.test(b)) ||
        buttons.find((b) => /^yes/i.test(b));
      if (!preferred) {
        return {
          ok: false, stage: "destructive_modal", error: "no recognizable confirm button",
          modal_text: modal.text, modal_buttons: buttons, tab_id, ms: elapsed(),
        };
      }
      try {
        await controller.click({ text: preferred }, { timeoutMs: 4000, tabId: tab_id });
        modal_handled = preferred;
      } catch (err) {
        return {
          ok: false, stage: "destructive_modal_click", error: err.message || String(err),
          modal_text: modal.text, modal_buttons: buttons, tab_id, ms: elapsed(),
        };
      }
    }

    // 6. Poll for result. Use a generous window — DDL and heavy queries can
    //    take 10s+ before they render anything.
    const pollDeadline = Date.now() + Math.max(15000, timeout_ms - elapsed());
    let final = { ok: null };
    let polls = 0;
    while (Date.now() < pollDeadline) {
      polls += 1;
      final = await controller.evalJs(readResultExpr, { awaitPromise: false, timeoutMs: 4000, tabId: tab_id });
      if (final && final.ok === true) break;
      if (final && final.ok === false) break;
      await new Promise((r) => setTimeout(r, 700));
    }

    return {
      ok: final?.ok === true,
      stage: final?.ok === true ? "completed" : final?.ok === false ? "execution_error" : "ambiguous",
      error: final?.ok === false ? final.error : undefined,
      pg_code: final?.pg_code,
      message: final?.message,
      rows: final?.rows,
      source: final?.source,
      run_method: runMethod,
      modal_handled,
      set_chars: setResult.chars,
      set_lines: setResult.lines,
      polls,
      tab_id,
      ms: elapsed(),
    };
  } finally {
    // Best-effort close. Keeps the browser tidy across many invocations.
    await closeIfOwned();
  }
}

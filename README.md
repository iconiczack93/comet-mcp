# Comet Browser MCP

An MCP stdio server that drives your already-running, already-logged-in **Comet** browser directly over Chrome DevTools Protocol (CDP). It does not spawn Chromium, Playwright, Puppeteer, Selenium, or a separate browser profile—so your existing cookies, MFA sessions, and saved auth stay intact.

## Why this exists

Most browser MCP servers launch a fresh headless Chromium profile, forcing agents to fight login walls and 2FA on every run. `comet-mcp` connects directly to Comet's local CDP endpoint (`ws`) and adds an **isolated-window mode** so the agent operates in its own minimized window without hijacking your active tabs.

## Install

Clone the repo and install dependencies (Node.js 20+):

```bash
git clone https://github.com/iconiczack93/comet-mcp.git
cd comet-mcp
npm install
```

Or install globally from your local checkout (on Windows PowerShell, `npm.cmd` avoids execution-policy blocks on `npm.ps1`):

```powershell
npm.cmd install -g .
```

## Launch Comet with CDP

Close every existing Comet window first (Chromium ignores `--remote-debugging-port` if an instance is already running), then launch with remote debugging enabled:

```powershell
# Windows (PowerShell)
& "$env:LOCALAPPDATA\Perplexity\Comet\Application\comet.exe" --remote-debugging-port=9224
```

Verify CDP is reachable:

```powershell
Invoke-RestMethod http://127.0.0.1:9224/json
```

## MCP Client Configuration (Claude Code / Cursor / etc.)

Add `comet` to your project `.mcp.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "comet": {
      "command": "node",
      "args": ["/path/to/comet-mcp/src/server.js"],
      "env": {
        "COMET_CDP_HTTP": "http://127.0.0.1:9224",
        "COMET_MCP_ISOLATED": "1"
      }
    }
  }
}
```

If installed globally on `PATH`, you can use `"command": "comet-mcp"` with `"args": []`.

## Isolated-window mode (`COMET_MCP_ISOLATED=1`)

Set `COMET_MCP_ISOLATED=1` (recommended for daily use) to confine the MCP to its own dedicated, minimized Comet window instead of touching your active tabs:

- First `new_tab` creates a fresh window via `Target.createTarget` (`newWindow: true`) and minimizes it via `Browser.setWindowBounds`.
- Subsequent `new_tab` calls open inside that same minimized window.
- `list_tabs` filters out user tabs—only the MCP's own tabs are visible to the agent.
- `pick_tab` refuses tabs outside the MCP window and never steals focus via `/json/activate/`.
- When the seed MCP tab closes, the window reference resets cleanly.

Your real browser profile's cookies and sessions are still shared—only the window is isolated. See `test/smoke_isolated.mjs` for the verification check.

## Tools

| Tool | Purpose |
| :--- | :--- |
| `list_tabs()` | Returns `{ id, title, url, active }` for CDP page tabs |
| `pick_tab({ url_substring \| tab_id })` | Sets the process-wide active tab |
| `new_tab({ url })` | Opens a tab (inside the isolated window when enabled) |
| `close_tab({ tab_id })` | Closes a tab |
| `goto({ url, wait_until })` | Navigates with `load`, `domcontentloaded`, or `networkidle` |
| `screenshot({ full_page, out_path })` | Returns inline MCP PNG content or writes to `out_path` |
| `eval_js({ expr, await_promise })` | Evaluates page JavaScript with `returnByValue` |
| `click({ selector \| text \| role+name })` | Fresh-lookup click with short retry on React renders |
| `fill({ selector \| label, value })` | Fills inputs and dispatches `input`/`change` events |
| `press({ key })` | Dispatches keyboard events (`Enter`, `Escape`, arrows, etc.) |
| `get_text({ selector })` | Returns visible text for matching elements |
| `wait_for_selector({ selector, timeout_ms })` | Waits for a visible CSS match |
| `wait_for_url({ substring, timeout_ms })` | Waits for the current URL to contain a substring |
| `accessibility_tree({ max_depth })` | Returns a pruned Chrome AX tree |
| `network_log({ filter, last_n })` | Returns recent captured Network events |
| `read_cookies({ domain, include_values })` | Reads cookies (values redacted by default) |

Most page tools accept an optional `tab_id` and default to the active tab set by `pick_tab`.

## Architecture Notes

- **No `--remote-allow-origins=*` required:** Uses Node's `ws` for raw CDP WebSockets without sending a disallowed `Origin` header, avoiding Chrome 102+ CDP origin rejections.
- **Persistent tab sockets:** Caches one CDP WebSocket per tab across calls to preserve `Network` capture and avoid re-enabling CDP domains, reconnecting automatically if a tab closes.
- **Explicit targeting & fail-fast ambiguity:** CSS selector → visible accessible name/text → ARIA role+name. Multiple visible matches fail with previews rather than clicking the wrong element.
- **Named workflows:** Includes higher-level workflow helpers (see `src/workflows/supabase.js` for running SQL via the Supabase Monaco editor).

See [DESIGN.md](./DESIGN.md) for protocol and module internals.

## Verification Scripts

With a logged-in Supabase dashboard tab open in Comet:

```bash
# Isolated window smoke test
node test/smoke_isolated.mjs

# End-to-end MCP stdio integration test
SUPABASE_PROJECT_ID="<your-project-ref>" node test/integration_resume.mjs

# Supabase workflow smoke test
node scripts/smoke_supabase_run_sql.js <project_ref> "select now() as ts, current_user;"
```

## License

[MIT](./LICENSE)

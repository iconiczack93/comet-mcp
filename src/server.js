#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserNotReachableError, COMET_LAUNCH_COMMAND, CometController } from "./cdp.js";
import { runSql as supabaseRunSql } from "./workflows/supabase.js";

const controller = new CometController();

function jsonResult(value) {
  const structuredContent =
    value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function imageResult(image) {
  if (image.path) return jsonResult(image);
  return {
    content: [
      { type: "text", text: "PNG screenshot captured from Comet." },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  };
}

function normalizeError(err) {
  if (err instanceof BrowserNotReachableError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (err) {
      const message = normalizeError(err);
      console.error(`[comet-mcp] ${name} failed: ${message}`);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });
}

const tabId = z.string().optional().describe("Optional CDP tab id. Defaults to the picked active tab.");
const timeoutMs = z.number().int().positive().optional();

const server = new McpServer(
  { name: "comet-browser-mcp", version: "0.1.0" },
  {
    instructions:
      "Drive the user's already-running Comet browser over CDP. Use list_tabs and pick_tab before acting. Prefer role+name or text selectors for React dashboards when CSS selectors look generated. Browser must already be launched with --remote-debugging-port=9224.",
  },
);

registerTool(
  server,
  "list_tabs",
  {
    title: "List Comet tabs",
    description: "List page tabs exposed by the running Comet CDP endpoint.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => jsonResult(await controller.listTabs()),
);

registerTool(
  server,
  "pick_tab",
  {
    title: "Pick active tab",
    description: "Select the process-wide active tab by exact tab id or unique URL substring.",
    inputSchema: z.object({
      tab_id: z.string().optional(),
      url_substring: z.string().optional(),
    }),
  },
  async (args) => jsonResult(await controller.pickTab(args)),
);

registerTool(
  server,
  "new_tab",
  {
    title: "Open new tab",
    description: "Open a new Comet tab and make it active.",
    inputSchema: z.object({ url: z.string().url() }),
  },
  async ({ url }) => jsonResult(await controller.newTab(url)),
);

registerTool(
  server,
  "close_tab",
  {
    title: "Close tab",
    description: "Close a Comet tab by id.",
    inputSchema: z.object({ tab_id: z.string() }),
  },
  async ({ tab_id }) => jsonResult(await controller.closeTab(tab_id)),
);

registerTool(
  server,
  "goto",
  {
    title: "Navigate tab",
    description: "Navigate the active or specified tab and wait for load, domcontentloaded, or networkidle.",
    inputSchema: z.object({
      url: z.string().url(),
      wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
      tab_id: tabId,
      timeout_ms: timeoutMs,
    }),
  },
  async ({ url, wait_until, tab_id, timeout_ms }) =>
    jsonResult(await controller.goto(url, { waitUntil: wait_until, tabId: tab_id, timeoutMs: timeout_ms || 30000 })),
);

registerTool(
  server,
  "screenshot",
  {
    title: "Screenshot",
    description: "Capture a PNG screenshot. If out_path is omitted, returns MCP image content inline.",
    inputSchema: z.object({
      full_page: z.boolean().default(false),
      out_path: z.string().nullable().optional(),
      tab_id: tabId,
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ full_page, out_path, tab_id }) =>
    imageResult(await controller.screenshot({ fullPage: full_page, outPath: out_path || null, tabId: tab_id })),
);

registerTool(
  server,
  "eval_js",
  {
    title: "Evaluate JavaScript",
    description: "Evaluate JavaScript in the page and return the JSON-serializable result.",
    inputSchema: z.object({
      expr: z.string(),
      await_promise: z.boolean().default(true),
      tab_id: tabId,
      timeout_ms: timeoutMs,
    }),
  },
  async ({ expr, await_promise, tab_id, timeout_ms }) =>
    jsonResult(await controller.evalJs(expr, { awaitPromise: await_promise, tabId: tab_id, timeoutMs: timeout_ms || 30000 })),
);

registerTool(
  server,
  "click",
  {
    title: "Click element",
    description: "Click by CSS selector, visible text, or accessibility-like role+name. Ambiguous matches return a narrowing error.",
    inputSchema: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      tab_id: tabId,
      timeout_ms: timeoutMs,
    }),
  },
  async ({ selector, text, role, name, tab_id, timeout_ms }) =>
    jsonResult(await controller.click({ selector, text, role, name }, { tabId: tab_id, timeoutMs: timeout_ms || 5000 })),
);

registerTool(
  server,
  "fill",
  {
    title: "Fill field",
    description: "Fill an input, textarea, select, or contenteditable field by CSS selector or label/name.",
    inputSchema: z.object({
      selector: z.string().optional(),
      label: z.string().optional(),
      value: z.string(),
      tab_id: tabId,
      timeout_ms: timeoutMs,
    }),
  },
  async ({ selector, label, value, tab_id, timeout_ms }) =>
    jsonResult(await controller.fill({ selector, label, value }, { tabId: tab_id, timeoutMs: timeout_ms || 5000 })),
);

registerTool(
  server,
  "press",
  {
    title: "Press key",
    description: 'Dispatch a key press, for example "Enter", "Escape", "Tab", or "ArrowDown".',
    inputSchema: z.object({ key: z.string(), tab_id: tabId }),
  },
  async ({ key, tab_id }) => jsonResult(await controller.press(key, { tabId: tab_id })),
);

registerTool(
  server,
  "get_text",
  {
    title: "Get text",
    description: "Return visible text from elements matching a CSS selector.",
    inputSchema: z.object({ selector: z.string(), tab_id: tabId }),
    annotations: { readOnlyHint: true },
  },
  async ({ selector, tab_id }) => jsonResult(await controller.getText(selector, { tabId: tab_id })),
);

registerTool(
  server,
  "wait_for_selector",
  {
    title: "Wait for selector",
    description: "Wait until a visible element matching a CSS selector exists.",
    inputSchema: z.object({ selector: z.string(), timeout_ms: timeoutMs.default(10000), tab_id: tabId }),
    annotations: { readOnlyHint: true },
  },
  async ({ selector, timeout_ms, tab_id }) =>
    jsonResult(await controller.waitForSelector(selector, { timeoutMs: timeout_ms, tabId: tab_id })),
);

registerTool(
  server,
  "wait_for_url",
  {
    title: "Wait for URL",
    description: "Wait until the active or specified tab URL contains a substring.",
    inputSchema: z.object({ substring: z.string(), timeout_ms: timeoutMs.default(15000), tab_id: tabId }),
    annotations: { readOnlyHint: true },
  },
  async ({ substring, timeout_ms, tab_id }) =>
    jsonResult(await controller.waitForUrl(substring, { timeoutMs: timeout_ms, tabId: tab_id })),
);

registerTool(
  server,
  "accessibility_tree",
  {
    title: "Accessibility tree",
    description: "Return a pruned Chrome accessibility tree for the active or specified tab.",
    inputSchema: z.object({ max_depth: z.number().int().min(1).max(50).default(20), tab_id: tabId }),
    annotations: { readOnlyHint: true },
  },
  async ({ max_depth, tab_id }) => jsonResult(await controller.accessibilityTree({ maxDepth: max_depth, tabId: tab_id })),
);

registerTool(
  server,
  "network_log",
  {
    title: "Network log",
    description: "Return recent Network domain events captured since this MCP server attached to the tab.",
    inputSchema: z.object({
      filter: z.string().nullable().optional(),
      last_n: z.number().int().positive().max(500).default(50),
      tab_id: tabId,
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ filter, last_n, tab_id }) => jsonResult(controller.networkLog({ filter, lastN: last_n, tabId: tab_id })),
);

registerTool(
  server,
  "detect_captcha",
  {
    title: "Detect captcha",
    description: "Scan the active or specified tab for known captcha widgets (reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile). Returns type + sitekey for each.",
    inputSchema: z.object({ tab_id: tabId }),
    annotations: { readOnlyHint: true },
  },
  async ({ tab_id }) => jsonResult(await controller.detectCaptcha({ tabId: tab_id })),
);

registerTool(
  server,
  "solve_captcha",
  {
    title: "Solve captcha via 2Captcha",
    description: "If TWOCAPTCHA_API_KEY env var is set (or twocaptcha_key arg passed), submits the detected captcha to 2Captcha and injects the solved token into the page. Supports reCAPTCHA v2, hCaptcha, Cloudflare Turnstile. Returns {solved, reason, ...} — never throws so the agent can fall back.",
    inputSchema: z.object({
      tab_id: tabId,
      twocaptcha_key: z.string().nullable().optional(),
    }),
  },
  async ({ tab_id, twocaptcha_key }) =>
    jsonResult(await controller.solveCaptcha({ tabId: tab_id, twoCaptchaKey: twocaptcha_key || null })),
);

registerTool(
  server,
  "read_cookies",
  {
    title: "Read cookies",
    description: "Read cookies for a domain. Values are redacted unless include_values is true.",
    inputSchema: z.object({
      domain: z.string(),
      include_values: z.boolean().default(false),
      tab_id: tabId,
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ domain, include_values, tab_id }) =>
    jsonResult(await controller.readCookies({ domain, includeValues: include_values, tabId: tab_id })),
);

registerTool(
  server,
  "supabase_run_sql",
  {
    title: "Supabase: run SQL",
    description:
      "Open the Supabase SQL editor for <project>, paste <sql> into Monaco, click Run, dismiss the destructive-ops modal if present, then read the result toast. Returns {ok, stage, error?, message?, ms, ...}. Requires you to be logged into Supabase in Comet.",
    inputSchema: z.object({
      project: z.string().describe("Supabase project ref (the slug in the dashboard URL, e.g. 'your-project-ref')."),
      sql: z.string().describe("SQL to execute. Multi-statement bundles are fine; the SQL editor runs them in order."),
      timeout_ms: z.number().int().positive().max(180000).default(60000),
      keep_open: z.boolean().default(false).describe("If true, leave the SQL editor tab open after the run so you can inspect it manually. Default false (the workflow closes its own tab)."),
    }),
  },
  async ({ project, sql, timeout_ms, keep_open }) =>
    jsonResult(await supabaseRunSql(controller, { project, sql, timeout_ms, keep_open })),
);

async function main() {
  console.error(`[comet-mcp] stdio server starting. If tools report browser not reachable, run: ${COMET_LAUNCH_COMMAND}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[comet-mcp] fatal: ${normalizeError(err)}`);
  process.exit(1);
});

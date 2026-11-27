import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import WebSocket from "ws";

export const DEFAULT_CDP_HTTP = process.env.COMET_CDP_HTTP || "http://127.0.0.1:9224";
export const COMET_LAUNCH_COMMAND =
  '"%LOCALAPPDATA%\\Perplexity\\Comet\\Application\\comet.exe" --remote-debugging-port=9224';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserNotReachableError extends Error {
  constructor(cdpHttp = DEFAULT_CDP_HTTP, cause = undefined, detail = "") {
    super(
      `Comet browser not reachable at ${cdpHttp}.${detail ? ` ${detail}` : ""} Launch it with: ${COMET_LAUNCH_COMMAND}`,
    );
    this.name = "BrowserNotReachableError";
    this.cause = cause;
  }
}

class CdpConnection {
  constructor(wsUrl, { label = "cdp", onEvent = undefined } = {}) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.onEvent = onEvent;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.wsUrl, {
      perMessageDeflate: false,
      maxPayload: 100 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.label}`)), 10000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", () => this.rejectAll(new Error(`${this.label} websocket closed`)));
    this.ws.on("error", (err) => this.rejectAll(err));
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      console.error(`[comet-mcp] failed to parse CDP message: ${err.message}`);
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
      else resolve(msg.result ?? {});
      return;
    }

    if (msg.method) {
      if (this.onEvent) this.onEvent(msg);
      for (const waiter of [...this.waiters]) {
        try {
          if (waiter.predicate(msg)) {
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
            waiter.resolve(msg);
          }
        } catch (err) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.reject(err);
        }
      }
    }
  }

  rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
  }

  async send(method, params = {}, timeoutMs = 15000) {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async waitForEvent(predicate, timeoutMs = 15000) {
    await this.connect();
    return await new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for CDP event"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const FINDER_SOURCE = String.raw`
(() => {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el.innerText || el.textContent || el.value || "");
  const cssEscape = (s) => window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
  const labelText = (id) => {
    if (!id) return "";
    const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
    return label ? textOf(label) : "";
  };
  const attrRefText = (el, attr) => clean((el.getAttribute(attr) || "")
    .split(/\s+/)
    .map((id) => {
      const ref = document.getElementById(id);
      return ref ? textOf(ref) : "";
    })
    .join(" "));
  const accessibleName = (el) => clean(
    el.getAttribute("aria-label") ||
    attrRefText(el, "aria-labelledby") ||
    labelText(el.id) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    (el.tagName === "INPUT" ? el.value : "") ||
    textOf(el)
  );
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" || type === "button" || type === "submit" || type === "reset") return "button";
    if (tag === "a" && el.href) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    return "";
  };
  const preview = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: accessibleName(el).slice(0, 120),
    text: textOf(el).slice(0, 120),
    selector: el.id ? "#" + el.id : "",
    outerHTML: el.outerHTML.slice(0, 200),
  });
  const candidatesForText = () => Array.from(document.querySelectorAll(
    'button,a,input,textarea,select,label,summary,[role],[onclick],[tabindex]:not([tabindex="-1"])'
  )).filter(isVisible);
  const scoreTextMatches = (elements, needle) => {
    const lower = needle.toLowerCase();
    const hits = elements
      .map((el) => {
        const hay = clean(accessibleName(el) || textOf(el));
        const h = hay.toLowerCase();
        if (!h.includes(lower)) return null;
        return { el, score: h === lower ? 0 : h.startsWith(lower) ? 1 : 2 };
      })
      .filter(Boolean);
    const hitEls = new Set(hits.map((h) => h.el));
    // Prefer leaf-most matches: drop any candidate whose descendant also matches.
    const leafy = hits.filter(({ el }) => {
      for (const d of el.querySelectorAll("*")) {
        if (hitEls.has(d) && d !== el) return false;
      }
      return true;
    });
    const final = leafy.length > 0 ? leafy : hits;
    return final.sort((a, b) => a.score - b.score).map((x) => x.el);
  };
  const pick = (matches, allowMultiple = false) => {
    const visible = matches.filter(isVisible);
    if (visible.length === 0) return { ok: false, error: "No visible element matched" };
    if (!allowMultiple && visible.length > 1) {
      return {
        ok: false,
        error: "Element matched " + visible.length + " things; narrow the selector",
        matches: visible.slice(0, 10).map(preview),
      };
    }
    const el = visible[0];
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      rect: {
        x: Math.max(0, rect.left + rect.width / 2),
        y: Math.max(0, rect.top + rect.height / 2),
        width: rect.width,
        height: rect.height,
      },
      preview: preview(el),
    };
  };
  window.__cometMcp = {
    find(args) {
      if (args.selector) return pick(Array.from(document.querySelectorAll(args.selector)));
      if (args.text) return pick(scoreTextMatches(candidatesForText(), args.text));
      if (args.role && args.name) {
        const role = String(args.role).toLowerCase();
        const name = String(args.name).toLowerCase();
        return pick(candidatesForText().filter((el) => roleOf(el) === role && accessibleName(el).toLowerCase().includes(name)));
      }
      return { ok: false, error: "Provide selector, text, or role+name" };
    },
    fill(args) {
      let result;
      if (args.selector) result = pick(Array.from(document.querySelectorAll(args.selector)));
      else if (args.label) result = pick(candidatesForText().filter((el) => {
        const r = roleOf(el);
        return ["textbox", "searchbox", "combobox"].includes(r) && accessibleName(el).toLowerCase().includes(String(args.label).toLowerCase());
      }));
      else return { ok: false, error: "Provide selector or label" };
      if (!result.ok) return result;
      const target = document.elementFromPoint(result.rect.x, result.rect.y);
      const el = target && target.closest ? (target.closest("input,textarea,select,[contenteditable=true]") || target) : target;
      if (!el) return { ok: false, error: "Matched element is no longer present" };
      el.focus();
      if (el.isContentEditable) {
        el.textContent = args.value;
      } else {
        const proto =
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : el.tagName === "SELECT"
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, args.value);
        else el.value = args.value;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(args.value) }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, preview: result.preview };
    },
    getText(selector) {
      const matches = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      return { count: matches.length, texts: matches.slice(0, 25).map((el) => textOf(el)) };
    },
    selectorExists(selector) {
      return Array.from(document.querySelectorAll(selector)).some(isVisible);
    },
  };
})();
`;

export class CometController {
  constructor({ cdpHttp = DEFAULT_CDP_HTTP, isolated = process.env.COMET_MCP_ISOLATED === "1" } = {}) {
    this.cdpHttp = cdpHttp.replace(/\/$/, "");
    this.activeTabId = null;
    this.sessions = new Map();
    this.networkLogs = new Map();
    this.inflight = new Map();
    this.isolated = isolated;
    // In isolated mode, every MCP-created tab id lands here. listTabs filters
    // to this set; pickTab refuses tabs outside it. The MCP can read user
    // tab state via listTabs(includeUser=true) but never mutate one by accident.
    this.mcpTabIds = new Set();
    // Tracks the dedicated minimized Comet window the MCP creates on first use.
    this.mcpWindowId = null;
  }

  async ensureMcpWindow(initialUrl = "about:blank") {
    // Lazy-init the MCP-owned window. Creates with newWindow:true, gets its
    // windowId, minimizes it so it never surfaces in front of Zack's work.
    if (this.mcpWindowId !== null) return;
    const version = await this.version();
    const browser = new CdpConnection(version.webSocketDebuggerUrl, { label: "browser" });
    try {
      const result = await browser.send("Target.createTarget", { url: initialUrl, newWindow: true });
      this.mcpTabIds.add(result.targetId);
      this._seedTabId = result.targetId;
      let info;
      try {
        info = await browser.send("Browser.getWindowForTarget", { targetId: result.targetId });
      } catch (err) {
        console.error(`[comet-mcp] getWindowForTarget failed: ${err.message}`);
      }
      if (info?.windowId) {
        this.mcpWindowId = info.windowId;
        try {
          await browser.send("Browser.setWindowBounds", {
            windowId: info.windowId,
            bounds: { windowState: "minimized" },
          });
        } catch (err) {
          console.error(`[comet-mcp] window minimize failed: ${err.message}`);
        }
      }
    } finally {
      await browser.close();
    }
  }

  async browserError(cause) {
    let detail = "";
    const processes = await detectCometProcesses();
    if (processes.length > 0 && !processes.some((line) => /--remote-debugging-port=9224/i.test(line))) {
      detail =
        "Comet appears to already be running without --remote-debugging-port=9224; close all Comet windows/processes, then relaunch with the debug flag.";
    }
    return new BrowserNotReachableError(this.cdpHttp, cause, detail);
  }

  async httpJson(route, timeoutMs = 5000) {
    let response;
    try {
      response = await fetch(`${this.cdpHttp}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw await this.browserError(err);
    }
    if (!response.ok) throw new Error(`CDP HTTP ${route} failed: ${response.status} ${response.statusText}`);
    return await response.json();
  }

  async httpText(route, timeoutMs = 5000) {
    let response;
    try {
      response = await fetch(`${this.cdpHttp}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw await this.browserError(err);
    }
    if (!response.ok) throw new Error(`CDP HTTP ${route} failed: ${response.status} ${response.statusText}`);
    return await response.text();
  }

  async version() {
    return await this.httpJson("/json/version");
  }

  async listTabs() {
    const tabs = await this.httpJson("/json");
    const pages = tabs.filter((tab) => tab.type === "page");
    const filtered = this.isolated
      ? pages.filter((tab) => this.mcpTabIds.has(tab.id))
      : pages;
    return filtered.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      active: tab.id === this.activeTabId,
    }));
  }

  async getTab(tabId = undefined) {
    const tabs = await this.httpJson("/json");
    const pages = tabs.filter((tab) => tab.type === "page");
    if (pages.length === 0) throw new Error("No Comet page tabs are available");
    if (tabId) {
      const found = pages.find((tab) => tab.id === tabId);
      if (!found) throw new Error(`No tab with id ${tabId}`);
      return found;
    }
    if (this.activeTabId) {
      const active = pages.find((tab) => tab.id === this.activeTabId);
      if (active) return active;
    }
    this.activeTabId = pages[0].id;
    return pages[0];
  }

  async pickTab({ tab_id = undefined, url_substring = undefined } = {}) {
    const tabs = await this.httpJson("/json");
    const pages = tabs.filter((tab) => tab.type === "page");
    const universe = this.isolated
      ? pages.filter((tab) => this.mcpTabIds.has(tab.id))
      : pages;
    let matches = universe;
    if (tab_id) matches = universe.filter((tab) => tab.id === tab_id);
    if (url_substring) matches = universe.filter((tab) => (tab.url || "").includes(url_substring));
    if (matches.length === 0) {
      const scopeMsg = this.isolated
        ? " (isolated mode: only MCP-owned tabs are visible — use new_tab to open one)"
        : "";
      throw new Error(`No tab matched ${tab_id || url_substring || "request"}${scopeMsg}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Tab matched ${matches.length} tabs: ${matches
          .slice(0, 8)
          .map((tab) => `${tab.id} ${tab.title} ${tab.url}`)
          .join(" | ")}`,
      );
    }
    this.activeTabId = matches[0].id;
    // In isolated mode, NEVER call /json/activate — it steals focus and
    // un-minimizes the MCP window. The CDP session works on background tabs
    // just fine; the activate call is purely cosmetic.
    if (!this.isolated) {
      try {
        await this.httpText(`/json/activate/${encodeURIComponent(this.activeTabId)}`);
      } catch (err) {
        console.error(`[comet-mcp] Target activation failed, continuing with logical active tab: ${err.message}`);
      }
    }
    return { id: matches[0].id, title: matches[0].title || "", url: matches[0].url || "", active: true };
  }

  async newTab(url) {
    if (this.isolated) {
      // First MCP tab: create the dedicated minimized window in one shot.
      if (this.mcpWindowId === null) {
        await this.ensureMcpWindow(url);
        this.activeTabId = this._seedTabId;
        return { id: this._seedTabId, title: "", url, active: true };
      }
      // Subsequent tabs: open as a new tab; Comet attaches it to the MCP
      // window so long as that was the last target we touched (it is, since
      // we just made it active above and don't activate user tabs).
    }
    const version = await this.version();
    const browser = new CdpConnection(version.webSocketDebuggerUrl, { label: "browser" });
    const params = { url };
    if (this.isolated) {
      // Force the new tab into a fresh window we own; minimize after.
      params.newWindow = true;
    }
    const result = await browser.send("Target.createTarget", params);
    if (this.isolated) {
      this.mcpTabIds.add(result.targetId);
      try {
        const info = await browser.send("Browser.getWindowForTarget", { targetId: result.targetId });
        if (info?.windowId) {
          await browser.send("Browser.setWindowBounds", {
            windowId: info.windowId,
            bounds: { windowState: "minimized" },
          });
        }
      } catch (err) {
        console.error(`[comet-mcp] isolated-window setup failed: ${err.message}`);
      }
    }
    await browser.close();
    this.activeTabId = result.targetId;
    // Don't go through pickTab here — it would re-activate (un-minimize) in
    // non-isolated mode. Just return the tab info directly.
    return { id: result.targetId, title: "", url, active: true };
  }

  async closeTab(tabId) {
    const tab = await this.getTab(tabId);
    try {
      await this.httpText(`/json/close/${encodeURIComponent(tab.id)}`);
    } finally {
      const cached = this.sessions.get(tab.id);
      if (cached) await cached.close();
      this.sessions.delete(tab.id);
      if (this.activeTabId === tab.id) this.activeTabId = null;
      if (this.mcpTabIds.has(tab.id)) {
        this.mcpTabIds.delete(tab.id);
        // If the seed tab is gone, reset so next newTab creates a fresh
        // dedicated window instead of leaking into a user window.
        if (tab.id === this._seedTabId) {
          this._seedTabId = null;
          this.mcpWindowId = null;
        }
      }
    }
    return { closed: tab.id };
  }

  recordNetworkEvent(tabId, evt) {
    if (!this.networkLogs.has(tabId)) this.networkLogs.set(tabId, []);
    if (!this.inflight.has(tabId)) this.inflight.set(tabId, new Set());
    const logs = this.networkLogs.get(tabId);
    const inflight = this.inflight.get(tabId);
    const { method, params } = evt;
    if (method === "Network.requestWillBeSent") {
      inflight.add(params.requestId);
      logs.push({
        ts: new Date().toISOString(),
        type: "request",
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url,
      });
    } else if (method === "Network.responseReceived") {
      logs.push({
        ts: new Date().toISOString(),
        type: "response",
        requestId: params.requestId,
        status: params.response.status,
        mimeType: params.response.mimeType,
        url: params.response.url,
      });
    } else if (method === "Network.loadingFinished") {
      inflight.delete(params.requestId);
    } else if (method === "Network.loadingFailed") {
      inflight.delete(params.requestId);
      logs.push({
        ts: new Date().toISOString(),
        type: "failed",
        requestId: params.requestId,
        errorText: params.errorText,
      });
    }
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  }

  async session(tabId = undefined) {
    const tab = await this.getTab(tabId);
    const cached = this.sessions.get(tab.id);
    if (cached && cached.ws && cached.ws.readyState === WebSocket.OPEN) return { tab, cdp: cached };
    if (!tab.webSocketDebuggerUrl) throw new Error(`Tab ${tab.id} does not expose webSocketDebuggerUrl`);
    const cdp = new CdpConnection(tab.webSocketDebuggerUrl, {
      label: `tab ${tab.id}`,
      onEvent: (evt) => this.recordNetworkEvent(tab.id, evt),
    });
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024 });
    await cdp.send("Accessibility.enable").catch(() => {});
    // For MCP-owned tabs in isolated (minimized) mode, Chrome throttles or
    // freezes background-window pages, which prevents React/Monaco/most SPA
    // dashboards from ever hydrating. Force the page lifecycle to "active"
    // and emulate focus so the tab behaves like a foreground tab to JS.
    if (this.isolated && this.mcpTabIds.has(tab.id)) {
      await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch((err) => {
        console.error(`[comet-mcp] setWebLifecycleState failed for ${tab.id}: ${err.message}`);
      });
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    }
    this.sessions.set(tab.id, cdp);
    return { tab, cdp };
  }

  async evalJs(expr, { awaitPromise = true, tabId = undefined, timeoutMs = 30000 } = {}) {
    const { cdp } = await this.session(tabId);
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression: expr,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || "JavaScript evaluation failed";
      throw new Error(text);
    }
    const remote = result.result || {};
    if (Object.prototype.hasOwnProperty.call(remote, "value")) return remote.value;
    if (remote.unserializableValue) return remote.unserializableValue;
    return remote.description ?? null;
  }

  async injectFinder(tabId = undefined) {
    await this.evalJs(FINDER_SOURCE, { tabId, timeoutMs: 10000 });
  }

  async goto(url, { waitUntil = "load", tabId = undefined, timeoutMs = 30000 } = {}) {
    const { cdp } = await this.session(tabId);
    await cdp.send("Page.navigate", { url }, timeoutMs);
    await this.waitForLoadState(waitUntil, { tabId, timeoutMs });
    return { url: await this.evalJs("location.href", { tabId }) };
  }

  async waitForLoadState(waitUntil, { tabId = undefined, timeoutMs = 30000 } = {}) {
    const started = Date.now();
    const stateWanted = waitUntil === "domcontentloaded" ? "interactive" : "complete";
    if (waitUntil === "load" || waitUntil === "domcontentloaded") {
      while (Date.now() - started < timeoutMs) {
        const state = await this.evalJs("document.readyState", { tabId, timeoutMs: 5000 });
        if (state === stateWanted || (stateWanted === "interactive" && state === "complete")) return { state };
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${waitUntil}`);
    }
    if (waitUntil === "networkidle") {
      await this.waitForLoadState("domcontentloaded", { tabId, timeoutMs: Math.min(timeoutMs, 15000) });
      const { tab } = await this.session(tabId);
      let idleSince = Date.now();
      while (Date.now() - started < timeoutMs) {
        const active = this.inflight.get(tab.id)?.size || 0;
        if (active === 0) {
          if (Date.now() - idleSince >= 750) return { state: "networkidle" };
        } else {
          idleSince = Date.now();
        }
        await sleep(100);
      }
      throw new Error("Timed out waiting for networkidle");
    }
    throw new Error(`Unknown wait_until: ${waitUntil}`);
  }

  async findElement(args, { tabId = undefined, timeoutMs = 5000 } = {}) {
    await this.injectFinder(tabId);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.evalJs(`window.__cometMcp.find(${JSON.stringify(args)})`, { tabId, timeoutMs: 5000 });
      if (last.ok || (last.matches && last.matches.length > 1)) return last;
      await sleep(150);
    }
    return last || { ok: false, error: "No element matched" };
  }

  async click(args, { tabId = undefined, timeoutMs = 5000 } = {}) {
    const { cdp } = await this.session(tabId);
    const found = await this.findElement(args, { tabId, timeoutMs });
    if (!found.ok) throw new Error(found.error + (found.matches ? `: ${JSON.stringify(found.matches)}` : ""));
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: found.rect.x,
      y: found.rect.y,
      button: "none",
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: found.rect.x,
      y: found.rect.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: found.rect.x,
      y: found.rect.y,
      button: "left",
      clickCount: 1,
    });
    return found.preview;
  }

  async fill(args, { tabId = undefined, timeoutMs = 5000 } = {}) {
    await this.injectFinder(tabId);
    const deadline = Date.now() + timeoutMs;
    let result;
    while (Date.now() < deadline) {
      result = await this.evalJs(`window.__cometMcp.fill(${JSON.stringify(args)})`, { tabId, timeoutMs: 5000 });
      if (result.ok || (result.matches && result.matches.length > 1)) break;
      await sleep(150);
    }
    if (!result?.ok) throw new Error((result?.error || "Fill target not found") + (result?.matches ? `: ${JSON.stringify(result.matches)}` : ""));
    return result.preview;
  }

  async press(key, { tabId = undefined } = {}) {
    const { cdp } = await this.session(tabId);
    const special = {
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    };
    const def = special[key] || {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      text: key.length === 1 ? key : undefined,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...def });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...def });
    return { pressed: key };
  }

  async getText(selector, { tabId = undefined } = {}) {
    await this.injectFinder(tabId);
    return await this.evalJs(`window.__cometMcp.getText(${JSON.stringify(selector)})`, { tabId });
  }

  async waitForSelector(selector, { timeoutMs = 10000, tabId = undefined } = {}) {
    await this.injectFinder(tabId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const exists = await this.evalJs(`window.__cometMcp.selectorExists(${JSON.stringify(selector)})`, { tabId, timeoutMs: 5000 });
      if (exists) return { found: true, selector };
      await sleep(150);
    }
    throw new Error(`Timed out waiting for selector: ${selector}`);
  }

  async waitForUrl(substring, { timeoutMs = 15000, tabId = undefined } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { tab } = await this.session(tabId);
      const url = tab.url || (await this.evalJs("location.href", { tabId, timeoutMs: 5000 }));
      if (url.includes(substring)) return { found: true, url };
      await sleep(250);
    }
    throw new Error(`Timed out waiting for URL containing: ${substring}`);
  }

  async screenshot({ fullPage = false, outPath = null, tabId = undefined } = {}) {
    const { cdp } = await this.session(tabId);
    let params = { format: "png", fromSurface: true, captureBeyondViewport: true };
    if (fullPage) {
      const metrics = await cdp.send("Page.getLayoutMetrics");
      const { width, height } = metrics.contentSize;
      params = {
        ...params,
        clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 1 },
      };
    }
    const result = await cdp.send("Page.captureScreenshot", params, 30000);
    if (outPath) {
      const absolute = path.resolve(outPath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, Buffer.from(result.data, "base64"));
      return { path: absolute, mimeType: "image/png" };
    }
    return { data: result.data, mimeType: "image/png" };
  }

  async accessibilityTree({ maxDepth = 20, tabId = undefined } = {}) {
    const { cdp } = await this.session(tabId);
    const result = await cdp.send("Accessibility.getFullAXTree", {}, 30000);
    const nodes = result.nodes || [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const childIds = new Set(nodes.flatMap((node) => node.childIds || []));
    const root = nodes.find((node) => !childIds.has(node.nodeId)) || nodes[0];
    const trimNode = (node, depth) => {
      if (!node || depth > maxDepth) return null;
      return {
        role: node.role?.value || "",
        name: node.name?.value || "",
        value: node.value?.value || undefined,
        ignored: Boolean(node.ignored),
        children: (node.childIds || []).map((id) => trimNode(byId.get(id), depth + 1)).filter(Boolean),
      };
    };
    return trimNode(root, 0);
  }

  networkLog({ filter = null, lastN = 50, tabId = undefined } = {}) {
    const id = tabId || this.activeTabId;
    const logs = id ? this.networkLogs.get(id) || [] : [...this.networkLogs.values()].flat();
    const filtered = filter
      ? logs.filter((entry) => JSON.stringify(entry).toLowerCase().includes(String(filter).toLowerCase()))
      : logs;
    return filtered.slice(-lastN);
  }

  async detectCaptcha({ tabId = undefined } = {}) {
    const js = `
    (() => {
      const out = [];
      const recap2 = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
      if (recap2) {
        const sitekey = new URL(recap2.src).searchParams.get('k') || '';
        out.push({ type: 'recaptcha_v2', sitekey, frameUrl: recap2.src });
      }
      const recap3 = document.querySelector('script[src*="recaptcha/api.js?render="]');
      if (recap3) {
        const m = recap3.src.match(/render=([^&]+)/);
        if (m) out.push({ type: 'recaptcha_v3', sitekey: m[1] });
      }
      const hcap = document.querySelector('iframe[src*="hcaptcha.com/captcha"]');
      if (hcap) {
        const sitekey = new URL(hcap.src).searchParams.get('sitekey') || '';
        out.push({ type: 'hcaptcha', sitekey, frameUrl: hcap.src });
      }
      const turnstile = document.querySelector('iframe[src*="challenges.cloudflare.com"], div.cf-turnstile, [data-sitekey][class*="turnstile"]');
      if (turnstile) {
        const sitekey = turnstile.getAttribute('data-sitekey') || (turnstile.src ? new URL(turnstile.src).searchParams.get('k') : '') || '';
        out.push({ type: 'cloudflare_turnstile', sitekey });
      }
      return { url: location.href, captchas: out };
    })();
    `;
    return await this.evalJs(js, { tabId });
  }

  async solveCaptcha({ tabId = undefined, twoCaptchaKey = null } = {}) {
    const key = twoCaptchaKey || process.env.TWOCAPTCHA_API_KEY || null;
    const detected = await this.detectCaptcha({ tabId });
    if (!detected.captchas || detected.captchas.length === 0) {
      return { solved: false, reason: "no_captcha_detected", url: detected.url };
    }
    if (!key) {
      return {
        solved: false,
        reason: "no_api_key",
        message: "Detected captcha but TWOCAPTCHA_API_KEY env var is not set. Set it or pass twoCaptchaKey to enable auto-solve.",
        detected: detected.captchas,
      };
    }
    const cap = detected.captchas[0];
    if (!["recaptcha_v2", "hcaptcha", "cloudflare_turnstile"].includes(cap.type)) {
      return { solved: false, reason: "unsupported_type", detected: cap };
    }
    const pageUrl = detected.url;
    const method =
      cap.type === "recaptcha_v2" ? "userrecaptcha" :
      cap.type === "hcaptcha" ? "hcaptcha" :
      "turnstile";
    const submitParams = new URLSearchParams({ key, method, sitekey: cap.sitekey, pageurl: pageUrl, json: "1" });
    const submitRes = await (await fetch(`https://2captcha.com/in.php?${submitParams}`)).json();
    if (submitRes.status !== 1) return { solved: false, reason: "2captcha_submit_failed", details: submitRes };
    const taskId = submitRes.request;
    // Poll up to 120s
    let token = null;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await (await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${taskId}&json=1`)).json();
      if (pollRes.status === 1) { token = pollRes.request; break; }
      if (pollRes.request !== "CAPCHA_NOT_READY") return { solved: false, reason: "2captcha_poll_failed", details: pollRes };
    }
    if (!token) return { solved: false, reason: "timeout", taskId };
    // Inject the token into the page
    const injectJs = cap.type === "recaptcha_v2"
      ? `(()=>{const ta=document.querySelector('textarea[name="g-recaptcha-response"]'); if(ta){ta.style.display='block';ta.value=${JSON.stringify(token)};ta.dispatchEvent(new Event('input',{bubbles:true}));} return !!ta;})()`
      : cap.type === "hcaptcha"
        ? `(()=>{const ta=document.querySelector('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]'); if(ta){ta.value=${JSON.stringify(token)};ta.dispatchEvent(new Event('input',{bubbles:true}));} return !!ta;})()`
        : `(()=>{const i=document.querySelector('input[name="cf-turnstile-response"]'); if(i){i.value=${JSON.stringify(token)};i.dispatchEvent(new Event('input',{bubbles:true}));} return !!i;})()`;
    const injected = await this.evalJs(injectJs, { tabId });
    return { solved: !!injected, type: cap.type, token: token.slice(0, 20) + "…", injected };
  }

  async readCookies({ domain, includeValues = false, tabId = undefined } = {}) {
    const { cdp } = await this.session(tabId);
    const urls = domain.startsWith("http") ? [domain] : [`https://${domain}`, `http://${domain}`];
    const result = await cdp.send("Network.getCookies", { urls });
    return (result.cookies || []).map((cookie) => ({
      name: cookie.name,
      value: includeValues ? cookie.value : "<redacted>",
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      size: cookie.size,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }
}

async function detectCometProcesses() {
  if (process.platform !== "win32") return [];
  const ps = [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'comet.exe'\" | ForEach-Object { $_.CommandLine }",
  ];
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile("powershell.exe", ps, { windowsHide: true, timeout: 3000 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

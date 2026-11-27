#!/usr/bin/env node
import { CometController, COMET_LAUNCH_COMMAND } from "../src/cdp.js";

const browser = new CometController();

try {
  const tabs = await browser.listTabs();
  console.log(JSON.stringify({ ok: true, tabs }, null, 2));
} catch (err) {
  console.error(err?.message || String(err));
  console.error(`Launch Comet with: ${COMET_LAUNCH_COMMAND}`);
  process.exit(1);
}

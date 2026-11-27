#!/usr/bin/env node
// Brute-force test matrix for supabase.run_sql.
// Runs every case sequentially against a real Supabase project, reports
// pass/fail + timing in a single table at the end.
//
// Usage:
//   COMET_MCP_ISOLATED=1 node scripts/brute_supabase_run_sql.js <project_ref>

import { CometController } from "../src/cdp.js";
import { runSql } from "../src/workflows/supabase.js";

const [, , project] = process.argv;
if (!project) {
  console.error("Usage: COMET_MCP_ISOLATED=1 node scripts/brute_supabase_run_sql.js <project_ref>");
  process.exit(2);
}

const controller = new CometController();

// Confirm browser reachable up front.
await controller.listTabs().catch((err) => {
  console.error(`Cannot reach Comet: ${err.message}`);
  process.exit(1);
});

const CASES = [
  { name: "cold start",            sql: "select now();",                                                                       expect: "ok",     project },
  { name: "multi-row select",      sql: "select schemaname, tablename from pg_tables where schemaname='public' limit 20;",     expect: "ok",     project },
  { name: "multi-statement",       sql: "select 1; select 2; select 3;",                                                       expect: "ok",     project },
  { name: "DDL silent success",    sql: "create temp table _smoketest (id int); drop table _smoketest;",                       expect: "ok",     project },
  { name: "syntax error",          sql: "selct * from nothing;",                                                               expect: "err",    project, expectPgCode: "42601" },
  { name: "object not found",      sql: "select * from no_such_table_brute;",                                                  expect: "err",    project, expectPgCode: "42P01" },
  { name: "destructive: drop",     sql: "drop table if exists _smoketest_brute_force_xyz;",                                    expect: "ok",     project },
  { name: "pg_sleep timing",       sql: "select pg_sleep(3), 'done' as note;",                                                 expect: "ok",     project },
  { name: "empty sql guard",       sql: "",                                                                                    expect: "err",    project, expectStage: "validate" },
  { name: "bad project ref",       sql: "select 1;",                                                                           expect: "err",    project: "nopenopenope" },
];

const rows = [];
for (const c of CASES) {
  const t0 = Date.now();
  let res;
  try {
    res = await runSql(controller, { project: c.project, sql: c.sql, timeout_ms: 60000 });
  } catch (err) {
    res = { ok: false, stage: "threw", error: err.message || String(err) };
  }

  let pass = false;
  let why = "";
  if (c.expect === "ok") {
    pass = res.ok === true;
    why = pass ? "" : `expected ok=true, got ${JSON.stringify({ ok: res.ok, stage: res.stage, error: res.error?.slice(0, 60) })}`;
  } else {
    pass = res.ok === false;
    if (pass && c.expectPgCode) {
      pass = res.pg_code === c.expectPgCode;
      if (!pass) why = `expected pg_code=${c.expectPgCode}, got ${res.pg_code}`;
    }
    if (pass && c.expectStage) {
      pass = res.stage === c.expectStage;
      if (!pass) why = `expected stage=${c.expectStage}, got ${res.stage}`;
    }
    if (!pass && !why) why = `expected ok=false, got ${JSON.stringify({ ok: res.ok })}`;
  }

  rows.push({
    name: c.name,
    pass,
    ms: res.ms ?? (Date.now() - t0),
    stage: res.stage,
    polls: res.polls,
    pg_code: res.pg_code,
    modal: res.modal_handled,
    rows_returned: res.rows,
    why,
  });

  const symbol = pass ? "PASS" : "FAIL";
  console.log(
    `[${symbol}] ${c.name.padEnd(28)}  ${String(res.ms ?? "?").padStart(6)}ms  stage=${(res.stage || "").padEnd(16)} polls=${res.polls ?? "?"}${why ? "  — " + why : ""}`,
  );
}

console.log("\n=== Orphan tab check ===");
const data = await fetch("http://127.0.0.1:9224/json").then((r) => r.json());
const sqlOpen = data.filter((t) => t.type === "page" && /supabase\.com\/dashboard\/.*\/sql/.test(t.url || ""));
console.log(`SQL editor tabs still open: ${sqlOpen.length}`);

const passCount = rows.filter((r) => r.pass).length;
console.log(`\n=== SUMMARY ===`);
console.log(`${passCount} / ${rows.length} passed`);

const failed = rows.filter((r) => !r.pass);
if (failed.length) {
  console.log("\nFailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.why}`);
}

process.exit(passCount === rows.length ? 0 : 1);

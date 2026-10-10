#!/usr/bin/env node
// Agent engine tests. Pure node: the LLM is a local HTTP stub returning fixed
// tool_calls (driven through the REAL agent/llm.js), tabs are fakes, electron
// is never required (engine takes injected {chat, sender, tabProvider, store}).
//
// Asserts: tool loop order snapshot->act->diff, stale ref REF_STALE,
// cross-group SCOPE_DENIED, approval-deny executes nothing.
"use strict";

const http = require("http");
const engine = require("./agent/engine");
const llm = require("./agent/llm");
const tools = require("./agent/tools");
const snap = require("./agent/snapshot");
const { validateAst } = require("../automation/runtime/rpa-ast");

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) { console.log("PASS  " + name + (detail ? ": " + detail : "")); pass++; }
  else { console.log("FAIL  " + name + (detail ? ": " + detail : "")); fail++; }
}
function skip(name, why) {
  console.log("SKIP  " + name + (why ? ": " + why : "")); skipped++;
}

// ---------- fake LLM over local HTTP ----------
let fakeUrl = "";
let script = [];       // queued chat/completions bodies, shifted per request
let blockChat = false; // when true the stub holds the request open
let release = null;    // frees one held request
let callSeq = 0;
let bodies = [];       // raw chat request bodies (JSON strings), per chat call
function toolMsg(calls) {
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c) => ({
    id: "call_" + (++callSeq), type: "function",
    function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
  })) } }] };
}
function finalMsg(text) {
  return { choices: [{ message: { role: "assistant", content: text } }] };
}
function startStub() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        bodies.push(body);
        // Reserve the queued reply BEFORE a possible blockChat hold: a held
        // request must not steal script entries queued for a later test.
        const next = script.length ? script.shift() : finalMsg("stub-exhausted");
        if (blockChat) await new Promise((r) => { release = r; });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next));
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      fakeUrl = "http://127.0.0.1:" + srv.address().port;
      resolve(srv);
    });
  });
}

// ---------- fake accessibility tabs ----------
function baseNodes() {
  const n = (nodeId, backendDOMNodeId, role, name, ignored) => ({
    nodeId, backendDOMNodeId, frameId: "F", ignored: !!ignored,
    role: { value: role }, name: { value: name || "" },
  });
  return [
    n(1, 11, "RootWebArea", "page"),
    n(2, 22, "button", "Go"),
    n(3, 33, "link", "More"),
    n(4, 44, "button", "Hidden", true), // filtered: hidden/ignored never get refs
  ];
}
function mutatedNodes() {
  const nodes = baseNodes();
  nodes[1].name.value = "Stop"; // same doc, same ids: refs stay, text diffs
  return nodes;
}
// Makes a fake tab {id, groupId, view:{webContents}} with a call log.
// Clicking (mousePressed) flips the page so the post-act snapshot diffs.
function makeTab(tabId, groupId) {
  const log = [];
  const state = { clicked: false };
  const dbg = { attached: false };
  dbg.attach = () => {
    if (dbg.attached) throw new Error("already attached");
    dbg.attached = true; log.push("attach");
  };
  dbg.detach = () => { dbg.attached = false; log.push("detach"); };
  dbg.sendCommand = async (method, params) => {
    log.push(method);
    if (method === "Accessibility.enable") return {};
    if (method === "DOM.getDocument") return { root: { documentURL: "http://t/", nodeId: 1 } };
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: state.clicked ? mutatedNodes() : baseNodes() };
    }
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 20, 0, 20] } };
    if (method === "Input.dispatchMouseEvent") {
      if (params && params.type === "mousePressed") state.clicked = true;
      return {};
    }
    if (method === "Input.dispatchKeyEvent" || method === "Input.insertText") return {};
    return {};
  };
  const webContents = {
    debugger: dbg,
    executeJavaScript: async (code) => { log.push("js"); return ""; },
    capturePage: async () => { log.push("capture"); return { toDataURL: () => "data:image/png;base64,AAA" }; },
    loadURL: async (url) => { log.push("load:" + url); },
    goBack: async () => { log.push("back"); },
    goForward: async () => { log.push("forward"); },
    reload: async () => { log.push("reload"); },
  };
  return { id: tabId, groupId, view: { webContents }, log };
}
function makeProvider(tabsById, active) {
  const p = {
    activeTabId: active.tab,
    activeGroup: active.group,
    getActiveTab() { return tabsById[this.activeTabId] || null; },
    activeGroupId() { return this.activeGroup; },
    listTabs: (gid) => Object.values(tabsById)
      .filter((t) => t.groupId === gid).map((t) => ({ id: t.id, url: "http://t/", title: "T" })),
    createTab: () => "tab-new",
    closeTab: () => true,
    getTab: (id) => tabsById[id] || null,
  };
  return p;
}
function memStore() {
  return {
    cfg: { baseUrl: "x", model: "m" }, key: "k", runs: [],
    getConfig() { return { baseUrl: this.cfg.baseUrl, model: this.cfg.model, hasKey: !!this.key }; },
    setConfig(c) {
      if (c.baseUrl !== undefined) this.cfg.baseUrl = c.baseUrl;
      if (c.model !== undefined) this.cfg.model = c.model;
      if (c.key !== undefined) this.key = c.key;
      return this.getConfig();
    },
    getKey() { if (!this.key) throw new Error("no key"); return this.key; },
    appendRun(id, o) { this.runs.push([id, o]); },
  };
}

// ---------- run harness ----------
let events = [];
let allEvents = [];          // every event across all tests (for contract-set check)
let seenTypes = new Set();   // distinct event types across all tests
const CONTRACT_TYPES = ["agent:started", "agent:tool-call", "agent:tool-result",
  "agent:approval-needed", "agent:approval-resolved", "agent:done", "agent:stopped", "agent:error"];
let autoApprove = null; // 'approve' | 'deny' | null
function sender(e) {
  events.push(e);
  allEvents.push(e);
  seenTypes.add(e.type);
  if (autoApprove && e.type === "agent:approval-needed") {
    setImmediate(() => engine.approve(e.runId, autoApprove === "approve"));
  }
}
function chat(a) { return llm.chatCompletion({ ...a, baseUrl: fakeUrl }); }
function waitFor(type, runId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = events.find((e) => e.type === type && (!runId || e.runId === runId));
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error("timeout waiting " + type));
      setTimeout(tick, 20);
    };
    tick();
  });
}
function toolResult(store, name) {
  const hit = store.runs.map((r) => r[1]).find((o) => o.t === "tool" && o.name === name);
  return hit && hit.result;
}

async function main() {
  let server = null;
  try {
    server = await startStub();
  } catch (e) {
    skip("agent-suite", "stub http failed: " + e.message);
    console.log(`\nagent-engine: pass=${pass} fail=${fail} skip=${skipped}`);
    process.exit(0);
  }

  // T1: loop order snapshot -> act -> diff (auto-approve the write)
  {
    snap.clearTab("tab-t1");
    const tab = makeTab("tab-t1", "g1");
    const store = memStore();
    events = []; autoApprove = "approve";
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t1": tab }, { tab: "tab-t1", group: "g1" }), store, approvalTimeoutMs: 30000 });
    script = [toolMsg([["snapshot", {}]]), toolMsg([["act", { kind: "click", ref: 2 }]]), finalMsg("bought it")];
    const r = engine.start({ goal: "click Go" });
    check("T1 start returns runId", !!r.runId, r.runId || r.error);
    const done = await waitFor("agent:done", r.runId);
    const firstSnapResult = events.findIndex((e) => e.type === "agent:tool-result" && e.name === "snapshot");
    const actCall = events.findIndex((e) => e.type === "agent:tool-call" && e.name === "act");
    check("T1 snapshot result precedes act call", firstSnapResult >= 0 && actCall > firstSnapResult);
    const noPreApproval = events.slice(0, firstSnapResult).every((e) => e.type !== "agent:approval-needed");
    check("T1 read tool needs no approval", noPreApproval);
    check("T1 act executed via Input", tab.log.includes("Input.dispatchMouseEvent"));
    const actRes = toolResult(store, "act");
    check("T1 act result carries diff", !!(actRes && actRes.diff && actRes.diff.includes("- 2: button Go") && actRes.diff.includes("+ 2: button Stop")), actRes && actRes.diff);
    check("T1 final answer ends run", done.result === "bought it", done.result);
  }

  // T2: stale ref -> REF_STALE + fresh snapshot
  {
    snap.clearTab("tab-t2");
    const tab = makeTab("tab-t2", "g1");
    const ctx = { tab, activeGroupId: "g1", listTabs: () => [], createTab: () => "", closeTab: () => true, getTab: () => null };
    await tools.runTool("snapshot", {}, ctx); // prime the table (refs 1..3)
    const res = await tools.runTool("act", { kind: "click", ref: 9999 }, ctx);
    check("T2 stale ref returns REF_STALE", res && res.error === "REF_STALE", res && res.error);
    check("T2 stale attaches fresh snapshot", !!(res && res.snapshot && res.snapshot.includes("page-content")));
  }

  // T3: cross-group denied at every entry
  {
    snap.clearTab("tab-t3");
    const tab = makeTab("tab-t3", "gX");
    const ctx = { tab, activeGroupId: "g1", listTabs: () => [], createTab: () => "", closeTab: () => true, getTab: () => null };
    const r1 = await tools.runTool("snapshot", {}, ctx);
    const other = makeTab("tab-o", "g1");
    const ctx2 = { tab: other, activeGroupId: "g1", listTabs: () => [], createTab: () => "", closeTab: () => true, getTab: (id) => (id === "tab-t3" ? tab : null) };
    const r2 = await tools.runTool("tabs", { action: "close", tabId: "tab-t3" }, ctx2);
    check("T3 foreign-group snapshot SCOPE_DENIED", r1 && r1.error === "SCOPE_DENIED", r1 && r1.error);
    check("T3 cross-group close SCOPE_DENIED", r2 && r2.error === "SCOPE_DENIED", r2 && r2.error);
  }

  // T4: approval denied -> tool never executes
  {
    snap.clearTab("tab-t4");
    const tab = makeTab("tab-t4", "g1");
    const store = memStore();
    events = []; autoApprove = "deny";
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t4": tab }, { tab: "tab-t4", group: "g1" }), store, approvalTimeoutMs: 30000 });
    script = [toolMsg([["snapshot", {}]]), toolMsg([["act", { kind: "click", ref: 2 }]]), finalMsg("stood down")];
    const r = engine.start({ goal: "click Go" });
    await waitFor("agent:done", r.runId);
    check("T4 denied act never touches Input", !tab.log.includes("Input.dispatchMouseEvent"), tab.log.join(","));
    const actRes = toolResult(store, "act");
    check("T4 denial recorded as APPROVAL_DENIED", !!(actRes && actRes.error === "APPROVAL_DENIED"), actRes && actRes.error);
  }

  // T5: approval timeout (short) == deny
  {
    snap.clearTab("tab-t5");
    const tab = makeTab("tab-t5", "g1");
    const store = memStore();
    events = []; autoApprove = null;
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t5": tab }, { tab: "tab-t5", group: "g1" }), store, approvalTimeoutMs: 100 });
    script = [toolMsg([["snapshot", {}]]), toolMsg([["act", { kind: "click", ref: 2 }]]), finalMsg("timed out path")];
    const t0 = Date.now();
    const r = engine.start({ goal: "click Go" });
    await waitFor("agent:done", r.runId);
    const elapsed = Date.now() - t0;
    const resolved = events.find((e) => e.type === "agent:approval-resolved");
    check("T5 timeout resolves as deny", !!(resolved && resolved.approved === false && resolved.reason === "timeout"), JSON.stringify(resolved));
    check("T5 timed-out act never executes", !tab.log.includes("Input.dispatchMouseEvent"));
    check("T5 finishes fast (<5s)", elapsed < 5000, elapsed + "ms");
    engine.configure({ approvalTimeoutMs: 30000 });
  }

  // T6: single-run mutex -> AGENT_BUSY
  {
    snap.clearTab("tab-t6");
    const tab = makeTab("tab-t6", "g1");
    events = []; autoApprove = null;
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t6": tab }, { tab: "tab-t6", group: "g1" }), store: memStore(), approvalTimeoutMs: 30000 });
    script = [];
    blockChat = true;
    const r1 = engine.start({ goal: "one" });
    const r2 = engine.start({ goal: "two" });
    check("T6 second start is AGENT_BUSY", r2 && r2.error === "AGENT_BUSY", (r2 && (r2.error || r2.runId)) || "no-return");
    if (release) { const rel = release; release = null; rel(); }
    blockChat = false;
    await waitFor("agent:done", r1.runId);
    check("T6 first run completes after release", engine.isRunning() === false);
  }

  // T7: stop() aborts the fetch mid-flight
  {
    snap.clearTab("tab-t7");
    const tab = makeTab("tab-t7", "g1");
    events = []; autoApprove = null;
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t7": tab }, { tab: "tab-t7", group: "g1" }), store: memStore(), approvalTimeoutMs: 30000 });
    script = [];
    blockChat = true;
    const r = engine.start({ goal: "hang" });
    await new Promise((res) => setTimeout(res, 200)); // let the fetch leave
    const s = engine.stop();
    check("T7 stop acks", !!(s && s.ok), JSON.stringify(s));
    const stopped = await waitFor("agent:stopped", r.runId);
    check("T7 run ends stopped", stopped.reason === "stop", stopped.reason);
    blockChat = false;
    if (release) { const rel = release; release = null; try { rel(); } catch (_) {} }
  }

  // T8: config roundtrip never leaks the key
  {
    const store = memStore();
    engine.configure({ store });
    engine.setConfig({ baseUrl: "http://x", model: "m", key: "sekret" });
    const got = engine.getConfig();
    check("T8 config roundtrip", got.baseUrl === "http://x" && got.model === "m" && got.hasKey === true, JSON.stringify(got));
    check("T8 key not exposed", !("key" in got));
  }

  // T9: screenshot dual-channel — full dataUrl to UI, omitted to LLM
  {
    snap.clearTab("tab-t9");
    const tab = makeTab("tab-t9", "g1");
    const BIG = "data:image/png;base64," + "A".repeat(10000);
    tab.view.webContents.capturePage = async () => { tab.log.push("capture"); return { toDataURL: () => BIG }; };
    const store = memStore();
    events = []; autoApprove = null;
    const b0 = bodies.length;
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t9": tab }, { tab: "tab-t9", group: "g1" }), store, approvalTimeoutMs: 30000 });
    script = [toolMsg([["screenshot", {}]]), finalMsg("seen")];
    const r = engine.start({ goal: "shot" });
    const done = await waitFor("agent:done", r.runId);
    check("T9 run completes", done.result === "seen", done.result);
    const shotEvt = events.find((e) => e.type === "agent:tool-result" && e.name === "screenshot");
    check("T9 tool-result carries image", !!(shotEvt && typeof shotEvt.image === "string" && shotEvt.image.startsWith("data:")), shotEvt && String(shotEvt.image).slice(0, 30));
    check("T9 image is full dataUrl", !!(shotEvt && shotEvt.image === BIG), shotEvt && String(shotEvt.image).length);
    check("T9 event result omits dataUrl", !!(shotEvt && shotEvt.result && shotEvt.result.dataUrl === "[screenshot omitted]"), (JSON.stringify(shotEvt && shotEvt.result) || "").slice(0, 80));
    const newBodies = bodies.slice(b0);
    let toolContent = "";
    try {
      const req2 = JSON.parse(newBodies[1] || "{}");
      const tm = (req2.messages || []).find((m) => m.role === "tool");
      toolContent = (tm && tm.content) || "";
    } catch (_) { toolContent = ""; }
    check("T9 LLM content omits full dataUrl", !!toolContent && !toolContent.includes(BIG) && toolContent.includes("[screenshot omitted]"), toolContent.slice(0, 80));
    check("T9 LLM content equals event result", toolContent === JSON.stringify(shotEvt && shotEvt.result), toolContent.length + " chars");
    check("T9 LLM content stays small", toolContent.length < 4000, toolContent.length + " chars");
    const stored = toolResult(store, "screenshot");
    check("T9 stored result also omitted", !!(stored && stored.dataUrl === "[screenshot omitted]"), (JSON.stringify(stored) || "").slice(0, 80));
  }

  // T10: generic volume guard — >4000 char JSON truncates to {truncated, preview}
  {
    snap.clearTab("tab-t10");
    const tab = makeTab("tab-t10", "g1");
    const HUGE = "x".repeat(10000);
    tab.view.webContents.executeJavaScript = async () => { tab.log.push("js"); return HUGE; };
    const store = memStore();
    events = []; autoApprove = null;
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t10": tab }, { tab: "tab-t10", group: "g1" }), store, approvalTimeoutMs: 30000 });
    script = [toolMsg([["read", {}]]), finalMsg("read-done")];
    const r = engine.start({ goal: "read huge" });
    await waitFor("agent:done", r.runId);
    const readEvt = events.find((e) => e.type === "agent:tool-result" && e.name === "read");
    check("T10 large result truncates", !!(readEvt && readEvt.result && readEvt.result.truncated === true), (JSON.stringify(readEvt && readEvt.result) || "").slice(0, 80));
    check("T10 preview is 2000 chars", !!(readEvt && readEvt.result && typeof readEvt.result.preview === "string" && readEvt.result.preview.length === 2000), String(readEvt && readEvt.result && readEvt.result.preview && readEvt.result.preview.length));
  }

  // T11: error path + frozen 8-type contract
  {
    snap.clearTab("tab-t11");
    const tab = makeTab("tab-t11", "g1");
    const store = memStore();
    events = []; autoApprove = null;
    engine.configure({ chat: async () => { throw new Error("LLM_BOOM"); }, sender, tabProvider: makeProvider({ "tab-t11": tab }, { tab: "tab-t11", group: "g1" }), store, approvalTimeoutMs: 30000 });
    const r = engine.start({ goal: "boom" });
    const err = await waitFor("agent:error", r.runId);
    check("T11 chat throw becomes agent:error", !!(err && String(err.error).includes("LLM_BOOM")), err && err.error);    const seen = [...seenTypes].sort();
    const want = [...CONTRACT_TYPES].sort();
    check("T11 event type set is exactly the 8 contract types", JSON.stringify(seen) === JSON.stringify(want), seen.join(","));
    const fs = require("fs");
    const src = fs.readFileSync(__dirname + "/agent/engine.js", "utf-8");
    const emitted = [...new Set((src.match(/type:\s*['"]agent:[a-z-]+['"]/g) || []).map((m) => m.match(/agent:[a-z-]+/)[0]))].sort();
    check("T11 engine.js emits exactly the 8 types", JSON.stringify(emitted) === JSON.stringify(want), emitted.join(","));
    const shapeOk = (e) => {
      if (!e || typeof e.type !== "string" || typeof e.runId !== "string") return false;
      if ("denied" in e) return false; // old shape, must be result now
      switch (e.type) {
        case "agent:started": return typeof e.goal === "string";
        case "agent:tool-call": return typeof e.name === "string" && e.args && typeof e.args === "object";
        case "agent:tool-result": return typeof e.name === "string" && ("result" in e);
        case "agent:approval-needed": return !!(e.toolCall && typeof e.toolCall.id === "string" && typeof e.toolCall.name === "string" && e.toolCall.args && typeof e.toolCall.args === "object");
        case "agent:approval-resolved": return typeof e.approved === "boolean";
        case "agent:done": return ("result" in e);
        case "agent:stopped": return typeof e.reason === "string";
        case "agent:error": return typeof e.error === "string";
        default: return false;
      }
    };
    check("T11 all emitted events match frozen payloads", allEvents.every(shapeOk), allEvents.length + " events");
  }

  // T12: automation bridge — record buffers, runScript dispatches, unwired honest
  {
    // record happy: unsupported step + buffer cap + happy append
    const ctx0 = { tab: makeTab("tab-t12", "g1"), activeGroupId: "g1", trajectory: [] };
    const bad = await tools.runTool("record", { step: "hack" }, ctx0);
    check("T12 record rejects unknown step", !!(bad && bad.error && bad.error.startsWith("RECORD_STEP_UNSUPPORTED")), bad && bad.error);
    const noBuf = await tools.runTool("record", { step: "goto", url: "https://x" }, { tab: ctx0.tab, activeGroupId: "g1" });
    check("T12 record without buffer is honest", !!(noBuf && noBuf.error === "RECORD_NO_BUFFER: host did not wire a trajectory buffer"), noBuf && noBuf.error);
    const r1 = await tools.runTool("record", { step: "goto", url: "https://x" }, ctx0);
    const r2 = await tools.runTool("record", { step: "waitForText", selector: "#msg", text: "hi" }, ctx0);
    const r3 = await tools.runTool("record", { step: "waitForSelector", selector: "#btn" }, ctx0);
    check("T12 record appends with count", !!(r1 && r1.ok && r1.buffered === 1 && r2 && r2.buffered === 2 && r3 && r3.buffered === 3), JSON.stringify([r1, r2, r3]));
    const mapped = ctx0.trajectory.slice(1);
    check("T12 waitFor* maps to AST wait nodes", !!(mapped[0] && mapped[0].type === "wait" && mapped[0].for === "text" && mapped[0].selector === "#msg" && mapped[0].text === "hi" && mapped[1] && mapped[1].type === "wait" && mapped[1].for === "selector" && mapped[1].selector === "#btn"), JSON.stringify(mapped));
    const vres = validateAst(ctx0.trajectory);
    check("T12 mapped nodes validate against rpa-ast", vres.ok === true, JSON.stringify(vres.errors));
    const badWait = await tools.runTool("record", { step: "waitForText", text: "no selector" }, ctx0);
    check("T12 waitForText without selector rejected", !!(badWait && badWait.error && badWait.error.startsWith("RECORD_WAIT_MISSING_FIELDS")), badWait && badWait.error);
    // runScript empty / unwired honest
    const empty = await tools.runTool("runScript", {}, { trajectory: [] });
    check("T12 runScript empty is honest", !!(empty && empty.error && empty.error.startsWith("RUNSCRIPT_EMPTY")), empty && empty.error);
    const unwired = await tools.runTool("runScript", {}, ctx0);
    check("T12 runScript unwired is honest", !!(unwired && unwired.error && unwired.error.startsWith("RUNSCRIPT_NOT_WIRED")), unwired && unwired.error);
    check("T12 unwired keeps buffer (no flush on honest error)", ctx0.trajectory.length === 3);
    // wired: dispatch returns runner outcome + flushes
    const wiredCtx = { trajectory: [{ type: "goto", url: "https://x" }], automation: { runTrajectory: async (steps) => ({ status: "SUCCESS", executionId: "e-1", result: { steps: steps.length } }) } };
    const w = await tools.runTool("runScript", { name: "t12" }, wiredCtx);
    check("T12 wired dispatch returns status+executionId", !!(w && w.ok && w.status === "SUCCESS" && w.executionId === "e-1" && w.steps === 1), JSON.stringify(w));
    check("T12 dispatch flushes buffer", wiredCtx.trajectory.length === 0);
    // wired runner throw -> RUNSCRIPT_FAILED, buffer kept (retryable)
    const throwCtx = { trajectory: [{ type: "goto" }], automation: { runTrajectory: async () => { throw new Error("store down"); } } };
    const th = await tools.runTool("runScript", {}, throwCtx);
    check("T12 runner throw is honest FAILED", !!(th && th.error === "RUNSCRIPT_FAILED: store down"), th && th.error);
    // unknown tool still unknown
    const unk = await tools.runTool("nope", {}, { tab: makeTab("tab-t12b", "g1"), activeGroupId: "g1", trajectory: [] });
    check("T12 unknown tool still unknown", !!(unk && unk.error && unk.error.startsWith("UNKNOWN_TOOL")), unk && unk.error);
  }

  // T13: engine loop drives record->runScript with approval on runScript
  {
    snap.clearTab("tab-t13");
    const tab = makeTab("tab-t13", "g1");
    const store = memStore();
    events = []; autoApprove = "approve";
    let dispatched = null;
    const automation = { runTrajectory: async (steps, opts) => { dispatched = { steps, opts }; return { status: "SUCCESS", executionId: "e-t13" }; } };
    engine.configure({ chat, sender, tabProvider: makeProvider({ "tab-t13": tab }, { tab: "tab-t13", group: "g1" }), store, automation, approvalTimeoutMs: 30000 });
    script = [toolMsg([["record", { step: "goto", url: "https://x" }]]), toolMsg([["runScript", { name: "t13" }]]), finalMsg("replayed")];
    const r = engine.start({ goal: "replay trajectory" });
    const done = await waitFor("agent:done", r.runId);
    check("T13 run completes", done.result === "replayed", done.result);
    check("T13 trajectory dispatched to runner", !!(dispatched && dispatched.steps.length === 1 && dispatched.steps[0].type === "goto"), JSON.stringify(dispatched && dispatched.steps));
    const runCall = events.find((e) => e.type === "agent:tool-call" && e.name === "runScript");
    const runAppr = events.find((e) => e.type === "agent:approval-needed" && e.toolCall.name === "runScript");
    check("T13 runScript needs approval (write tool)", !!(runCall && runAppr));
    const recCall = events.find((e) => e.type === "agent:tool-call" && e.name === "record");
    check("T13 record needs approval (write tool)", !!(recCall && events.some((e) => e.type === "agent:approval-needed" && e.toolCall.name === "record")));
    engine.configure({ automation: undefined });
  }

  try { server.close(); } catch (_) {}
  if (release) { try { release(); } catch (_) {} release = null; }
  console.log(`\nagent-engine: pass=${pass} fail=${fail} skip=${skipped}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("FAIL  harness threw: " + (e && e.stack || e));
  process.exit(1);
});

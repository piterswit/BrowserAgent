const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const folder = path.join(__dirname, "../WS Browser Bridge");
const source = name => fs.readFileSync(path.join(folder, name), "utf8");
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function timers() {
  let now = 20000, next = 0;
  const jobs = new Map();
  return {
    jobs, Date: {now: () => now},
    setTimeout(fn, delay) { const id = ++next; jobs.set(id, {fn, at: now + delay}); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const item = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        now = item[1].at; jobs.delete(item[0]); item[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}
function page(mode = "home") {
  const clock = timers(), listeners = new Map(), moves = [], messages = [];
  const window = {
    __fbActivityRequest: {mode, runId: "run-1"},
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    scrollBy(value) { moves.push(value.top); }
  };
  const document = {hidden: false, activeElement: null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null};
  const context = vm.createContext({...clock, window, document, location: {pathname: "/"},
    innerWidth: 1000, innerHeight: 700, URL, chrome: {runtime: {sendMessage: async msg => {
      if (msg.cmd !== "fb_bridge_activity_detail") messages.push(msg);
    }}}});
  vm.runInContext(source("activity_runtime.js"), context);
  vm.runInContext(source("activity_interactions.js"), context);
  const inject = () => vm.runInContext(source(mode === "reels" ? "auto_reels.js" : "tools.js"), context);
  return {clock, window, document, listeners, moves, messages, inject, context};
}
for (const mode of ["home", "group", "custom", "reels"]) {
  test(`${mode}: stop cancels pending waits and cannot restart scrolling`, async () => {
    const p = page(mode); p.inject();
    await p.clock.advance(22000);
    assert.ok(p.moves.length);
    p.window.__fbActivityRuntime.stop();
    const count = p.moves.length;
    await p.clock.advance(600000);
    p.inject();
    assert.equal(p.moves.length, count);
    assert.equal(p.clock.jobs.size, 0);
    assert.equal(p.listeners.size, 0);
    assert.equal(p.messages.length, 0);
  });
}
test("stop midway through smooth scrolling cancels every remaining step", async () => {
  const p = page(); p.inject();
  while (!p.moves.length) await p.clock.advance(100);
  assert.ok(p.moves.length < 20);
  p.window.__fbActivityRuntime.stop();
  const count = p.moves.length;
  await p.clock.advance(10000);
  assert.equal(p.moves.length, count);
  assert.equal(p.clock.jobs.size, 0);
});
test("duplicate injection does not create a second loop", async () => {
  const p = page(); p.inject(); const ctrl = p.window.__fbActivityCtrl;
  p.inject();
  assert.equal(p.window.__fbActivityCtrl, ctrl);
  assert.equal(p.clock.jobs.size, 2);
});
test("hidden pages, focused editors and recent user input suspend scrolling", async () => {
  const p = page(); p.inject(); p.document.hidden = true;
  await p.clock.advance(20000); assert.equal(p.moves.length, 0);
  p.document.hidden = false; p.document.activeElement = {matches: () => true, innerText: "User draft"};
  await p.clock.advance(20000); assert.equal(p.moves.length, 0);
  p.document.activeElement = null; p.listeners.get("wheel")({isTrusted: true});
  await p.clock.advance(9000); assert.equal(p.moves.length, 0);
  await p.clock.advance(20000); assert.ok(p.moves.length);
});
test("hidden and offscreen overlay nodes do not suspend every activity", async () => {
  const p = page();
  p.document.querySelectorAll = selector => selector.includes('role="dialog"') ? [
    {hidden: true},
    {getBoundingClientRect: () => ({width: 0, height: 0, top: 0, bottom: 0})},
    {getBoundingClientRect: () => ({width: 100, height: 100, top: -200, bottom: -100})}
  ] : [];
  p.inject(); await p.clock.advance(4000);
  assert.ok(p.moves.length);
});
test("a visible unrelated dialog pauses browsing and reports its reason", async () => {
  const p = page();
  p.document.querySelectorAll = selector => selector.includes('role="dialog"') ? [
    {getBoundingClientRect: () => ({width: 100, height: 100, top: 100, bottom: 200})}
  ] : [];
  p.inject(); await p.clock.advance(4000);
  assert.equal(p.moves.length, 0);
  assert.match(p.window.__fbActivityCtrl.detail, /可见弹窗/);
});
test("a stale runtime is upgraded rather than silently reusing its broken guards", async () => {
  const p = page(); let stopped = 0;
  p.window.__fbActivityRuntime = {stop() { stopped++; p.window.__fbActivityRequest = null; }};
  vm.runInContext(source("activity_runtime.js"), p.context); p.inject();
  await p.clock.advance(4000);
  assert.equal(stopped, 1); assert.ok(p.moves.length);
});
test("a missing interaction module stops with an error instead of leaving a fake running controller", async () => {
  const p = page(); p.window.__fbActivityInteractions = undefined; p.inject(); await flush();
  assert.equal(p.window.__fbActivityCtrl, null);
  assert.match(p.window.__fbActivityLastError, /滚动失败/);
  assert.ok(p.messages[0].error);
});
test("an empty autofocused input does not block browsing but still blocks interactions", async () => {
  const p = page(); p.document.activeElement = {matches: () => true, value: ""};
  p.inject(); await p.clock.advance(4000);
  assert.ok(p.moves.length);
  assert.equal(p.window.__fbActivityCtrl.canAct(null, null, true), false);
});
test("session expiry stops without reload and releases listeners and timers", async () => {
  const p = page(); p.inject(); await p.clock.advance(300001);
  assert.equal(p.clock.jobs.size, 0); assert.equal(p.listeners.size, 0);
  assert.equal(p.messages[0].runId, "run-1");
});
test("manual navigation ends the current browsing session", async () => {
  const p = page(); p.inject();
  vm.runInContext("location.pathname = '/friends/'", p.context);
  await p.clock.advance(20000);
  assert.equal(p.moves.length, 0);
  assert.equal(p.clock.jobs.size, 0);
  assert.equal(p.messages[0].runId, "run-1");
});
for (const mode of ["home", "group", "custom"]) {
  test(`${mode} always expires after five minutes`, async () => {
    const p = page(mode); p.inject(); await p.clock.advance(300001);
    assert.equal(p.window.__fbActivityCtrl, null);
    assert.equal(p.messages.length, 1);
    assert.equal(p.clock.jobs.size, 0);
  });
}
test("Reels continues beyond five minutes and across reel address changes", async () => {
  const p = page("reels"); p.context.location.pathname = "/reel/123"; p.inject();
  await p.clock.advance(300001); const count = p.moves.length;
  assert.equal(p.window.__fbActivityCtrl.run, true);
  p.context.location.pathname = "/reel/456";
  await p.clock.advance(40000);
  assert.ok(p.moves.length > count); assert.equal(p.messages.length, 0);
  p.context.location.pathname = "/friends/";
  await p.clock.advance(40000); assert.equal(p.window.__fbActivityCtrl, null);
});

function reelLayout({axis = "y", buttons = [], dialog = false, random = 0.5} = {}) {
  const p = page("reels"), movements = [];
  p.context.location.pathname = "/reel/123";
  p.context.Math = {random: () => random, floor: Math.floor, min: Math.min, max: Math.max};
  const root = {isConnected: true, clientWidth: 800, clientHeight: 600, scrollWidth: 2400, scrollHeight: 1800,
    getAttribute: name => name === "role" ? (dialog ? "dialog" : "main") : null,
    querySelectorAll: () => buttons, parentElement: null, contains: node => buttons.includes(node),
    scrollBy: value => movements.push(value)};
  const video = {isConnected: true, getAttribute: () => null, closest: () => root, parentElement: root,
    getBoundingClientRect: () => ({width: 400, height: 500, top: 50, bottom: 550, left: 200, right: 600})};
  p.document.querySelectorAll = selector => selector === "video" ? [video] :
    selector.includes('role="dialog"') && dialog ? [root] : [];
  p.document.querySelector = () => root;
  p.document.elementFromPoint = () => video;
  p.context.getComputedStyle = () => ({overflowX: axis === "x" ? "auto" : "hidden",
    overflowY: axis === "y" ? "auto" : "hidden", direction: "ltr"});
  return {...p, movements, video};
}
function reelButton(label, clicked) {
  return {isConnected: true, getAttribute: name => name === "aria-label" ? label : null,
    getBoundingClientRect: () => ({width: 40, height: 40, top: 300, bottom: 340, left: 800, right: 840}), click: clicked};
}
test("horizontal Reels scrolls left/right rather than the page vertically", async () => {
  const p = reelLayout({axis: "x"}); p.inject(); await p.clock.advance(22000);
  assert.ok(p.movements.length); assert.ok(p.movements.every(value => value.left > 0 && value.top === undefined));
  assert.equal(p.moves.length, 0);
});
test("vertical Reels keeps vertical scrolling", async () => {
  const p = reelLayout(); p.inject(); await p.clock.advance(22000);
  assert.ok(p.movements.length); assert.ok(p.movements.every(value => value.top > 0 && value.left === undefined));
});
test("horizontal Reels uses a full viewport and supports RTL layouts", async () => {
  const p = reelLayout({axis: "x"});
  p.context.getComputedStyle = () => ({overflowX: "auto", overflowY: "hidden", direction: "rtl"});
  p.inject(); await p.clock.advance(3000);
  assert.equal(p.movements.length, 1);
  assert.equal(p.movements[0].left, -800);
});
test("Reels prefers its visible next button and allows the player dialog", async () => {
  let clicks = 0;
  const p = reelLayout({buttons: [reelButton("Next reel", () => clicks++)], dialog: true});
  p.inject(); await p.clock.advance(3000);
  assert.equal(clicks, 1); assert.equal(p.movements.length, 0);
});
test("Reels can use its previous/left button without clicking both directions", async () => {
  const clicks = [];
  const p = reelLayout({random: 0, buttons: [reelButton("Previous reel", () => clicks.push("previous")),
    reelButton("Next reel", () => clicks.push("next"))]});
  p.inject(); await p.clock.advance(1800);
  assert.deepEqual(clicks, ["previous"]);
});
test("stop while waiting to click a Reels arrow prevents the click", async () => {
  let clicks = 0;
  const p = reelLayout({buttons: [reelButton("Next reel", () => clicks++)]});
  p.inject(); await p.clock.advance(1600);
  p.window.__fbActivityRuntime.stop(); await p.clock.advance(20000);
  assert.equal(clicks, 0); assert.equal(p.clock.jobs.size, 0);
});

for (const [next, previous] of [["Next reel", "Previous reel"], ["下一条视频", "上一条视频"], ["下一則短影片", "上一則短影片"], ["下一個影片", "上一個影片"]]) {
  test(`Reels localized arrows: ${next} / ${previous}`, async () => {
    const clicks = [];
    const p = reelLayout({random: 0, buttons: [reelButton(previous, () => clicks.push("previous")), reelButton(next, () => clicks.push("next"))]});
    p.inject(); await p.clock.advance(10000);
    assert.ok(clicks.includes("next"));
    assert.ok(clicks.includes("previous"));
  });
}
test("dense visible posts receive more reading time than an empty feed", async () => {
  async function progress(text) {
    const p = page();
    p.context.Math = {random: () => 0.5, floor: Math.floor, min: Math.min, max: Math.max};
    const article = {innerText: text, getBoundingClientRect: () => ({width: 400, height: 200, top: 100, bottom: 300})};
    p.document.querySelectorAll = selector => selector === '[role="article"]' ? [article] : [];
    p.inject(); await p.clock.advance(12000);
    return p.moves.length;
  }
  assert.ok(await progress("") > await progress("阅读内容".repeat(200)));
});
test("Reels caps duration-based pauses and keeps waits cancellable", async () => {
  const p = reelLayout({axis: "x"}); p.video.duration = 60; p.video.currentTime = 10;
  p.inject(); await p.clock.advance(8000);
  assert.equal(p.movements.length, 1);
  p.window.__fbActivityRuntime.stop(); await p.clock.advance(120000);
  assert.equal(p.movements.length, 1); assert.equal(p.clock.jobs.size, 0);
});
test("Reels without duration metadata still advances after a bounded reading pause", async () => {
  const p = reelLayout({axis: "x"}); p.inject(); await p.clock.advance(8000);
  assert.equal(p.movements.length, 2);
});

function background() {
  const clock = timers(), sockets = [], messages = [], updates = new Set(), removed = new Set();
  const runtimeMessages = [], alarms = [], windowRemoved = [], windowCreated = [];
  const data = {}, injected = [], tabs = [{id: 1, url: "https://www.facebook.com/", status: "complete"}];
  let normalWindows = [{id: 1}];
  let request = null;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    send(value) { messages.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const chrome = {
    storage: {session: {get: async () => ({...data}), set: async value => Object.assign(data, value)}},
    alarms: {create: async () => {}, clear: async () => {}, onAlarm: {addListener: fn => alarms.push(fn)}},
    windows: {getAll: async () => normalWindows,
      onRemoved: {addListener: fn => windowRemoved.push(fn)}, onCreated: {addListener: fn => windowCreated.push(fn)}},
    runtime: {onMessage: {addListener: fn => runtimeMessages.push(fn)}},
    tabs: {
      query: async () => tabs,
      get: async id => { const tab = tabs.find(t => t.id === id); if (!tab) throw Error("closed"); return tab; },
      update: async (id, options) => { Object.assign(tabs.find(t => t.id === id), options, {status: "loading"}); },
      reload: async () => {},
      onUpdated: {addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn)},
      onRemoved: {addListener: fn => removed.add(fn), removeListener: fn => removed.delete(fn)}
    },
    scripting: {executeScript: async options => {
      injected.push(options);
      if (options.args?.[1]?.runId) request = options.args[1];
      return [{result: options.func?.name === "readActivityState" ? {running: true, runId: request?.runId} : false}];
    }}
  };
  let nextId = 0;
  const context = vm.createContext({...clock, chrome, WebSocket: Socket, crypto: {randomUUID: () => "run-" + ++nextId}, URL,
    setInterval() {}, console});
  vm.runInContext(source("bg.js"), context);
  return {clock, sockets, context, chrome, messages, injected, data, tabs, updates, removed, runtimeMessages, alarms,
    closeWindows: async () => { normalWindows = []; await windowRemoved[0](); },
    openWindow: () => { normalWindows = [{id: 1}]; windowCreated[0](); }};
}
test("failed connections retry with backoff and never create overlapping sockets", async () => {
  const b = background(); await flush();
  assert.equal(b.sockets.length, 1);
  for (let i = 0; i < 5; i++) {
    const socket = b.sockets.at(-1); socket.onerror();
    vm.runInContext("connect()", b.context);
    assert.equal(b.sockets.length, i + 1);
    if (i < 4) await b.clock.advance(750);
  }
  await b.clock.advance(4999); assert.equal(b.sockets.length, 5);
  await b.clock.advance(1); assert.equal(b.sockets.length, 6);
  assert.equal(b.clock.jobs.size, 1);
});
test("established disconnect reconnects and closing all windows disables retries", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  const socket = b.sockets[0]; socket.readyState = 1; socket.onopen();
  socket.close(); await flush();
  await b.clock.advance(5000); assert.equal(b.sockets.length, 2);
  await b.closeWindows(); await b.clock.advance(120000);
  assert.equal(b.sockets.length, 2); assert.equal(b.clock.jobs.size, 0);
  b.openWindow(); assert.equal(b.sockets.length, 3);
});
test("stop suppresses URL autostart and acknowledges only after all pages stop", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.sockets[0].readyState = 1; b.sockets[0].onopen();
  let release;
  b.chrome.scripting.executeScript = () => new Promise(resolve => { release = resolve; });
  const stopping = vm.runInContext("stopActivity()", b.context); await flush();
  assert.equal(b.messages.length, 0);
  release([{result: false}]); await stopping;
  assert.equal(b.messages.at(-1).status, "stop");
  const count = b.injected.length;
  await vm.runInContext("startActivity('home', 1, true)", b.context);
  assert.equal(b.injected.length, count);
  assert.equal(b.data.activitySuppressed, true);
});
test("stop cancels a pending navigation before its late completion can inject scripts", async () => {
  const b = background(); await flush();
  const baseline = b.removed.size;
  const starting = vm.runInContext("startActivity('group')", b.context).catch(error => error);
  await flush(); assert.equal(b.removed.size, baseline + 1);
  await vm.runInContext("stopActivity()", b.context);
  assert.match((await starting).message, /取消/);
  assert.equal(b.removed.size, baseline);
  for (const listener of b.updates) listener(1, {status: "complete"}, b.tabs[0]);
  await flush(); assert.equal(b.injected.filter(item => item.files).length, 0);
});
test("an old session completion cannot overwrite a newer session status", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.sockets[0].readyState = 1; b.sockets[0].onopen();
  await vm.runInContext("startActivity('home')", b.context);
  b.runtimeMessages[0]({cmd: "fb_bridge_active_stopped", runId: "old"}, {tab: {id: 1}});
  assert.equal(b.messages.at(-1).status, "auto_main_page");
});
test("stop covers inactive Facebook pages and skips unrelated sites", async () => {
  const b = background(); await flush();
  b.tabs.push({id: 2, url: "https://www.facebook.com/groups/feed/"},
    {id: 3, url: "https://facebook.com.example.org/"});
  await vm.runInContext("stopActivity()", b.context);
  assert.deepEqual(b.injected.map(item => item.target.tabId), [1, 2]);
});
test("a failed stop does not report idle", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.sockets[0].readyState = 1; b.sockets[0].onopen();
  b.chrome.scripting.executeScript = async () => { throw Error("permission denied"); };
  await vm.runInContext("handleAction({action: 'stop_scroll'}).catch(reportError)", b.context);
  assert.equal(b.messages.at(-1).status, "activity_error");
  assert.match(b.messages.at(-1).error, /permission denied/);
});
test("late initialization cannot reactivate a page after a newer stop", async () => {
  const b = background(); await flush();
  await vm.runInContext("startActivity('home')", b.context);
  const seed = b.injected.find(item => item.args?.[1]?.runId);
  await vm.runInContext("stopActivity()", b.context);
  const stop = b.injected.at(-1);
  const p = page();
  p.window.__fbActivityRequest = null;
  p.context.args = stop.args;
  vm.runInContext(`(${stop.func.toString()})(...args)`, p.context);
  p.context.args = seed.args;
  vm.runInContext(`(${seed.func.toString()})(...args)`, p.context);
  p.inject();
  assert.equal(p.window.__fbActivityCtrl, undefined);
  assert.equal(p.clock.jobs.size, 0);
});
test("custom activity stays on the chosen Facebook page", async () => {
  const b = background(); await flush(); b.tabs[0].url = "https://www.facebook.com/groups/test/";
  let navigations = 0; b.chrome.tabs.update = async () => { navigations++; };
  await vm.runInContext("startActivity('custom')", b.context);
  assert.equal(navigations, 0);
  assert.equal(b.injected.find(item => item.args?.[1]?.mode).args[1].mode, "custom");
});
test("failed bootstrap is not reported as active just because file injection completed", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.sockets[0].readyState = 1; b.sockets[0].onopen();
  b.chrome.scripting.executeScript = async options => {
    b.injected.push(options);
    return [{result: options.func?.name === "readActivityState" ? {running: false, detail: "test bootstrap failure"} : false}];
  };
  await vm.runInContext("handleAction({action:'scroll30'}).catch(reportError)", b.context);
  assert.equal(b.messages.at(-1).status, "activity_error");
  assert.match(b.messages.at(-1).error, /bootstrap failure/);
});
for (const stopBeforeComplete of [false, true]) {
  test(`Reels navigation ${stopBeforeComplete ? "cannot resume after stop" : "resumes after loading the next reel"}`, async () => {
    const b = background(); await flush(); b.tabs[0].url = "https://www.facebook.com/reel/123";
    await vm.runInContext("startActivity('reels')", b.context);
    const count = b.injected.filter(item => item.files).length;
    b.tabs[0].url = "https://www.facebook.com/reel/456";
    for (const listener of b.updates) listener(1, {status: "loading"}, b.tabs[0]);
    if (stopBeforeComplete) await vm.runInContext("stopActivity()", b.context);
    for (const listener of b.updates) listener(1, {status: "complete"}, b.tabs[0]);
    await flush();
    assert.equal(b.injected.filter(item => item.files).length, count + (stopBeforeComplete ? 0 : 1));
  });
}

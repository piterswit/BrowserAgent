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
      if (!["fb_bridge_activity_detail", "fb_bridge_activity_stats"].includes(msg.cmd)) messages.push(msg);
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
  const p = page("group"); p.inject(); p.document.hidden = true;
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

function popupFixture(p, {label = "Close", text = "Optional notice", fields = [], stays = false, role = "dialog"} = {}) {
  let clicks = 0;
  const popup = {
    isConnected: true, innerText: text,
    getAttribute: name => name === "role" ? role : null,
    getBoundingClientRect: () => ({width: 300, height: 150, top: 100, bottom: 250}),
    contains: node => fields.includes(node),
    querySelectorAll: selector => selector.includes("input") ? fields : selector.includes('role="button"') && label ? [close] : []
  };
  const close = {
    isConnected: true, innerText: label, getAttribute: () => null,
    getBoundingClientRect: () => ({width: 30, height: 30, top: 100, bottom: 130}),
    closest: () => popup,
    click() { clicks++; if (!stays) popup.isConnected = false; }
  };
  p.document.querySelectorAll = selector => selector.includes('role="dialog"') ? [popup] : [];
  return {popup, close, clicks: () => clicks};
}

for (const mode of ["home", "group", "custom", "reels"]) {
  for (const label of ["Close", "关闭", "關閉", "Not now", "取消"]) {
    test(`${mode}: ${label} dismisses a generic popup and continues browsing`, async () => {
      const p = page(mode), fixture = popupFixture(p, {label});
      p.inject(); await p.clock.advance(10000);
      assert.equal(fixture.clicks(), 1);
      assert.ok(p.moves.length);
      assert.notEqual(p.window.__fbActivityCtrl.state, "暂停");
      p.window.__fbActivityRuntime.stop();
    });
  }
}

test("failed popup close retries are bounded and do not click every scroll frame", async () => {
  const p = page(), fixture = popupFixture(p, {stays: true}); p.inject();
  const ctrl = p.window.__fbActivityCtrl;
  for (let i = 0; i < 20; i++) ctrl.canAct();
  assert.equal(fixture.clicks(), 1);
  assert.equal(ctrl.state, "运行中");
  await p.clock.advance(60000);
  assert.equal(fixture.clicks(), 3);
  assert.match(ctrl.detail, /自动关闭失败/);
  assert.equal(p.moves.length, 0);
  ctrl.stop();
});

test("Escape can dismiss an unlabeled generic popup without selecting its actions", () => {
  const p = page(), fixture = popupFixture(p, {label: null});
  p.context.KeyboardEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const keys = [];
  fixture.popup.dispatchEvent = event => { keys.push(event.key); fixture.popup.isConnected = false; };
  p.inject();
  assert.deepEqual(keys, ["Escape", "Escape"]);
  assert.equal(fixture.clicks(), 0);
  assert.equal(p.window.__fbActivityCtrl.canAct(), true);
  p.window.__fbActivityRuntime.stop();
});

for (const config of [{text: "Confirm your identity"}, {text: "登录验证"}, {fields: [{type: "password", value: ""}]},
  {fields: [{value: "My unfinished comment"}]}, {fields: [{type: "file", files: [{}]}]}]) {
  test(`protected popup ${JSON.stringify(config)} is not dismissed`, () => {
    const p = page(), fixture = popupFixture(p, config); p.inject();
    assert.equal(fixture.clicks(), 0);
    assert.equal(p.window.__fbActivityCtrl.canAct(), false);
    assert.match(p.window.__fbActivityCtrl.detail, /人工处理/);
    p.window.__fbActivityRuntime.stop();
  });
}

test("an active interaction scope is not closed by generic recovery", () => {
  const p = page(); p.inject();
  const fixture = popupFixture(p);
  assert.equal(p.window.__fbActivityCtrl.canAct(fixture.popup), true);
  assert.equal(fixture.clicks(), 0);
  p.window.__fbActivityRuntime.stop();
});

test("recent user input, hidden tabs and Stop prevent automatic popup dismissal", () => {
  const p = page("group"); p.inject(); const fixture = popupFixture(p), ctrl = p.window.__fbActivityCtrl;
  p.document.hidden = true; assert.equal(ctrl.canAct(), false);
  p.document.hidden = false; ctrl.lastInput = 20000; assert.equal(ctrl.canAct(), false);
  ctrl.lastInput = 0; ctrl.stop(); assert.equal(ctrl.canAct(), false);
  assert.equal(fixture.clicks(), 0);
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
for (const mode of ["home", "group", "custom", "reels"]) {
  test(`${mode}: empty autofocus only blocks interactions outside unattended home`, async () => {
    const p = page(mode); p.document.activeElement = {matches: () => true, value: "", isContentEditable: false};
    p.inject(); await p.clock.advance(4000);
    assert.ok(p.moves.length);
    assert.equal(p.window.__fbActivityCtrl.canAct(null, null, true), mode === "home");
    p.window.__fbActivityRuntime.stop();
  });
}

test("home waits while hidden, then resumes unfocused without a recent-input delay", async () => {
  const p = page(); p.document.hidden = true; p.document.hasFocus = () => false;
  p.document.activeElement = {matches: () => true, innerText: "", isContentEditable: true};
  p.inject(); const ctrl = p.window.__fbActivityCtrl;
  ctrl.lastInput = 20000;
  assert.equal(p.listeners.size, 0);
  assert.equal(ctrl.canAct(null, null, true), false);
  assert.equal(ctrl.state, "等待中"); assert.equal(ctrl.run, true);
  await p.clock.advance(20000); assert.equal(p.moves.length, 0);
  p.document.hidden = false;
  assert.equal(ctrl.canAct(null, null, true), true);
  await p.clock.advance(10000); assert.ok(p.moves.length);
  const count = p.moves.length; ctrl.stop(); await p.clock.advance(20000);
  assert.equal(p.moves.length, count); assert.equal(p.clock.jobs.size, 0);
});

test("home defers popup closing until visible and still preserves existing input drafts", () => {
  const p = page(); p.inject(); const ctrl = p.window.__fbActivityCtrl;
  p.document.hidden = true; ctrl.lastInput = 20000;
  const fixture = popupFixture(p);
  assert.equal(ctrl.canAct(), false); assert.equal(fixture.clicks(), 0);
  assert.equal(ctrl.state, "等待中");
  p.document.hidden = false;
  assert.equal(ctrl.canAct(), true); assert.equal(fixture.clicks(), 1);
  p.document.activeElement = {matches: () => true, value: "Existing draft"};
  assert.equal(ctrl.canAct(), false); assert.match(ctrl.detail, /未提交/);
  ctrl.stop();
});

test("Stop while waiting prevents resumption when the page becomes visible", async () => {
  const p = page(); p.document.hidden = true; p.inject();
  await p.clock.advance(10000); assert.equal(p.moves.length, 0);
  p.window.__fbActivityRuntime.stop(); p.document.hidden = false;
  await p.clock.advance(30000);
  assert.equal(p.moves.length, 0); assert.equal(p.clock.jobs.size, 0);
});

test("a hidden task still expires after five minutes without restarting on visibility", async () => {
  const p = page(); p.document.hidden = true; p.inject();
  await p.clock.advance(300001);
  assert.equal(p.window.__fbActivityCtrl, null); assert.equal(p.messages.length, 1);
  p.document.hidden = false; await p.clock.advance(30000);
  assert.equal(p.moves.length, 0); assert.equal(p.clock.jobs.size, 0);
});

test("navigation is validated before the maintenance phase can close a popup", async () => {
  const p = page(); p.inject(); const fixture = popupFixture(p);
  p.context.location.pathname = "/different-page/";
  await p.clock.advance(4000);
  assert.equal(fixture.clicks(), 0); assert.equal(p.moves.length, 0);
  assert.equal(p.window.__fbActivityCtrl, null); assert.equal(p.messages.length, 1);
});

test("page loading defers maintenance and scrolling until the document is ready", async () => {
  const p = page(); p.document.readyState = "loading"; p.inject();
  const fixture = popupFixture(p);
  await p.clock.advance(10000);
  assert.equal(fixture.clicks(), 0); assert.equal(p.moves.length, 0);
  assert.equal(p.window.__fbActivityCtrl.state, "等待中");
  p.document.readyState = "complete"; await p.clock.advance(10000);
  assert.equal(fixture.clicks(), 1); assert.ok(p.moves.length);
  p.window.__fbActivityRuntime.stop();
});

test("a replaced scroll container is abandoned before the next frame", async () => {
  const p = page(), ctrl = p.window.__fbActivityRuntime.create("home");
  const moves = [], target = {isConnected: true, scrollTop: 0,
    scrollBy(value) { moves.push(value.top); this.scrollTop += value.top; }};
  const first = ctrl.scroll(target, 100, "y", 4);
  target.isConnected = false; await p.clock.advance(1000); await first;
  assert.equal(moves.length, 1); assert.equal(ctrl.state, "等待中");
  assert.match(ctrl.detail, /重新定位/);
  ctrl.stop(); assert.equal(p.clock.jobs.size, 0);
});
test("session expiry stops without reload and releases listeners and timers", async () => {
  const p = page(); p.inject(); await p.clock.advance(300001);
  assert.equal(p.clock.jobs.size, 0); assert.equal(p.listeners.size, 0);
  assert.equal(p.messages[0].runId, "run-1");
});

for (const method of ["guard", "canAct"]) {
  test(`home ${method} checks elapsed wall time even before a delayed expiry timer fires`, () => {
    const p = page(); p.inject(); const ctrl = p.window.__fbActivityCtrl;
    p.clock.Date.now = () => 320001;
    if (method === "guard") assert.throws(() => ctrl.guard(), {name: "AbortError"});
    else assert.equal(ctrl.canAct(), false);
    assert.equal(ctrl.run, false);
    assert.equal(p.messages.length, 1);
    assert.equal(p.clock.jobs.size, 0);
  });
}
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
    storage: {local: {setAccessLevel: async () => {}, get: async () => ({}), set: async () => {}},
      session: {get: async () => ({...data}), set: async value => Object.assign(data, value)}},
    alarms: {create: async () => {}, clear: async () => {}, onAlarm: {addListener: fn => alarms.push(fn)}},
    windows: {getAll: async () => normalWindows,
      onRemoved: {addListener: fn => windowRemoved.push(fn)}, onCreated: {addListener: fn => windowCreated.push(fn)}},
    runtime: {id: "test-extension", getURL: file => `chrome-extension://test-extension/${file}`,
      onMessage: {addListener: fn => runtimeMessages.push((msg, sender, respond) => fn(msg,
        {id: "test-extension", frameId: 0, url: sender.tab ? "https://www.facebook.com/" : "chrome-extension://test-extension/popup.html", ...sender}, respond))}},
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
  vm.runInContext("secureSend = (message, socket) => socket.send(JSON.stringify(message))", context);
  return {clock, sockets, context, chrome, messages, injected, data, tabs, updates, removed, runtimeMessages, alarms,
    openConnection(socket = sockets[0]) {
      socket.readyState = 1; socket.onopen();
      context.testSocket = socket;
      vm.runInContext("authenticatedSockets.add(testSocket); clearTimeout(connectTimer); connectTimer = null; initializeAccount(testSocket)", context);
    },
    closeWindows: async () => { normalWindows = []; await windowRemoved[0](); },
    openWindow: () => { normalWindows = [{id: 1}]; windowCreated[0](); }};
}

for (const flag of ["avatarBusy", "avatarStarting"]) {
  for (const action of ["scroll30", "auto_group", "auto_custom", "auto_reels", "cancel_friend_requests", "change_avatar"]) {
    test(`${flag}: rejects ${action} without changing the active task epoch`, async () => {
      const b = background(); await flush();
      vm.runInContext(`${flag} = true`, b.context);
      const epoch = vm.runInContext("activityEpoch", b.context), injections = b.injected.length;
      await assert.rejects(vm.runInContext(`handleAction({action: '${action}'})`, b.context), {name: "TaskBusyError"});
      assert.equal(vm.runInContext("activityEpoch", b.context), epoch);
      assert.equal(b.injected.length, injections);
    });
  }
}

test("the avatar reservation blocks starts before asynchronous stop finishes and releases on failure", async () => {
  const b = background(); await flush();
  let rejectStop;
  b.context.waitingStop = new Promise((_resolve, reject) => { rejectStop = reject; });
  vm.runInContext("stopActivity = () => waitingStop", b.context);
  const changing = vm.runInContext("handleAction({action:'change_avatar'})", b.context).catch(error => error);
  assert.equal(vm.runInContext("avatarStarting", b.context), true);
  await assert.rejects(vm.runInContext("startActivity('home')", b.context), {name: "TaskBusyError"});
  rejectStop(new Error("stop failed")); assert.equal((await changing).message, "stop failed");
  assert.equal(vm.runInContext("avatarStarting", b.context), false);
});

test("busy rejection reports detail without replacing the avatar state with an error", async () => {
  const b = background(); await flush(); vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
  vm.runInContext("avatarBusy = true", b.context);
  await vm.runInContext("handleAction({action:'auto_group'}).catch(reportError)", b.context);
  assert.equal(b.messages.at(-1).type, "activity_detail");
  assert.match(b.messages.at(-1).detail, /换头像/);
  await vm.runInContext("stopActivity()", b.context);
  assert.equal(b.messages.filter(message => message.status === "stop").length, 0);
});

test("stopTabs cancels a standalone friend-request task before stopping the activity runtime", async () => {
  const b = background(); await flush(); let cancelled = 0, stopped = 0;
  const window = {__fbCancelRequestsCtrl: {stop() { cancelled++; }},
    __fbActivityRuntime: {stop() { stopped++; }} };
  b.chrome.scripting.executeScript = async options => [{result:
    vm.runInNewContext(`(${options.func.toString()})(123)`, {window})}];
  await vm.runInContext("stopTabs(activityEpoch)", b.context);
  assert.equal(cancelled, 1); assert.equal(stopped, 1);
});

test("a cancelled friend-request script cannot overwrite a subsequently started task", async () => {
  const b = background(); await flush(); vm.runInContext("initializeAccount = async () => {}; navigateActivity = async () => {}", b.context);
  b.openConnection();
  const execute = b.chrome.scripting.executeScript;
  let release;
  b.chrome.scripting.executeScript = options => options.files?.includes("cancel_friend_requests.js") ?
    new Promise(resolve => { release = resolve; }) : execute(options);
  const cancelling = vm.runInContext("handleAction({action:'cancel_friend_requests'})", b.context);
  await flush(); assert.equal(b.messages.at(-1).status, "cancel_friend_requests");
  await vm.runInContext("startActivity('home')", b.context);
  release([]); await cancelling;
  assert.equal(b.messages.at(-1).status, "auto_main_page");
});

test("a late injection failure cannot replace a newer task's status", async () => {
  const b = background(); await flush(); vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
  const execute = b.chrome.scripting.executeScript;
  let rejectOld;
  b.chrome.scripting.executeScript = options => options.files?.includes("tools.js") && !rejectOld ?
    new Promise((_resolve, reject) => { rejectOld = reject; }) : execute(options);
  const old = vm.runInContext("startActivity('home').catch(reportError)", b.context);
  await flush();
  await vm.runInContext("startActivity('custom')", b.context);
  rejectOld(new Error("old page closed")); await old;
  assert.equal(b.messages.at(-1).status, "auto_custom");
  assert.equal(vm.runInContext("activeRun.mode", b.context), "custom");
});
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

test("the connect URL retries immediately during backoff without starting activity", async () => {
  const b = background(); await flush();
  b.sockets[0].onerror();
  assert.equal(b.sockets.length, 1);
  const tab = {...b.tabs[0], url: "https://www.facebook.com/?fb_bridge_connect_extension"};
  for (const listener of b.updates) listener(tab.id, {status: "complete"}, tab);
  await flush();
  assert.equal(b.sockets.length, 2);
  assert.equal(b.sockets[1].url, "ws://127.0.0.1:8765");
  assert.equal(vm.runInContext("activeRun", b.context), null);
  assert.equal(b.injected.length, 0);
  // A second completion or the obsolete retry must not create another socket.
  for (const listener of b.updates) listener(tab.id, {status: "complete"}, tab);
  await b.clock.advance(750);
  assert.equal(b.sockets.length, 2);
});

test("the connect URL refreshes identity on an open socket but not during an avatar task", async () => {
  const b = background(); await flush();
  b.context.identityRefreshes = 0;
  vm.runInContext("initializeAccount = async () => { identityRefreshes++; }", b.context);
  b.openConnection(); await flush();
  const tab = {...b.tabs[0], url: "https://www.facebook.com/?fb_bridge_connect_extension=1"};
  const open = async () => {
    for (const listener of b.updates) listener(tab.id, {status: "complete"}, tab);
    await flush();
  };
  await open();
  assert.equal(b.context.identityRefreshes, 2);
  for (const flag of ["avatarBusy", "avatarStarting"]) {
    vm.runInContext(`${flag} = true`, b.context); await open();
    assert.equal(b.context.identityRefreshes, 2);
    vm.runInContext(`${flag} = false`, b.context);
  }
  assert.equal(b.sockets.length, 1);
});

test("ordinary Facebook pages do not bypass connection retry backoff", async () => {
  const b = background(); await flush(); b.sockets[0].onerror();
  for (const listener of b.updates) listener(1, {status: "complete"}, b.tabs[0]);
  await flush(); assert.equal(b.sockets.length, 1);
});

test("the Connect popup command also retries immediately during backoff", async () => {
  const b = background(); await flush(); b.sockets[0].onerror();
  b.runtimeMessages[0]({cmd: "connect_py"}, {}, () => {}); await flush();
  assert.equal(b.sockets.length, 2);
});
test("established disconnect reconnects and closing all windows disables retries", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  const socket = b.sockets[0]; b.openConnection(socket);
  socket.close(); await flush();
  await b.clock.advance(5000); assert.equal(b.sockets.length, 2);
  await b.closeWindows(); await b.clock.advance(120000);
  assert.equal(b.sockets.length, 2); assert.equal(b.clock.jobs.size, 0);
  b.openWindow(); assert.equal(b.sockets.length, 3);
});
test("stop suppresses URL autostart and acknowledges only after all pages stop", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
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
  b.openConnection();
  await vm.runInContext("startActivity('home')", b.context);
  b.runtimeMessages[0]({cmd: "fb_bridge_active_stopped", runId: "old"}, {tab: {id: 1}});
  assert.equal(b.messages.at(-1).status, "auto_main_page");
});

test("natural completion forwards final stats only from the active task tab", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
  await vm.runInContext("startActivity('home')", b.context);
  const run = vm.runInContext("activeRun", b.context);
  const stats = {attempted: {like: 2, comment: 1, share: 1}, confirmed: {like: 1, comment: 1, share: 0}};
  b.runtimeMessages[0]({cmd: "fb_bridge_active_stopped", runId: run.runId, stats}, {tab: {id: 999}});
  assert.equal(b.messages.at(-1).status, "auto_main_page");
  b.runtimeMessages[0]({cmd: "fb_bridge_active_stopped", runId: run.runId, stats}, {tab: {id: 1}});
  assert.equal(b.messages.at(-1).status, "stop");
  assert.deepEqual(b.messages.at(-1).stats, stats);
});

test("per-action diagnostics are sanitized and retained by the background", async () => {
  const b = background(); await flush();
  b.context.inputStats = {issues: {comment: "x".repeat(250), share: "No story entry", unknown: "Ignored"}};
  const result = JSON.parse(vm.runInContext("JSON.stringify(normalizeActivityStats(inputStats))", b.context));
  assert.deepEqual(result.issues, {comment: "x".repeat(160), share: "No story entry"});
});

test("manual stop uses final page snapshot and never reloads a modern controller", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
  await vm.runInContext("startActivity('home')", b.context);
  const run = vm.runInContext("activeRun", b.context);
  const stats = {attempted: {like: 2, comment: 0, share: 0}, confirmed: {like: 2, comment: 0, share: 0}};
  b.chrome.tabs.reload = () => { throw Error("must not reload snapshot result"); };
  b.chrome.scripting.executeScript = async () => [{result: {runId: run.runId, stats}}];
  await vm.runInContext("stopActivity()", b.context);
  assert.deepEqual(b.messages.at(-1).stats, stats);
});

test("Reels reinjection carries session totals and checkpoints reject other tabs", async () => {
  const b = background(); await flush();
  vm.runInContext("initializeAccount = async () => {}", b.context);
  b.openConnection();
  b.tabs[0].url = "https://www.facebook.com/reel/123";
  await vm.runInContext("startActivity('reels')", b.context);
  const run = vm.runInContext("activeRun", b.context);
  const stats = {attempted: {like: 1, comment: 0, share: 0}, confirmed: {like: 1, comment: 0, share: 0}};
  b.runtimeMessages[0]({cmd: "fb_bridge_activity_stats", runId: run.runId, stats}, {tab: {id: 999}});
  assert.equal(run.stats.attempted.like, 0);
  b.runtimeMessages[0]({cmd: "fb_bridge_activity_stats", runId: run.runId, stats}, {tab: {id: 1}});
  await vm.runInContext("injectActivity(activeRun.tabId, activeRun.mode, activeRun.runId, activeRun.epoch)", b.context);
  const request = b.injected.filter(item => item.args?.[1]?.runId).at(-1).args[1];
  assert.equal(request.stats.confirmed.like, 1);
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
  b.openConnection();
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
  b.openConnection();
  b.chrome.scripting.executeScript = async options => {
    b.injected.push(options);
    return [{result: options.func?.name === "readActivityState" ? {running: false, detail: "test bootstrap failure"} : false}];
  };
  await vm.runInContext("handleAction({action:'scroll30'}).catch(reportError)", b.context);
  assert.equal(b.messages.at(-1).status, "activity_error");
  assert.match(b.messages.at(-1).error, /bootstrap failure/);
});
for (const scenario of ["same-document", "full-reload", "unrelated-navigation"]) {
  test(`home comment loading event: ${scenario}`, async () => {
    const b = background(); await flush();
    await vm.runInContext("startActivity('home')", b.context);
    const run = vm.runInContext("activeRun", b.context), injections = b.injected.filter(item => item.files).length;
    const execute = b.chrome.scripting.executeScript;
    let loading = true;
    b.chrome.scripting.executeScript = async options => options.func?.name === "readCommentNavigation" ?
      [{result: {running: loading || scenario !== "full-reload", allowed: scenario !== "unrelated-navigation"}}] : execute(options);
    b.tabs[0].url = "https://www.facebook.com/alice/posts/123";
    for (const listener of b.updates) await listener(1, {status: "loading"}, b.tabs[0]);
    loading = false;
    for (const listener of b.updates) await listener(1, {status: "complete"}, b.tabs[0]);
    await flush();
    assert.equal(vm.runInContext("activeRun", b.context), scenario === "same-document" ? run : null);
    assert.equal(b.injected.filter(item => item.files).length, injections);
  });
}

test("Stop during a comment-navigation check cannot revive the old home task", async () => {
  const b = background(); await flush(); await vm.runInContext("startActivity('home')", b.context);
  const execute = b.chrome.scripting.executeScript; let resolveCheck;
  b.chrome.scripting.executeScript = options => options.func?.name === "readCommentNavigation" ?
    new Promise(resolve => { resolveCheck = resolve; }) : execute(options);
  const updating = [...b.updates][0](1, {status: "loading"}, b.tabs[0]);
  await vm.runInContext("stopActivity()", b.context);
  resolveCheck([{result: {running: true, allowed: true}}]); await updating;
  assert.equal(vm.runInContext("activeRun", b.context), null);
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

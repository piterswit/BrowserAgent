const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/cancel_friend_requests.js"), "utf8");

async function run({sent, cancel, blocked = "", ariaOnly = false, hiddenWarning = false, stopAfterEntry = false}) {
  const clicks = [], alerts = [];
  let open = false, connected = true;
  const element = text => ({
    innerText: ariaOnly ? "" : text, style: {},
    getAttribute: name => name === "aria-label" ? text : null,
    getBoundingClientRect: () => ({width: 100, height: 40, top: 20, bottom: 60}),
    remove() {}, querySelectorAll: () => []
  });
  const cancelButton = {...element(cancel), click() { clicks.push(cancel); connected = false; }};
  const unrelated = {...element("Cancel"), click() { throw Error("must not click unrelated Cancel"); }};
  const dialog = {...element(""), scrollHeight: 100, clientHeight: 100,
    querySelectorAll: () => connected ? [cancelButton, unrelated] : [unrelated]};
  const warning = element(blocked);
  if (hiddenWarning) warning.getBoundingClientRect = () => ({width: 0, height: 0});
  const entry = {...element(sent), click() { clicks.push(sent); open = true;
    if (stopAfterEntry) context.window.__fbCancelRequestsCtrl.stop(); }};
  const body = {appendChild() {}, contains: node => node === cancelButton && connected};
  const context = vm.createContext({
    location: {pathname: "/friends/requests"},
    window: {innerHeight: 700, getComputedStyle: () => ({overflowY: "visible"})},
    document: {body, createElement: () => element(""), querySelectorAll: selector => {
      if (selector === '[role="dialog"]') return open ? [dialog] : [];
      if (selector.includes('[role="alert"]')) return [...(open ? [dialog] : []), ...(blocked ? [warning] : [])];
      return [entry];
    }},
    setTimeout: callback => { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    console: {log() {}, warn() {}, error() {}}, alert: text => alerts.push(text)
  });
  await vm.runInContext(source, context);
  return {clicks, alerts};
}

for (const labels of [
  {sent: "View sent requests", cancel: "Cancel request", blocked: "We couldn't process your request. Please try again later."},
  {sent: "查看已发送的请求", cancel: "取消请求", blocked: "无法处理你的请求，请稍后再试"},
  {sent: "查看已傳送邀請", cancel: "取消邀請", blocked: "無法處理你的邀請，請再試一次"},
  {sent: "查看已發送的交友邀請", cancel: "取消交友邀請", blocked: "你暫時遭到封鎖"}
]) {
  test(`${labels.sent}: opens sent requests and cancels only the correct button`, async () => {
    const p = await run({...labels, blocked: ""});
    assert.deepEqual(p.clicks, [labels.sent, labels.cancel]);
  });
  test(`${labels.sent}: aria-only buttons are supported`, async () => {
    const p = await run({...labels, blocked: "", ariaOnly: true});
    assert.deepEqual(p.clicks, [labels.sent, labels.cancel]);
  });
  test(`${labels.sent}: visible localized restriction prevents cancellation`, async () => {
    const p = await run(labels);
    assert.deepEqual(p.clicks, [labels.sent]);
  });
}
test("hidden restriction text does not prevent cancellation", async () => {
  const p = await run({sent: "Sent requests", cancel: "Cancel request", blocked: "Please try again later", hiddenWarning: true});
  assert.deepEqual(p.clicks, ["Sent requests", "Cancel request"]);
});

test("Stop after opening sent requests prevents every cancellation click", async () => {
  const p = await run({sent: "View sent requests", cancel: "Cancel request", stopAfterEntry: true});
  assert.deepEqual(p.clicks, ["View sent requests"]);
  assert.equal(p.alerts.length, 0);
});

test("reinjection cancels the old request task and Stop clears both pending runs", async () => {
  let next = 0;
  const jobs = new Map();
  const context = vm.createContext({window: {}, location: {pathname: "/friends/requests"},
    setTimeout: callback => { const id = ++next; jobs.set(id, callback); return id; },
    clearTimeout: id => jobs.delete(id), console});
  const first = vm.runInContext(source, context), old = context.window.__fbCancelRequestsCtrl;
  const second = vm.runInContext(source, context), current = context.window.__fbCancelRequestsCtrl;
  assert.notEqual(current, old); assert.equal(old.run, false); assert.equal(jobs.size, 1);
  current.stop(); await Promise.all([first, second]);
  assert.equal(current.run, false); assert.equal(jobs.size, 0);
  assert.equal(context.window.__fbCancelRequestsCtrl, null);
});

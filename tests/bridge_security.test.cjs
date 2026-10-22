const assert = require("node:assert/strict");
const {test} = require("node:test");
const {webcrypto} = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
async function fixture() {
  const sockets = [], sent = [], opened = [], listeners = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; readyState = 0;
    constructor() { sockets.push(this); }
    send(message) { sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const event = {addListener() {}};
  const chrome = {
    storage: {session: {get: async () => ({}), set: async () => {}}},
    runtime: {id: "a".repeat(32), getURL: file => `chrome-extension://${"a".repeat(32)}/${file}`,
      onMessage: {addListener: fn => listeners.push(fn)}},
    tabs: {query: async () => [], create: async value => opened.push(value), onUpdated: event, onRemoved: event},
    windows: {getAll: async () => [{id: 1}], onRemoved: event, onCreated: event},
    alarms: {clear: async () => {}, create: async () => {}, onAlarm: event}
  };
  const context = vm.createContext({chrome, WebSocket: Socket, crypto: webcrypto, URL, TextEncoder,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {}, console});
  vm.runInContext(source, context);
  context.identityReads = 0;
  vm.runInContext("getFBIdentity = async () => { identityReads++; return {fb_name: 'Test'}; }", context);
  await new Promise(setImmediate);
  const socket = sockets[0]; socket.readyState = 1; socket.onopen();
  async function message(value) {
    await socket.onmessage({data: JSON.stringify(value)});
    await new Promise(setImmediate);
  }
  await new Promise(setImmediate);
  return {chrome, context, socket, sent, opened, listeners, message};
}

test("connections initialize and accept commands without pairing", async () => {
  const f = await fixture();
  assert.equal(f.context.identityReads, 1);
  assert.equal(f.sent[0].type, "init");
  await f.message({action: "open", url: "https://www.facebook.com/"});
  assert.equal(f.opened.length, 1);
  assert.equal(f.socket.readyState, 1);
});

test("runtime commands require our popup; content messages require the top Facebook frame", async () => {
  const f = await fixture();
  let calls = 0; f.context.record = () => calls++;
  vm.runInContext("requestConnection = record; handleAction = async () => record()", f.context);
  const popup = {id: f.chrome.runtime.id, url: f.chrome.runtime.getURL("popup.html")};
  for (const sender of [{}, {...popup, id: "other"}, {...popup, url: "https://evil.example/"},
    {...popup, tab: {id: 1}, url: "https://www.facebook.com/", frameId: 0}]) {
    f.listeners[0]({cmd: "connect_py"}, sender, () => {});
  }
  assert.equal(calls, 0);
  f.listeners[0]({cmd: "connect_py"}, popup, () => {});
  assert.equal(calls, 1);
});

test("open commands accept only HTTPS Facebook destinations", async () => {
  const f = await fixture();
  for (const url of ["javascript:alert(1)", "file:///C:/secret.png", "https://evil.example/", "http://www.facebook.com/", "https://facebook.com.evil.example/"]) {
    f.context.destination = url;
    await vm.runInContext("handleAction({action:'open',url:destination})", f.context);
  }
  assert.equal(f.opened.length, 0);
});

test("a Stop command does not wait behind a long running action", async () => {
  const f = await fixture();
  const calls = [];
  let finish;
  f.context.captureAction = msg => {
    calls.push(msg.action);
    return msg.action === "scroll30" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  };
  vm.runInContext("handleAction = captureAction", f.context);
  for (const action of ["scroll30", "stop_scroll"]) {
    await f.message({action});
  }
  assert.deepEqual(calls, ["scroll30", "stop_scroll"]);
  finish();
});

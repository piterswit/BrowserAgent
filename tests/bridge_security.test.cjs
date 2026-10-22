const assert = require("node:assert/strict");
const {test} = require("node:test");
const {webcrypto, createHmac} = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
const key = "ab".repeat(32), sn = "cd".repeat(32);
const sign = (role, cn, suffix = "") => createHmac("sha256", Buffer.from(key, "hex"))
  .update(`fb-bridge-v1|${role}|${sn}|${cn}${suffix}`).digest("hex");
async function fixture(nativeResult = {protocol: 1, key}) {
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
      sendNativeMessage: async (host, message) => {
        assert.equal(host, "com.browseragent.bridge");
        assert.equal(message.cmd, "get_bridge_credentials");
        if (nativeResult instanceof Error) throw nativeResult;
        return nativeResult;
      },
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
    await vm.runInContext("bridgeSessions.get(ws)?.sendQueue", context);
    await new Promise(setImmediate);
  }
  await new Promise(setImmediate);
  async function authenticate() {
    await message({type: "auth_challenge", nonce: sn});
    const response = sent.find(item => item.type === "auth_response");
    assert.equal(response.proof, sign("client", response.nonce));
    await message({type: "auth_ok", proof: sign("server", response.nonce)});
    return response.nonce;
  }
  return {chrome, context, socket, sent, opened, listeners, message, authenticate};
}

test("identity and commands wait for automatic native authentication", async () => {
  const f = await fixture();
  assert.equal(f.context.identityReads, 0);
  const cn = await f.authenticate();
  assert.equal(f.context.identityReads, 1);
  const identity = f.sent.find(frame => frame.type === "secure");
  assert.equal(identity.proof, sign("client-message", cn, `|1|${identity.body}`));
  const body = JSON.stringify({action: "open", url: "https://www.facebook.com/"});
  await f.message({type: "secure", seq: 1, body, proof: sign("server-message", cn, `|1|${body}`)});
  assert.equal(f.opened.length, 1);
});

test("missing or invalid native host fails closed without reading identity", async () => {
  for (const result of [new Error("Missing host"), {}, {protocol: 1, key: "bad"}]) {
    const f = await fixture(result);
    await f.message({type: "auth_challenge", nonce: sn});
    assert.equal(f.context.identityReads, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.socket.readyState, 3);
  }
});

test("untrusted servers, reflected proofs, tampering and replays are rejected", async () => {
  const raw = await fixture();
  await raw.message({action: "open", url: "https://www.facebook.com/"});
  assert.equal(raw.socket.readyState, 3);
  assert.equal(raw.opened.length, 0);
  assert.equal(raw.context.identityReads, 0);
  const reflected = await fixture();
  await reflected.message({type: "auth_challenge", nonce: sn});
  await reflected.message({type: "auth_ok", proof: reflected.sent[0].proof});
  assert.equal(reflected.socket.readyState, 3);
  assert.equal(reflected.context.identityReads, 0);
  for (const attack of ["tamper", "replay", "raw"]) {
    const f = await fixture(), cn = await f.authenticate();
    const body = JSON.stringify({action: "open", url: "https://www.facebook.com/"});
    const frame = {type: "secure", seq: 1, body, proof: sign("server-message", cn, `|1|${body}`)};
    if (attack === "tamper") frame.body = body + " ";
    await f.message(attack === "raw" ? {action: "open", url: "https://www.facebook.com/"} : frame);
    if (attack === "replay") await f.message(frame);
    assert.equal(f.opened.length, attack === "replay" ? 1 : 0);
    assert.equal(f.socket.readyState, 3);
  }
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
  const f = await fixture(), cn = await f.authenticate();
  const calls = [];
  let finish;
  f.context.captureAction = msg => {
    calls.push(msg.action);
    return msg.action === "scroll30" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  };
  vm.runInContext("handleAction = captureAction", f.context);
  for (const [index, action] of ["scroll30", "stop_scroll"].entries()) {
    const seq = index + 1, body = JSON.stringify({action});
    await f.message({type: "secure", seq, body, proof: sign("server-message", cn, `|${seq}|${body}`)});
  }
  assert.deepEqual(calls, ["scroll30", "stop_scroll"]);
  finish();
});

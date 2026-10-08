const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
function bridge(mode, failure) {
  const messages = [], commands = [], events = new Set(), updates = new Set();
  let detached = 0;
  const chrome = {
    tabs: {
      query: async () => [{id: 7, url: "https://www.facebook.com/"}],
      get: async () => ({url: "https://www.facebook.com/profile.php?id=123"}),
      update: async id => { for (const listener of updates) listener(id, {status: "complete"}, {url: "https://www.facebook.com/me"}); },
      onUpdated: {addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn)}
    },
    runtime: {onMessage: {addListener() {}}},
    scripting: {executeScript: async options => {
      if (options.files) return [];
      const step = options.args[0];
      return [{result: step === failure ? {error: "test failure"} : {value: step === "prepare" ? mode : step === "upload" ? {x: 100, y: 200} : undefined}}];
    }},
    debugger: {
      attach: async () => {},
      detach: async () => { detached++; },
      sendCommand: async (_target, method, params) => {
        commands.push({method, params});
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
          for (const listener of events) listener({tabId: 7}, "Page.fileChooserOpened", {backendNodeId: 42});
        }
        if (method === "DOM.getDocument") return {root: {nodeId: 1}};
        if (method === "DOM.querySelector") return {nodeId: 2};
        return {};
      },
      onEvent: {addListener: fn => events.add(fn), removeListener: fn => events.delete(fn)}
    }
  };
  class Socket { static OPEN = 1; static CONNECTING = 0; readyState = 0; }
  const context = vm.createContext({chrome, crypto: {randomUUID: () => "client"}, WebSocket: Socket,
    URL, setTimeout, clearTimeout, setInterval() {}});
  vm.runInContext(source, context);
  context.sendMessage = value => messages.push(JSON.parse(value));
  vm.runInContext("ws = {readyState: WebSocket.OPEN, send: sendMessage}", context);
  return {context, messages, commands, events, detached: () => detached};
}

for (const mode of ["input", "chooser"]) {
  test(`uploads a local file and saves through ${mode}`, async () => {
    const b = bridge(mode);
    await vm.runInContext('runAvatarChange("D:\\\\头像\\\\photo.png")', b.context);
    assert.equal(b.messages.at(-1).success, true, b.messages.at(-1).error);
    const upload = b.commands.find(c => c.method === "DOM.setFileInputFiles");
    assert.equal(upload.params.files[0], "D:\\头像\\photo.png");
    assert.equal(b.detached(), 1);
    assert.equal(b.events.size, 0);
    assert.equal(vm.runInContext("avatarBusy", b.context), false);
  });
}
test("save failure reports an error and releases debugger", async () => {
  const b = bridge("input", "save");
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.equal(b.messages.at(-1).error, "test failure");
  assert.equal(b.detached(), 1);
});
test("invalid paths never attach debugger", async () => {
  const b = bridge("input");
  await vm.runInContext('runAvatarChange("relative.jpg")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.equal(b.detached(), 0);
});

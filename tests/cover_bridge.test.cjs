const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
const taskId = "ff229ade-8fae-4a80-b177-74ce68177670";
const profile = "https://www.facebook.com/profile.php?id=123";

function bridge({mode = "input", fail = "", confirmed = true} = {}) {
  const messages = [], commands = [], removed = [], listeners = new Set(), events = new Set(), runtime = [];
  let attached = 0, detached = 0;
  const identity = {fb_name: "Demo", profile_url: profile};
  let context;
  const chrome = {
    windows: {getAll: async () => [{id: 1, focused: true}], get: async () => ({state: "normal"}),
      update: async () => {}, onRemoved: {addListener() {}}, onCreated: {addListener() {}}},
    tabs: {
      create: async () => ({id: 99}), query: async () => [], get: async () => ({windowId: 1, url: profile}),
      update: async (id, options) => {
        if (options.url) for (const callback of listeners) callback(id, {status: "complete"}, {url: profile});
      },
      remove: async id => { removed.push(id); },
      onUpdated: {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)},
      onRemoved: {addListener() {}, removeListener() {}}
    },
    storage: {session: {get: async () => ({}), set: async () => {}}},
    alarms: {clear: async () => {}, create: async () => {}, onAlarm: {addListener() {}}},
    runtime: {id: "test", getURL: name => "chrome-extension://test/" + name,
      onMessage: {addListener: fn => runtime.push(fn)}},
    debugger: {
      attach: async () => { attached++; }, detach: async () => { detached++; },
      onEvent: {addListener: fn => events.add(fn), removeListener: fn => events.delete(fn)},
      sendCommand: async (_, method, params) => {
        commands.push({method, params});
        if (method === "DOM.getDocument") return {root: {nodeId: 1}};
        if (method === "DOM.querySelector") return {nodeId: 2};
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
          for (const callback of events) callback({tabId: 99}, "Page.fileChooserOpened", {backendNodeId: 88});
        }
        return {};
      }
    },
    scripting: {executeScript: async options => {
      if (options.files) return [];
      const step = options.args?.[1];
      if (["prepare", "upload", "save"].includes(step)) {
        if (step === "save" && fail === "after-submit") {
          vm.runInContext("coverOperation.submitted = true", context);
          throw new Error("Navigation destroyed execution context");
        }
        if (step === fail) return [{result: {error: "test failure"}}];
        return [{result: {value: step === "prepare" ? mode :
          step === "upload" ? {x: 40, y: 60} : {confirmed}}}];
      }
      if (!options.args) return [{result: identity}];
      return [];
    }}
  };
  class Socket { static OPEN = 1; static CONNECTING = 0; readyState = 0; }
  context = vm.createContext({chrome, URL, WebSocket: Socket, window: {}, console,
    crypto: {randomUUID: () => taskId}, setTimeout, clearTimeout, setInterval() {}});
  vm.runInContext(source, context);
  context.capture = message => messages.push(message);
  vm.runInContext("ws = {readyState: WebSocket.OPEN}; authenticatedSockets.add(ws); safeSend = capture", context);
  const run = (overrides = {}) => {
    context.coverRequest = {task_id: taskId, file_path: "D:\\covers\\wide.png", profile_url: profile, ...overrides};
    return vm.runInContext("runCoverChange(coverRequest)", context);
  };
  const reply = async (cmd, tabId = 99, id = taskId) => new Promise(resolve => {
    const result = runtime[0]({cmd, operationId: id},
      {id: "test", frameId: 0, url: profile, tab: {id: tabId}}, resolve);
    if (result !== true) resolve(undefined);
  });
  return {chrome, context, messages, commands, removed, events, identity, run, reply,
    attached: () => attached, detached: () => detached};
}

for (const mode of ["input", "chooser"]) {
  test("cover upload uses " + mode + " and releases its task resources", async () => {
    const b = bridge({mode});
    await b.run();
    assert.equal(b.messages.at(-1).type, "cover_result");
    assert.equal(b.messages.at(-1).task_id, taskId);
    assert.equal(b.messages.at(-1).confirmed, true);
    const upload = b.commands.find(command => command.method === "DOM.setFileInputFiles");
    assert.deepEqual(Array.from(upload.params.files), ["D:\\covers\\wide.png"]);
    assert.equal(b.attached(), 1);
    assert.equal(b.detached(), 1);
    assert.equal(b.events.size, 0);
    assert.deepEqual(b.removed, [99]);
    assert.equal(vm.runInContext("coverOperation", b.context), null);
  });
}

test("invalid cover requests never attach the debugger", async () => {
  for (const overrides of [{file_path: "relative.jpg"}, {profile_url: null}, {file_path: "D:\\covers\\bad.exe"}]) {
    const b = bridge();
    await b.run(overrides);
    assert.equal(b.attached(), 0);
    assert.equal(b.messages.at(-1).success, false);
  }
});

test("a changed account fails before upload", async () => {
  const b = bridge();
  b.identity.profile_url = "https://www.facebook.com/profile.php?id=456";
  await b.run();
  assert.equal(b.attached(), 0);
  assert.equal(b.messages.at(-1).success, false);
  assert.deepEqual(b.removed, [99]);
});

test("cover cannot replace a running avatar, post or activity task", async () => {
  for (const setup of ["avatarBusy = true", "postBusy = true", "activeRun = {tabId: 3}"]) {
    const b = bridge();
    vm.runInContext(setup, b.context);
    await b.run();
    assert.equal(b.attached(), 0);
    assert.equal(b.messages.at(-1).success, false);
  }
});

test("upload failure is different from an uncertain submitted save", async () => {
  const before = bridge({fail: "prepare"});
  await before.run();
  assert.equal(before.messages.at(-1).success, false);
  const after = bridge({fail: "after-submit"});
  await after.run();
  assert.equal(after.messages.at(-1).success, true);
  assert.equal(after.messages.at(-1).confirmed, false);
  assert.equal(after.detached(), 1);
});

test("unconfirmed Facebook feedback remains pending", async () => {
  const b = bridge({confirmed: false});
  await b.run();
  assert.equal(b.messages.at(-1).success, true);
  assert.equal(b.messages.at(-1).confirmed, false);
});

test("only the assigned cover task page can authorize saving", async () => {
  const b = bridge();
  vm.runInContext("coverOperation = {id: crypto.randomUUID(), tabId: 99, socket: ws, profile: '" + profile +
    "', expires: Date.now() + 10000, submitted: false}", b.context);
  assert.equal((await b.reply("fb_cover_submitting", 5)).accepted, false);
  assert.equal((await b.reply("fb_cover_submitting", 99, "wrong")).accepted, false);
  assert.equal(vm.runInContext("coverOperation.submitted", b.context), false);
  assert.equal((await b.reply("fb_cover_submitting")).accepted, true);
  assert.equal(vm.runInContext("coverOperation.submitted", b.context), true);
  assert.equal((await b.reply("fb_cover_submitting")).accepted, false);
});

test("disconnect before save authorization cannot submit", async () => {
  const b = bridge();
  await Promise.resolve();
  vm.runInContext("coverOperation = {id: crypto.randomUUID(), tabId: 99, socket: ws, expires: Date.now() + 10000}; ws = null", b.context);
  assert.equal((await b.reply("fb_cover_submitting")).accepted, false);
});

test("an account switch before save authorization cannot submit", async () => {
  const b = bridge();
  vm.runInContext("coverOperation = {id: crypto.randomUUID(), tabId: 99, socket: ws, profile: '" + profile +
    "', expires: Date.now() + 10000, submitted: false}", b.context);
  b.identity.profile_url = "https://www.facebook.com/another-account";
  assert.equal((await b.reply("fb_cover_submitting")).accepted, false);
  assert.equal(vm.runInContext("coverOperation.submitted", b.context), false);
});

for (const state of ["cancelled", "expired", "active"]) {
  test("post submission authorization respects " + state + " operation state", async () => {
    const b = bridge();
    vm.runInContext("postOperation = {id: crypto.randomUUID(), tabId: 99, socket: ws, profile: '" + profile +
      "', expires: Date.now() + " + (state === "expired" ? "-1" : "10000") +
      ", cancelled: " + (state === "cancelled") + ", submitted: false}", b.context);
    assert.equal((await b.reply("fb_post_submitting")).accepted, state === "active");
    assert.equal(vm.runInContext("postOperation.submitted", b.context), state === "active");
  });
}

for (const stage of ["timeout", "cleanup"]) {
  test("late post submission is refused during " + stage, async () => {
    const b = bridge();
    let expire, late;
    b.context.setTimeout = (fn, delay) => delay === 110000 ? (expire = fn, undefined) : setTimeout(fn, delay);
    const execute = b.chrome.scripting.executeScript;
    b.chrome.scripting.executeScript = async options => {
      if (options.files?.includes("publish_post.js")) {
        if (stage === "timeout") {
          expire();
          late = await b.reply("fb_post_submitting");
        } else throw new Error("page injection failed");
      }
      return execute(options);
    };
    b.chrome.tabs.remove = async () => {
      if (stage === "cleanup") late = await b.reply("fb_post_submitting");
    };
    b.context.postRequest = {task_id: taskId, text: "Hello", profile_url: profile};
    await vm.runInContext("runPost(postRequest)", b.context);
    assert.equal(late.accepted, false);
    assert.equal(b.messages.at(-1).success, false);
    assert.equal(vm.runInContext("postBusy", b.context), false);
    assert.equal(vm.runInContext("postOperation", b.context), null);
  });
}

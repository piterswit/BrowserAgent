const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
function bridge(mode, failure, identityError = "") {
  const messages = [], commands = [], events = new Set(), updates = new Set();
  const created = [], removed = [], navigated = [], tabRemoved = new Set();
  const windowRemoved = new Set();
  const runtimeMessages = new Set();
  const identity = {fb_name: "Test Account", fb_id: "123", profile_url: "https://www.facebook.com/profile.php?id=123", avatar_url: "https://scontent.example.fbcdn.net/photo.jpg"};
  let detached = 0;
  const chrome = {
    windows: {get: async () => ({id: 1, state: "normal"}), update: async () => {}, getAll: async () => [{id: 1, focused: true}], onRemoved: {addListener: fn => windowRemoved.add(fn)}, onCreated: {addListener() {}}},
    storage: {local: {setAccessLevel: async () => {}, get: async () => ({}), set: async () => {}},
      session: {get: async () => ({}), set: async () => {}}},
    alarms: {clear: async () => {}, create: async () => {}, onAlarm: {addListener() {}}},
    tabs: {
      query: async () => [{id: 7, url: "https://www.facebook.com/"}],
      create: async options => { created.push(options); return {id: 99}; },
      remove: async id => { removed.push(id); },
      get: async () => ({windowId: 1, url: "https://www.facebook.com/profile.php?id=123"}),
      update: async (id, options) => {
        navigated.push({id, options});
        for (const listener of updates) listener(id, {status: "complete"}, {url: "about:blank"});
        for (const listener of updates) listener(id, {status: "complete"}, {url: "https://www.facebook.com/profile.php?id=123"});
      },
      onRemoved: {addListener: fn => tabRemoved.add(fn), removeListener: fn => tabRemoved.delete(fn)},
      onUpdated: {addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn)}
    },
    runtime: {id: "test-extension", getURL: file => `chrome-extension://test-extension/${file}`,
      onMessage: {addListener: fn => runtimeMessages.add((msg, sender, respond) => fn(msg,
        {id: "test-extension", frameId: 0, url: "https://www.facebook.com/", ...sender}, respond))}},
    scripting: {executeScript: async options => {
      if (options.files) return [];
      if (!options.args) return [{result: identityError ? {error: identityError} : identity}];
      const step = options.args[0];
      return [{result: step === failure ? {error: "test failure"} : {value: step === "prepare" ? mode : step === "upload" ? {x: 100, y: 200} : {confirmed: true}}}];
    }},
    debugger: {
      attach: async () => {},
      detach: async () => { detached++; },
      sendCommand: async (_target, method, params) => {
        commands.push({method, params});
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
          for (const listener of events) listener({tabId: 99}, "Page.fileChooserOpened", {backendNodeId: 42});
        }
        if (method === "DOM.getDocument") return {root: {nodeId: 1}};
        if (method === "DOM.querySelector") return {nodeId: 2};
        return {};
      },
      onEvent: {addListener: fn => events.add(fn), removeListener: fn => events.delete(fn)}
    }
  };
  class Socket { static OPEN = 1; static CONNECTING = 0; readyState = 0; }
  const context = vm.createContext({chrome, window: {}, console: {warn() {}}, crypto: {randomUUID: () => "client"}, WebSocket: Socket,
    URL, setTimeout, clearTimeout, setInterval() {}});
  vm.runInContext(source, context);
  context.sendMessage = value => messages.push(JSON.parse(value));
  vm.runInContext("ws = {readyState: WebSocket.OPEN, send: sendMessage}", context);
  return {context, chrome, messages, commands, events, identity, created, removed, navigated, tabRemoved, windowRemoved, runtimeMessages,
    permanentTabListeners: tabRemoved.size, detached: () => detached};
}

for (const mode of ["input", "chooser"]) {
  test(`uploads a local file and saves through ${mode}`, async () => {
    const b = bridge(mode);
    await vm.runInContext('runAvatarChange("D:\\\\头像\\\\photo.png", "https://www.facebook.com/profile.php?id=123")', b.context);
    assert.equal(b.messages.at(-1).success, true, b.messages.at(-1).error);
    const upload = b.commands.find(c => c.method === "DOM.setFileInputFiles");
    assert.equal(upload.params.files[0], "D:\\头像\\photo.png");
    assert.equal(b.detached(), 1);
    assert.equal(b.events.size, 0);
    assert.deepEqual(b.removed, [99]);
    assert.equal(b.created[0].active, false);
    assert.equal(b.navigated[0].id, 99);
    assert.equal(b.navigated[0].options.active, false);
    assert.ok(b.navigated.filter(item => item.options.active === true).length >= 3);
    assert.equal(b.messages.at(-1).confirmed, true);
    assert.equal(vm.runInContext("avatarBusy", b.context), false);
  });
}
test("save failure reports an error and releases debugger", async () => {
  const b = bridge("input", "save");
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.equal(b.messages.at(-1).error, "test failure");
  assert.equal(b.detached(), 1);
  assert.deepEqual(b.removed, [99]);
});

for (const changed of [false, true]) {
  test(`save context lost after submission is ${changed ? "confirmed by changed avatar" : "pending, not failed"}`, async () => {
    const b = bridge("input");
    const original = b.chrome.scripting.executeScript;
    b.chrome.scripting.executeScript = async options => {
      if (options.args?.[0] !== "save") return original(options);
      const operation = vm.runInContext("avatarOperation", b.context);
      for (const listener of b.runtimeMessages) listener({cmd: "fb_avatar_submitting", operationId: operation.id}, {tab: {id: 99}}, response => assert.equal(response.accepted, true));
      if (changed) b.identity.avatar_url = "https://scontent.example.fbcdn.net/new-photo.jpg";
      return [];
    };
    await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
    assert.equal(b.messages.at(-1).success, true);
    assert.equal(b.messages.at(-1).confirmed, changed);
    assert.deepEqual(b.removed, [99]);
    assert.equal(vm.runInContext("avatarOperation", b.context), null);
  });
}

test("script loss before Save remains a failure", async () => {
  const b = bridge("input");
  const original = b.chrome.scripting.executeScript;
  b.chrome.scripting.executeScript = async options => options.args?.[0] === "save" ? [] : original(options);
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, false);
});

test("closed tab after submission remains pending, not an upload failure", async () => {
  const b = bridge("input");
  const original = b.chrome.scripting.executeScript;
  b.chrome.scripting.executeScript = async options => {
    if (options.args?.[0] !== "save") return original(options);
    vm.runInContext("avatarOperation.submitted = true", b.context);
    b.chrome.tabs.get = async () => { throw new Error("tab closed"); };
    throw new Error("context destroyed");
  };
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, true);
  assert.equal(b.messages.at(-1).confirmed, false);
});

test("unrelated tab cannot acknowledge an avatar Save", async () => {
  const b = bridge("input");
  vm.runInContext('avatarOperation = {id: "token", tabId: 99, submitted: false}', b.context);
  for (const listener of b.runtimeMessages) {
    listener({cmd: "fb_avatar_submitting", operationId: "token"}, {tab: {id: 7}}, response => assert.equal(response.accepted, false));
    listener({cmd: "fb_avatar_submitting", operationId: "old-token"}, {tab: {id: 99}}, response => assert.equal(response.accepted, false));
  }
  assert.equal(vm.runInContext("avatarOperation.submitted", b.context), false);
});

test("explicit Facebook errors stay failures after Save submission", async () => {
  const b = bridge("input", "save");
  const original = b.chrome.scripting.executeScript;
  b.chrome.scripting.executeScript = async options => {
    if (options.args?.[0] === "save") vm.runInContext("avatarOperation.submitted = true", b.context);
    return original(options);
  };
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, false);
});

test("locate browser activates the existing FB tab without navigating or creating tabs", async () => {
  const b = bridge("input");
  const focused = [];
  b.chrome.windows.update = async (id, options) => focused.push({id, options});
  await vm.runInContext('handleAction({action: "locate_browser"})', b.context);
  assert.equal(focused[0].id, 1);
  assert.equal(focused[0].options.focused, true);
  assert.equal(b.navigated[0].id, 7);
  assert.equal(b.navigated[0].options.active, true);
  assert.equal(b.navigated[0].options.url, undefined);
  assert.equal(b.created.length, 0);
  assert.equal(b.messages.length, 0);
});

test("locate restores minimized window before focusing, without status messages", async () => {
  const b = bridge("input");
  const updates = [];
  b.chrome.windows.get = async id => ({id, state: "minimized"});
  b.chrome.windows.update = async (id, options) => updates.push({id, options});
  await vm.runInContext('handleAction({action: "locate_browser"})', b.context);
  assert.equal(updates[0].options.state, "normal");
  assert.equal(updates[1].options.focused, true);
  assert.equal(b.messages.length, 0);
});

test("locate preserves maximized window and never changes account status on failure", async () => {
  const b = bridge("input");
  const updates = [];
  b.chrome.windows.get = async id => ({id, state: "maximized"});
  b.chrome.windows.update = async (id, options) => updates.push(options);
  await vm.runInContext('handleAction({action: "locate_browser"})', b.context);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state, undefined);
  b.chrome.windows.get = async () => { throw new Error("window closed"); };
  await vm.runInContext('handleAction({action: "locate_browser"})', b.context);
  assert.equal(b.messages.length, 0);
});

test("homepage never takes feed authors or OG cover images as own avatar", async () => {
  const b = bridge("input");
  accountDocument(b, {USER_ID: "123", NAME: "Alice"}, {picture: "https://scontent.example.fbcdn.net/cover.jpg"});
  b.context.location = {href: "https://www.facebook.com/"};
  const original = b.context.document.querySelectorAll;
  b.context.document.querySelectorAll = selector => selector.startsWith('[role="main"] img') ? [{
    currentSrc: "https://scontent.example.fbcdn.net/bob.jpg", closest: () => null,
    getAttribute: () => "Bob's profile picture", getBoundingClientRect: () => ({width: 168, height: 168, top: 0})
  }] : original(selector);
  const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
  assert.equal(identity.fb_id, "123");
  assert.equal(identity.avatar_url, null);
});
test("invalid paths never attach debugger", async () => {
  const b = bridge("input");
  await vm.runInContext('runAvatarChange("relative.jpg")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.equal(b.detached(), 0);
});

test("identity lookup opens and closes only a background task tab", async () => {
  const b = bridge("input");
  const result = await vm.runInContext("getFBIdentity()", b.context);
  assert.equal(result.fb_id, "123");
  assert.equal(b.created[0].active, false);
  assert.deepEqual(b.removed, [99]);
  assert.deepEqual(b.navigated.map(item => item.id), [99]);
  assert.equal(b.tabRemoved.size, b.permanentTabListeners);
});

test("identity failure still cleans up its own tab", async () => {
  const b = bridge("input", null, "login required");
  await assert.rejects(vm.runInContext("getFBIdentity()", b.context), /login required/);
  assert.deepEqual(b.removed, [99]);
});

test("closing a loading task tab rejects promptly without touching another tab", async () => {
  const b = bridge("input");
  b.chrome.tabs.update = async id => {
    for (const listener of b.tabRemoved) listener(id);
  };
  await assert.rejects(vm.runInContext("getFBIdentity()", b.context), /标签页已被关闭/);
  assert.deepEqual(b.removed, [99]);
  assert.equal(b.tabRemoved.size, b.permanentTabListeners);
});

test("lost local connection stops before upload and releases resources", async () => {
  const b = bridge("input");
  const original = b.chrome.scripting.executeScript;
  b.chrome.scripting.executeScript = async options => {
    const result = await original(options);
    if (options.args?.[0] === "prepare") vm.runInContext("ws = null", b.context);
    return result;
  };
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.match(b.messages.at(-1).error, /连接已断开/);
  assert.equal(b.commands.some(c => c.method === "DOM.setFileInputFiles"), false);
  assert.equal(b.detached(), 1);
  assert.deepEqual(b.removed, [99]);
});

test("changed accounts are rejected before upload", async () => {
  const b = bridge("input");
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=456")', b.context);
  assert.equal(b.messages.at(-1).success, false);
  assert.match(b.messages.at(-1).error, /账号.*变化/);
  assert.equal(b.commands.length, 0);
  assert.deepEqual(b.removed, [99]);
});

test("closed save dialog without confirmation is not reported as confirmed", async () => {
  const b = bridge("input");
  const original = b.chrome.scripting.executeScript;
  b.chrome.scripting.executeScript = async options => options.args?.[0] === "save" ? [{result: {value: {confirmed: false}}}] : original(options);
  await vm.runInContext('runAvatarChange("D:\\\\photo.jpg", "https://www.facebook.com/profile.php?id=123")', b.context);
  assert.equal(b.messages.at(-1).success, true);
  assert.equal(b.messages.at(-1).confirmed, false);
});

for (const [url, canonical, deepLink, expectedId, expectedUsername] of [
  ["https://www.facebook.com/profile.php?id=123", null, null, "123", null],
  ["https://www.facebook.com/alice", null, null, null, "alice"],
  ["https://www.facebook.com/alice", null, "fb://profile/123", "123", "alice"]
]) {
  test(`reads actual profile metadata from ${url} ${deepLink || ""}`, async () => {
    const b = bridge("input");
    b.context.location = {href: url};
    b.context.document = {
      title: "Alice | Facebook",
      querySelector: selector => selector === 'meta[property="og:title"]' ? {content: "Alice | Facebook"} : selector === 'link[rel="canonical"]' && canonical ? {href: canonical} : null,
      querySelectorAll: selector => selector.startsWith('meta[') && deepLink ? [{content: deepLink}] : []
    };
    b.chrome.scripting.executeScript = async options => [{result: await options.func()}];
    const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
    assert.equal(identity.fb_id, expectedId);
    assert.equal(identity.fb_username, expectedUsername);
    assert.equal(identity.fb_name, "Alice");
  });
}

for (const [heading, pictureLabel] of [["Notifications", "Alice Chen's profile picture"], ["通知消息", "Alice Chen的头像"], ["通知訊息", "Alice Chen的頭像"], ["通知", "Alice Chen的大頭貼"]]) {
test(`${heading}: localized headings never replace the profile's name and photo`, async () => {
  const b = bridge("input");
  b.context.location = {href: "https://www.facebook.com/alice"};
  b.context.document = {
    title: "(3) Facebook",
    querySelector: selector => selector === 'meta[property="og:title"]' ? {content: "Alice Chen | Facebook"} : null,
    querySelectorAll: selector => {
      if (selector.startsWith('[role="main"] h1')) return [{innerText: heading, closest: () => null}];
      if (selector.startsWith('[role="main"] img')) return [{
        currentSrc: "https://scontent.example.fbcdn.net/alice.jpg",
        closest: () => null, getAttribute: name => name === "alt" ? pictureLabel : null,
        getBoundingClientRect: () => ({width: 168, height: 168, top: 80})
      }];
      return [];
    }
  };
  b.chrome.scripting.executeScript = async options => [{result: await options.func()}];
  const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
  assert.equal(identity.fb_name, "Alice Chen");
  assert.equal(identity.avatar_url, "https://scontent.example.fbcdn.net/alice.jpg");
});
}

test("main profile heading is used when metadata is missing", async () => {
  const b = bridge("input");
  b.context.location = {href: "https://www.facebook.com/alice"};
  b.context.document = {
    title: "Facebook", querySelector: () => null,
    querySelectorAll: selector => selector.startsWith('[role="main"] h1') ? [
      {innerText: "Notifications", closest: () => null},
      {innerText: "Alice Chen", closest: selector => selector === '[role="main"], main' ? {} : null}
    ] : []
  };
  b.chrome.scripting.executeScript = async options => [{result: await options.func()}];
  assert.equal((await vm.runInContext("readProfileIdentity(99)", b.context)).fb_name, "Alice Chen");
});

test("last normal browser window closes the connection even with background mode", async () => {
  const b = bridge("input");
  b.chrome.windows.getAll = async () => [];
  const closed = [];
  b.context.closeSocket = (...args) => closed.push(args);
  vm.runInContext("ws.close = closeSocket", b.context);
  for (const listener of b.windowRemoved) await listener();
  assert.equal(closed.length, 1);
  assert.equal(closed[0][0], 1000);
});

test("closing one of multiple windows keeps the account connected", async () => {
  const b = bridge("input");
  b.chrome.windows.getAll = async () => [{id: 1}];
  b.context.closeSocket = () => { throw new Error("connection must stay open"); };
  vm.runInContext("ws.close = closeSocket", b.context);
  for (const listener of b.windowRemoved) await listener();
});

test("identity lookup never reopens a browser after its windows are closed", async () => {
  const b = bridge("input");
  b.chrome.windows.getAll = async () => [];
  await assert.rejects(vm.runInContext("getFBIdentity()", b.context), /窗口已关闭/);
  assert.equal(b.created.length, 0);
});

test("avatar thumbnail is cropped, resized and transmitted as PNG", async () => {
  const b = bridge("input");
  const bytes = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/icon/avatar-placeholder.png"));
  const calls = [];
  let closed = false;
  const bitmap = {width: 200, height: 100, close() { closed = true; }};
  b.context.AbortSignal = {timeout: () => null};
  b.context.fetch = async (url, options) => {
    assert.equal(url, "https://scontent.example.fbcdn.net/photo.jpg");
    assert.equal(options.credentials, "omit");
    return {ok: true, blob: async () => ({type: "image/jpeg", size: 1024})};
  };
  b.context.createImageBitmap = async () => bitmap;
  b.context.btoa = value => Buffer.from(value, "binary").toString("base64");
  b.context.OffscreenCanvas = class {
    constructor(width, height) { assert.equal(width, 36); assert.equal(height, 36); }
    getContext() { return {beginPath() {}, arc() {}, clip() {}, drawImage: (...args) => calls.push(args)}; }
    async convertToBlob(options) {
      assert.equal(options.type, "image/png");
      return {arrayBuffer: async () => Uint8Array.from(bytes).buffer};
    }
  };
  const thumbnail = await vm.runInContext('loadAvatarThumbnail("https://scontent.example.fbcdn.net/photo.jpg")', b.context);
  assert.deepEqual(Buffer.from(thumbnail.split(",")[1], "base64"), bytes);
  assert.deepEqual(calls[0].slice(1), [50, 0, 100, 100, 0, 0, 36, 36]);
  assert.equal(closed, true);
});

test("avatar download failures do not prevent identity registration", async () => {
  const b = bridge("input");
  b.identity.avatar_url = "https://scontent.example.fbcdn.net/photo.jpg";
  b.context.AbortSignal = {timeout: () => null};
  b.context.fetch = async () => { throw new Error("image expired"); };
  const identity = await vm.runInContext("getFBIdentity()", b.context);
  assert.equal(identity.fb_name, "Test Account");
  assert.equal(identity.avatar_data, null);
  assert.deepEqual(b.removed, [99]);
});

test("avatar reader rejects non-Facebook image hosts", async () => {
  const b = bridge("input");
  b.context.fetch = () => { throw new Error("unexpected request"); };
  assert.equal(await vm.runInContext('loadAvatarThumbnail("https://example.com/image.png")', b.context), null);
});

function accountDocument(b, user, {script = false, headings = [], picture = null} = {}) {
  b.context.location = {href: "https://www.facebook.com/me", pathname: "/me"};
  b.context.window = script ? {} : {require: name => {
    assert.equal(name, "CurrentUserInitialData");
    return user;
  }};
  b.context.document = {
    title: "Facebook",
    querySelector: selector => selector === 'meta[property="og:image"]' && picture ? {content: picture} : null,
    querySelectorAll: selector => {
      if (selector.startsWith('script[') && script) return [{textContent: JSON.stringify({require: [["ScheduledServerJS", "handle", null, [{__bbox: {define: [["CurrentUserInitialData", [], user]]}}]]]})}];
      if (selector.startsWith('[role="main"] h1')) return headings.map(innerText => ({innerText, closest: () => null}));
      return [];
    }
  };
  b.chrome.scripting.executeScript = async options => {
    assert.equal(options.world, "MAIN");
    return [{result: await options.func()}];
  };
}

for (const script of [false, true]) {
  test(`reads account ID/name without a profile redirect or usable headings (${script ? "structured data" : "page module"})`, async () => {
    const b = bridge("input");
    accountDocument(b, {USER_ID: "10001234567", NAME: "Alice Chen", PROFILE_PICTURE_URI: "https://scontent.example.fbcdn.net/alice.jpg"}, {script, headings: ["Notifications"]});
    const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
    assert.equal(identity.fb_id, "10001234567");
    assert.equal(identity.fb_name, "Alice Chen");
    assert.equal(identity.avatar_url, "https://scontent.example.fbcdn.net/alice.jpg");
    assert.equal(identity.profile_url, "https://www.facebook.com/profile.php?id=10001234567");
  });
}

test("missing name preserves ID but never uses ambiguous OG images as avatars", async () => {
  const b = bridge("input");
  accountDocument(b, {USER_ID: "10001234567"}, {headings: ["Notifications"], picture: "https://scontent.example.fbcdn.net/alice.jpg"});
  let clock = 0;
  b.context.Date = {now: () => clock += 10000};
  b.context.setTimeout = callback => callback();
  const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
  assert.equal(identity.fb_id, "10001234567");
  assert.equal(identity.fb_name, null);
  assert.equal(identity.avatar_url, null);
  assert.match(identity.identity_error, /未读取到账号名字/);
});

test("missing ID does not discard an already-read name", async () => {
  const b = bridge("input");
  accountDocument(b, {NAME: "Alice Chen"});
  let clock = 0;
  b.context.Date = {now: () => clock += 10000};
  b.context.setTimeout = callback => callback();
  const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
  assert.equal(identity.fb_name, "Alice Chen");
  assert.equal(identity.fb_id, null);
  assert.match(identity.identity_error, /未读取到主页 ID/);
});

test("failed homepage extraction retries profile in the same temporary tab", async () => {
  const b = bridge("input");
  let reads = 0;
  b.chrome.scripting.executeScript = async () => {
    if (++reads <= 2) throw new Error("profile metadata unavailable");
    return [{result: b.identity}];
  };
  const identity = await vm.runInContext("getFBIdentity()", b.context);
  assert.equal(identity.fb_name, "Test Account");
  assert.deepEqual(b.navigated.map(item => item.options.url), ["https://www.facebook.com/", "https://www.facebook.com/me"]);
  assert.equal(b.created.length, 1);
  assert.deepEqual(b.removed, [99]);
});

test("legacy homepage profile link provides name, ID and SVG avatar", async () => {
  const b = bridge("input");
  b.context.location = {href: "https://www.facebook.com/"};
  const image = {getAttribute: name => name === "xlink:href" ? "https://scontent.example.fbcdn.net/alice.jpg" : null};
  const link = {href: "https://www.facebook.com/profile.php?id=123", getAttribute: () => "Alice Chen",
    closest: selector => selector === '[role="navigation"], [role="banner"]' ? {} : null,
    querySelector: () => image};
  b.context.document = {title: "Facebook", querySelector: () => null,
    querySelectorAll: selector => selector === 'a[aria-label][href]' ? [link] : []};
  b.chrome.scripting.executeScript = async options => [{result: await options.func()}];
  const identity = await vm.runInContext("readProfileIdentity(99)", b.context);
  assert.equal(identity.fb_name, "Alice Chen");
  assert.equal(identity.fb_id, "123");
  assert.equal(identity.avatar_url, "https://scontent.example.fbcdn.net/alice.jpg");
});

test("isolated-world fallback still reads identity when main-world injection fails", async () => {
  const b = bridge("input");
  const worlds = [];
  b.chrome.scripting.executeScript = async options => {
    worlds.push(options.world);
    if (options.world === "MAIN") throw new Error("main world unavailable");
    return [{result: b.identity}];
  };
  assert.equal((await vm.runInContext("readProfileIdentity(99)", b.context)).fb_id, "123");
  assert.deepEqual(worlds, ["MAIN", "ISOLATED"]);
});

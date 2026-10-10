const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const folder = path.join(__dirname, "../WS Browser Bridge");
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup(kind) {
  let now = 20000, next = 0;
  const jobs = new Map(), clicks = [], keys = [];
  const clock = {
    setTimeout(fn, ms) { const id = ++next; jobs.set(id, {fn, at: now + ms}); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const job = [...jobs].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!job) break;
        now = job[1].at; jobs.delete(job[0]); job[1].fn(); await flush();
      }
      now = until; await flush();
    }
  };
  const document = {hidden: false, activeElement: null, articles: [], overlays: []};
  class Node {
    constructor(type, label = "") { this.type = type; this.innerText = label; this.attributes = {}; this.children = []; this.isConnected = true; }
    add(node) { this.children.push(node); node.parentElement = this; return node; }
    getAttribute(name) { return this.attributes[name] || null; }
    getBoundingClientRect() { return {width: 100, height: 30, top: 100, bottom: 130}; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest(selector) { let node = this; while (node) { if (selector.includes(`role="${node.type}"`)) return node; node = node.parentElement; } return null; }
    matches() { return this.type === "editor"; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    click() { clicks.push(this.innerText); this.onclick?.(); }
    dispatchEvent(event) { keys.push(event.type); if (event.type === "keydown") this.innerText = ""; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.descendants()]);
      if (selector === 'a[href]') return all.filter(child => child.type === "anchor");
      if (selector === "*") return all;
      if (selector.includes('role="heading"')) return all.filter(child => child.type === "heading");
      if (selector.includes("textbox")) return all.filter(child => child.type === "editor");
      return all.filter(child => child.type === "button");
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  }
  document.querySelectorAll = selector => {
    if (selector === '[role="article"]') return document.articles;
    if (selector.includes('role="dialog"')) return document.overlays;
    return document.articles.flatMap(article => article.querySelectorAll(selector));
  };
  document.execCommand = (cmd, _unused, value) => { document.activeElement.innerText = cmd === "delete" ? "" : value; return true; };
  document.createRange = () => ({selectNodeContents() {}});
  const article = new Node("article"); document.articles.push(article);
  const anchor = article.add(new Node("anchor"));
  anchor.href = kind === "join" ? "https://www.facebook.com/groups/testgroup/" : "https://www.facebook.com/alice/posts/123";
  const button = article.add(new Node("button", {like: "Like", comment: "Comment", share: "Share", join: "Join group"}[kind]));
  const window = {__fbActivityRequest: {mode: "home", runId: "run-1"}, addEventListener() {}, removeEventListener() {}, getSelection: () => ({removeAllRanges() {}, addRange() {}})};
  const context = vm.createContext({...clock, Date: {now: () => now}, Math: {random: () => 0, floor: Math.floor},
    window, document, location: {pathname: "/", href: "https://www.facebook.com/"}, innerHeight: 700, innerWidth: 1000, URL,
    getComputedStyle: node => ({position: "fixed", overflowY: node.scrollable ? "auto" : "visible"}),
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    chrome: {runtime: {sendMessage: async () => {}}}});
  for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
    vm.runInContext(fs.readFileSync(path.join(folder, file), "utf8"), context);
  }
  const ctrl = window.__fbActivityRuntime.create("home");
  const interactions = window.__fbActivityInteractions(ctrl);
  const start = async () => { await clock.advance(45000); return {promise: interactions.maybeInteract([kind])}; };
  return {clock, jobs, clicks, keys, Node, article, anchor, button, window, document, ctrl, interactions, start};
}
test("likes have a cooldown, a budget and stable-post deduplication", async () => {
  const p = setup("like"), {promise} = await p.start();
  await p.clock.advance(4000); assert.equal(await promise, true);
  assert.deepEqual(p.clicks, ["Like"]);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
  const replacement = p.article.add(new p.Node("button", "Like"));
  p.button.isConnected = false;
  await p.clock.advance(100000);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
  assert.equal(p.interactions.counts.like, 1);
  assert.ok(replacement.isConnected);
});
test("already-liked buttons are never toggled off, including state changes during the wait", async () => {
  const p = setup("like"), {promise} = await p.start();
  p.button.attributes["aria-pressed"] = "true";
  await p.clock.advance(4000); assert.equal(await promise, false);
  assert.equal(p.clicks.length, 0);
});
test("the per-session like budget applies even to different posts", async () => {
  const p = setup("like"), first = await p.start();
  await p.clock.advance(4000); await first.promise;
  p.anchor.href = "https://www.facebook.com/alice/posts/456";
  p.button.isConnected = false;
  p.article.add(new p.Node("button", "Like"));
  await p.clock.advance(90000);
  const second = p.interactions.maybeInteract(["like"]);
  await p.clock.advance(4000); assert.equal(await second, true);
  p.anchor.href = "https://www.facebook.com/alice/posts/789";
  p.article.add(new p.Node("button", "Like"));
  await p.clock.advance(90000);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
  assert.equal(p.clicks.length, 2);
});

test("updated feed budgets and shorter cooldown allow three distinct likes", async () => {
  const p = setup("like");
  assert.deepEqual({...p.interactions.limits}, {like: 3, comment: 2, share: 2, join: 1});
  for (let i = 0; i < 3; i++) {
    p.anchor.href = `https://www.facebook.com/alice/posts/${i}`;
    if (i) { p.button.isConnected = false; p.button = p.article.add(new p.Node("button", "Like")); }
    await p.clock.advance(i ? 60000 : 30000);
    const attempt = p.interactions.maybeInteract(["like"]);
    await p.clock.advance(4000);
    assert.equal(await attempt, true);
  }
  await p.clock.advance(60000);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
  assert.equal(p.clicks.length, 3);
});

for (const label of ["Post comment", "发表评论", "發佈留言"]) {
  test(`${label}: explicit submit button is clicked once, without Enter`, async () => {
    const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
    const send = p.article.add(new p.Node("button", label));
    send.onclick = () => { editor.innerText = ""; };
    const {promise} = await p.start(); await p.clock.advance(10000);
    assert.equal(await promise, true);
    assert.deepEqual(p.clicks, ["Comment", label]);
    assert.equal(p.keys.length, 0);
    assert.equal(p.ctrl.canAct(), true);
  });
}

test("ignored Enter clears only the automation draft and resumes browsing without retry", async () => {
  const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
  editor.isContentEditable = true;
  editor.dispatchEvent = event => p.keys.push(event.type);
  const {promise} = await p.start(); await p.clock.advance(15000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "");
  assert.deepEqual(p.keys.filter(type => type === "keydown"), ["keydown"]);
  assert.equal(p.ctrl.canAct(), true);
});

test("an unrelated dialog during comment submission does not strand our draft", async () => {
  const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
  editor.isContentEditable = true;
  editor.dispatchEvent = event => { if (event.type === "keydown") p.document.overlays.push(new p.Node("dialog", "User settings")); };
  const {promise} = await p.start(); await p.clock.advance(15000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "");
  assert.equal(p.document.overlays.length, 1);
  p.document.overlays = [];
  assert.equal(p.ctrl.canAct(), true);
});

test("failed comments close their own empty overlay, never a pre-existing user dialog", async () => {
  const p = setup("comment"), dialog = new p.Node("dialog");
  const editor = dialog.add(new p.Node("editor")); editor.isContentEditable = true;
  editor.dispatchEvent = () => {};
  const close = dialog.add(new p.Node("button", "Close"));
  close.onclick = () => { dialog.isConnected = false; p.document.overlays = []; };
  p.button.onclick = () => p.document.overlays.push(dialog);
  const {promise} = await p.start(); await p.clock.advance(15000);
  assert.equal(await promise, false);
  assert.deepEqual(p.clicks, ["Comment", "Close"]);
  assert.equal(p.ctrl.canAct(), true);
});

test("a chat appearing during Comment is never adopted as the comment editor", async () => {
  const p = setup("comment"), chat = new p.Node("dialog");
  const editor = chat.add(new p.Node("editor"));
  chat.add(new p.Node("button", "Close chat"));
  chat.add(new p.Node("button", "Send"));
  p.button.onclick = () => p.document.overlays.push(chat);
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "");
  assert.deepEqual(p.clicks, ["Comment"]);
});

for (const closeLabel of ["Close chat", "关闭聊天", "關閉聊天室"]) {
  test(`${closeLabel}: closes an empty chat before feed activity`, () => {
    const p = setup("like"), chat = new p.Node("dialog");
    const close = chat.add(new p.Node("button", closeLabel));
    close.onclick = () => { chat.isConnected = false; p.document.overlays = []; };
    p.document.overlays = [chat];
    const original = p.document.querySelectorAll;
    p.document.querySelectorAll = selector => selector.includes('role="dialog"') ? p.document.overlays : [...original(selector), close];
    p.interactions.maintainPage();
    assert.deepEqual(p.clicks, [closeLabel]);
    assert.equal(p.ctrl.canAct(), true);
  });
}

test("chat drafts and recent manual interaction are not discarded", () => {
  const p = setup("like"), chat = new p.Node("dialog");
  const editor = chat.add(new p.Node("editor", "My chat draft"));
  const close = chat.add(new p.Node("button", "Close chat"));
  const original = p.document.querySelectorAll;
  p.document.querySelectorAll = selector => [...original(selector), close];
  p.interactions.maintainPage();
  assert.equal(p.clicks.length, 0); assert.equal(editor.innerText, "My chat draft");
  editor.innerText = ""; p.ctrl.lastInput = 20000;
  p.interactions.maintainPage(); assert.equal(p.clicks.length, 0);
});

for (const label of ["Notifications", "通知", "通知訊息"]) {
  test(`${label}: opens, scrolls a few items and closes without following notification links`, async () => {
    const p = setup("like"), trigger = new p.Node("button", label), panel = new p.Node("dialog", label);
    let scrolls = 0;
    panel.scrollable = true; panel.scrollHeight = 1000; panel.clientHeight = 200;
    panel.scrollBy = () => scrolls++;
    trigger.onclick = () => {
      const open = trigger.attributes["aria-expanded"] !== "true";
      trigger.attributes["aria-expanded"] = String(open);
      p.document.overlays = open ? [panel] : []; panel.isConnected = open;
    };
    const original = p.document.querySelectorAll;
    p.document.querySelectorAll = selector => selector.includes('role="banner"') ? [trigger] : original(selector);
    await p.clock.advance(45000);
    const attempt = p.interactions.maybeNotifications();
    await p.clock.advance(10000);
    assert.equal(await attempt, true);
    assert.equal(scrolls, 2); assert.deepEqual(p.clicks, [label, label]);
    assert.equal(p.ctrl.canAct(), true);
    assert.equal(await p.interactions.maybeNotifications(), false);
  });
}

test("Stop during notification browsing cancels pending scrolling and clicks", async () => {
  const p = setup("like"), trigger = new p.Node("button", "Notifications"), panel = new p.Node("dialog", "Notifications");
  trigger.onclick = () => { p.document.overlays = [panel]; trigger.attributes["aria-expanded"] = "true"; };
  const original = p.document.querySelectorAll;
  p.document.querySelectorAll = selector => selector.includes('role="banner"') ? [trigger] : original(selector);
  await p.clock.advance(45000);
  const attempt = p.interactions.maybeNotifications().catch(error => error);
  await p.clock.advance(1000); p.ctrl.stop(); await p.clock.advance(10000);
  assert.equal((await attempt).name, "AbortError");
  assert.deepEqual(p.clicks, ["Notifications"]); assert.equal(p.jobs.size, 0);
});
test("comments submit once and never overwrite an existing draft", async () => {
  const p = setup("comment");
  const editor = p.article.add(new p.Node("editor"));
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true);
  assert.deepEqual(p.keys, ["keydown", "keyup"]);
  assert.equal(p.document.activeElement, null);
  const draft = setup("comment");
  draft.article.add(new draft.Node("editor", "My draft"));
  const attempt = await draft.start(); await draft.clock.advance(10000); await attempt.promise;
  assert.equal(draft.clicks.length, 0);
});
test("stop during comment composition prevents Enter and cancels every wait", async () => {
  const p = setup("comment"); p.article.add(new p.Node("editor"));
  const attempt = await p.start();
  const outcome = attempt.promise.catch(error => error);
  await p.clock.advance(2500);
  p.window.__fbActivityRuntime.stop();
  await p.clock.advance(10000);
  assert.equal((await outcome).name, "AbortError");
  assert.equal(p.keys.length, 0); assert.equal(p.jobs.size, 0);
});
test("manual input during composition prevents submission and preserves the draft", async () => {
  const p = setup("comment"); const editor = p.article.add(new p.Node("editor"));
  const {promise} = await p.start(); await p.clock.advance(2500);
  p.ctrl.lastInput = 67500; editor.innerText = "My new draft";
  await p.clock.advance(10000); assert.equal(await promise, false);
  assert.equal(p.keys.length, 0); assert.equal(editor.innerText, "My new draft");
});
test("share only follows its newly-opened story menu and composer", async () => {
  const p = setup("share");
  const menu = new p.Node("menu"), composer = new p.Node("dialog");
  const story = menu.add(new p.Node("button", "Share to your story"));
  composer.add(new p.Node("button", "Share"));
  p.button.onclick = () => p.clock.setTimeout(() => p.document.overlays.push(menu), 300);
  story.onclick = () => { p.document.overlays = []; p.clock.setTimeout(() => p.document.overlays.push(composer), 500); };
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true);
  assert.deepEqual(p.clicks, ["Share", "Share to your story", "Share"]);
});
test("stop after opening Share prevents clicking its story option", async () => {
  const p = setup("share"), menu = new p.Node("menu");
  menu.add(new p.Node("button", "Share to your story"));
  p.button.onclick = () => p.document.overlays.push(menu);
  const attempt = await p.start(); const outcome = attempt.promise.catch(error => error);
  await p.clock.advance(1000);
  p.window.__fbActivityRuntime.stop();
  await p.clock.advance(10000);
  assert.equal((await outcome).name, "AbortError");
  assert.deepEqual(p.clicks, ["Share"]);
  assert.equal(p.jobs.size, 0);
});
test("join clicks once and does not answer a group's membership questions", async () => {
  const p = setup("join"), question = new p.Node("dialog");
  question.add(new p.Node("editor", "Membership question"));
  p.button.onclick = () => p.document.overlays.push(question);
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true); assert.deepEqual(p.clicks, ["Join group"]);
  assert.equal(p.keys.length, 0);
  assert.equal(await p.interactions.maybeInteract(["join"]), false);
});
test("pre-existing dialogs and offscreen targets are not clicked", async () => {
  const p = setup("share"); p.document.overlays.push(new p.Node("dialog"));
  const {promise} = await p.start(); assert.equal(await promise, false);
  assert.equal(p.clicks.length, 0);
  const offscreen = setup("like");
  offscreen.button.getBoundingClientRect = () => ({width: 100, height: 30, top: 1000, bottom: 1030});
  const attempt = await offscreen.start(); assert.equal(await attempt.promise, false);
});

for (const labels of [
  {like: "点赞", comment: "评论", share: "分享", story: "分享到你的快拍", publish: "发布", join: "加入小组", liked: "已点赞"},
  {like: "按讚", comment: "留言", share: "分享", story: "分享至你的限時動態", publish: "發佈", join: "加入社團", liked: "已讚"},
  {like: "點讚", comment: "評論", share: "分享", story: "分享到限時動態", publish: "發表", join: "加入小組", liked: "已點讚"}
]) {
  for (const kind of ["like", "comment", "share", "join"]) test(`${labels[kind]}: localized interaction`, async () => {
    const p = setup(kind);
    p.button.innerText = labels[kind];
    if (kind === "comment") p.article.add(new p.Node("editor"));
    if (kind === "share") {
      const menu = new p.Node("menu"), composer = new p.Node("dialog");
      const story = menu.add(new p.Node("button", labels.story));
      composer.add(new p.Node("button", labels.publish));
      p.button.onclick = () => p.document.overlays.push(menu);
      story.onclick = () => { p.document.overlays = [composer]; };
    }
    const {promise} = await p.start();
    await p.clock.advance(10000);
    assert.equal(await promise, true);
    assert.equal(p.clicks[0], labels[kind]);
    if (kind === "share") assert.deepEqual(p.clicks, [labels.share, labels.story, labels.publish]);
    if (kind === "comment") assert.deepEqual(p.keys, ["keydown", "keyup"]);
  });
  test(`${labels.liked}: aria Like does not toggle a localized liked button`, async () => {
    const p = setup("like");
    p.button.innerText = labels.liked;
    p.button.attributes["aria-label"] = "Like";
    const {promise} = await p.start();
    assert.equal(await promise, false);
    assert.equal(p.clicks.length, 0);
  });
}

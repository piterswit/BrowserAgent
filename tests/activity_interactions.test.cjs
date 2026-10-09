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
    closest() { let node = this; while (node && node.type !== "article") node = node.parentElement; return node; }
    matches() { return this.type === "editor"; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    click() { clicks.push(this.innerText); this.onclick?.(); }
    dispatchEvent(event) { keys.push(event.type); if (event.type === "keydown") this.innerText = ""; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.descendants()]);
      if (selector === 'a[href]') return all.filter(child => child.type === "anchor");
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
  document.execCommand = (_cmd, _unused, value) => { document.activeElement.innerText = value; return true; };
  const article = new Node("article"); document.articles.push(article);
  const anchor = article.add(new Node("anchor"));
  anchor.href = kind === "join" ? "https://www.facebook.com/groups/testgroup/" : "https://www.facebook.com/alice/posts/123";
  const button = article.add(new Node("button", {like: "Like", comment: "Comment", share: "Share", join: "Join group"}[kind]));
  const window = {__fbActivityRequest: {mode: "home", runId: "run-1"}, addEventListener() {}, removeEventListener() {}};
  const context = vm.createContext({...clock, Date: {now: () => now}, Math: {random: () => 0, floor: Math.floor},
    window, document, location: {pathname: "/", href: "https://www.facebook.com/"}, innerHeight: 700, URL,
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

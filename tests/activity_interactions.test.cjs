const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const folder = path.join(__dirname, "../WS Browser Bridge");
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup(kind, mode = "home") {
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
  const document = {hidden: false, activeElement: null, articles: [], overlays: [], alerts: []};
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
      if (selector.startsWith('[data-ad-rendering-role="')) return all.filter(child =>
        child.attributes["data-ad-rendering-role"] === selector.match(/="([^"]+)"/)[1]);
      if (selector === '[id="focused-state-composer-submit"]') return all.filter(child =>
        child.attributes.id === "focused-state-composer-submit");
      if (selector === "*") return all;
      if (selector.includes('role="article"')) return all.filter(child => child.type === "article");
      if (selector.includes('role="heading"')) return all.filter(child => child.type === "heading");
      if (selector.includes("textbox") || selector.includes("contenteditable")) return all.filter(child => child.type === "editor");
      return all.filter(child => child.type === "button");
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  }
  document.querySelectorAll = selector => {
    if (selector === '[role="article"]') return document.articles;
    if (selector.includes('role="alert"')) return document.alerts;
    if (selector.includes('role="dialog"')) return document.overlays;
    return document.articles.flatMap(article => article.querySelectorAll(selector));
  };
  document.execCommand = (cmd, _unused, value) => { document.activeElement.innerText = cmd === "delete" ? "" : value; return true; };
  document.createRange = () => ({selectNodeContents() {}});
  const article = new Node("article"); document.articles.push(article);
  const anchor = article.add(new Node("anchor"));
  anchor.href = kind === "join" ? "https://www.facebook.com/groups/testgroup/" : "https://www.facebook.com/alice/posts/123";
  const button = article.add(new Node("button", {like: "Like", comment: "Comment", share: "Share", join: "Join group"}[kind]));
  const window = {__fbActivityRequest: {mode, runId: "run-1"}, addEventListener() {}, removeEventListener() {}, getSelection: () => ({removeAllRanges() {}, addRange() {}})};
  const context = vm.createContext({...clock, Date: {now: () => now}, Math: {random: () => 0, floor: Math.floor},
    window, document, location: {pathname: "/", href: "https://www.facebook.com/"}, innerHeight: 700, innerWidth: 1000, URL,
    getComputedStyle: node => ({position: node.style?.position || "fixed", overflowY: node.scrollable ? "auto" : "visible"}),
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    chrome: {runtime: {sendMessage: async () => {}}}});
  for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
    vm.runInContext(fs.readFileSync(path.join(folder, file), "utf8"), context);
  }
  const ctrl = window.__fbActivityRuntime.create(mode);
  const interactions = window.__fbActivityInteractions(ctrl);
  const start = async () => { await clock.advance(45000); return {promise: interactions.maybeInteract([kind])}; };
  return {clock, jobs, clicks, keys, Node, article, anchor, button, window, document, location: context.location, ctrl, interactions, start};
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
  const third = p.interactions.maybeInteract(["like"]);
  await p.clock.advance(4000); assert.equal(await third, true);
  assert.equal(p.clicks.length, 3);
  await p.clock.advance(45000);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
});

test("updated feed budgets and shorter cooldown allow three distinct likes", async () => {
  const p = setup("like");
  assert.deepEqual({...p.interactions.limits}, {like: 3, comment: 2, share: 1, join: 1});
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

test("home distributes six eligible interactions as three likes, two comments and one share within five minutes", async () => {
  const p = setup("like"), order = [];
  const menu = new p.Node("menu"), composer = new p.Node("dialog");
  const story = menu.add(new p.Node("button", "Share to your story (Friends)"));
  const publish = composer.add(new p.Node("button", "Share"));
  story.onclick = () => { p.document.overlays = [composer]; };
  publish.onclick = () => {
    p.document.overlays = [];
    p.document.alerts.push(new p.Node("alert", "Your story was shared"));
  };
  let previous = [];
  for (let i = 0; i < 6; i++) {
    for (const node of previous) node.isConnected = false;
    p.button.isConnected = false;
    p.anchor.href = `https://www.facebook.com/alice/posts/test-${i}`;
    const like = p.article.add(new p.Node("button", "Like"));
    const comment = p.article.add(new p.Node("button", "Comment"));
    const share = p.article.add(new p.Node("button", "Share"));
    const editor = p.article.add(new p.Node("editor"));
    previous = [like, comment, share, editor];
    like.onclick = () => { order.push("like"); like.attributes["aria-pressed"] = "true"; };
    comment.onclick = () => order.push("comment");
    share.onclick = () => { order.push("share"); p.document.overlays = [menu]; };
    await p.clock.advance(25000);
    const attempt = p.interactions.maybeInteract();
    await p.clock.advance(10000); await attempt;
  }
  assert.deepEqual(order, ["like", "comment", "like", "share", "comment", "like"]);
  assert.deepEqual({...p.ctrl.stats.confirmed}, {like: 3, comment: 2, share: 1});
  assert.equal(p.ctrl.run, true);
  await p.clock.advance(45000);
  assert.equal(await p.interactions.maybeInteract(), false);
  assert.deepEqual({...p.ctrl.stats.confirmed}, {like: 3, comment: 2, share: 1});
});

for (const mode of ["group", "custom", "reels"]) {
  test(`${mode}: home quotas do not change other mode limits`, () => {
    const p = setup("like", mode);
    assert.equal(p.interactions.limits.share, 2);
    assert.equal(p.interactions.limits.like, mode === "reels" ? 2 : 3);
  });
}

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
    assert.equal(p.ctrl.stats.attempted.comment, 1);
    assert.equal(p.ctrl.stats.confirmed.comment, 1);
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
  assert.equal(p.ctrl.stats.attempted.comment, 1);
  assert.equal(p.ctrl.stats.confirmed.comment, 0);
});

test("like telemetry separates confirmed state changes from uncertain clicks", async () => {
  for (const confirmed of [false, true]) {
    const p = setup("like");
    if (confirmed) p.button.onclick = () => { p.button.attributes["aria-pressed"] = "true"; };
    const {promise} = await p.start(); await p.clock.advance(4000); await promise;
    assert.equal(p.ctrl.stats.attempted.like, 1);
    assert.equal(p.ctrl.stats.confirmed.like, Number(confirmed));
  }
});

for (const mode of ["home", "group", "custom", "reels"]) {
  test(`${mode}: hidden-page interaction policy is consistent with runtime`, async () => {
    const p = setup("like", mode); p.document.hidden = true;
    p.button.onclick = () => { p.button.attributes["aria-pressed"] = "true"; };
    const {promise} = await p.start(); await p.clock.advance(4000);
    assert.equal(await promise, false);
    assert.equal(p.ctrl.stats.confirmed.like, 0);
    assert.equal(p.ctrl.state, "等待中");
    p.document.hidden = false; await p.clock.advance(5000);
    const resumed = p.interactions.maybeInteract(["like"]);
    await p.clock.advance(4000); assert.equal(await resumed, true);
    assert.equal(p.ctrl.stats.confirmed.like, 1);
  });
}

test("home defers exact-draft cleanup until visibility returns without resubmission", async () => {
  const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
  editor.isContentEditable = true;
  editor.dispatchEvent = event => {
    if (event.type === "keydown") { p.document.hidden = true; p.ctrl.lastInput = 70000; }
  };
  const {promise} = await p.start(); await p.clock.advance(15000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "Thanks for sharing!");
  assert.equal(p.ctrl.state, "等待中");
  p.interactions.maintainPage(); assert.equal(editor.innerText, "Thanks for sharing!");
  p.document.hidden = false; p.interactions.maintainPage();
  assert.equal(editor.innerText, "");
  assert.equal(p.document.activeElement, null);
  assert.equal(p.ctrl.canAct(), true);
  assert.equal(p.ctrl.stats.attempted.comment, 1);
  assert.equal(p.ctrl.stats.confirmed.comment, 0);
});

for (const interruptedBy of ["edit", "stop", "navigation", "expiry"]) {
  test(`deferred draft cleanup preserves content after ${interruptedBy}`, async () => {
    const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
    editor.isContentEditable = true;
    editor.dispatchEvent = event => { p.keys.push(event.type); if (event.type === "keydown") p.document.hidden = true; };
    const {promise} = await p.start(); await p.clock.advance(15000);
    assert.equal(await promise, false);
    if (interruptedBy === "edit") editor.innerText = "An edited draft";
    else if (interruptedBy === "stop") p.ctrl.stop();
    else if (interruptedBy === "navigation") p.location.pathname = "/different/";
    else p.ctrl.deadline = 0;
    p.document.hidden = false; p.interactions.maintainPage();
    assert.equal(editor.innerText, interruptedBy === "edit" ? "An edited draft" : "Thanks for sharing!");
    assert.equal(p.ctrl.stats.attempted.comment, 1);
    assert.equal(p.keys.filter(type => type === "keydown").length, 1);
  });
}

test("a delayed like state is confirmed without a second click", async () => {
  const p = setup("like");
  p.button.onclick = () => p.clock.setTimeout(() => { p.button.innerText = "Unlike"; }, 2400);
  const {promise} = await p.start(); await p.clock.advance(4000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.confirmed.like, 1);
  assert.deepEqual(p.clicks, ["Like"]);
});

test("a replaced like button on the same post can confirm the click", async () => {
  const p = setup("like");
  p.button.onclick = () => {
    p.button.isConnected = false;
    p.article.add(new p.Node("button", "已讚"));
  };
  const {promise} = await p.start(); await p.clock.advance(4000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.confirmed.like, 1);
  assert.deepEqual(p.clicks, ["Like"]);
});

test("a replaced post is followed only by its stable identity", async () => {
  for (const samePost of [false, true]) {
    const p = setup("like");
    p.button.onclick = () => {
      p.article.isConnected = false; p.button.isConnected = false;
      const replacement = new p.Node("article");
      const anchor = replacement.add(new p.Node("anchor"));
      anchor.href = samePost ? p.anchor.href : "https://www.facebook.com/alice/posts/456";
      replacement.add(new p.Node("button", "Liked"));
      p.document.articles = [replacement];
    };
    const {promise} = await p.start(); await p.clock.advance(4000);
    assert.equal(await promise, true);
    assert.equal(p.ctrl.stats.confirmed.like, Number(samePost));
    assert.equal(p.clicks.length, 1);
  }
});

test("ambiguous replacement actions do not confirm a like", async () => {
  const p = setup("like");
  p.button.onclick = () => {
    p.button.isConnected = false;
    p.article.add(new p.Node("button", "Liked"));
    p.article.add(new p.Node("button", "Like"));
  };
  const {promise} = await p.start(); await p.clock.advance(4000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.confirmed.like, 0);
  assert.equal(p.clicks.length, 1);
});

test("Stop cancels delayed like confirmation", async () => {
  const p = setup("like");
  const {promise} = await p.start();
  const outcome = promise.catch(error => error);
  await p.clock.advance(1000); p.ctrl.stop();
  p.button.innerText = "Liked";
  await p.clock.advance(4000);
  assert.equal((await outcome).name, "AbortError");
  assert.equal(p.ctrl.stats.confirmed.like, 0);
  assert.equal(p.jobs.size, 0);
});

test("an empty target scan retries soon instead of consuming the action cooldown", async () => {
  const p = setup("like");
  p.button.isConnected = false;
  await p.clock.advance(30000);
  assert.equal(await p.interactions.maybeInteract(["like"]), false);
  assert.match(p.ctrl.stats.issue, /互动按钮/);
  p.button.isConnected = true;
  await p.clock.advance(5000);
  const attempt = p.interactions.maybeInteract(["like"]);
  await p.clock.advance(4000);
  assert.equal(await attempt, true);
  assert.equal(p.ctrl.stats.attempted.like, 1);
  assert.equal(p.ctrl.stats.issue, "");
});

test("visible text matches even when aria describes the action differently", async () => {
  const p = setup("like");
  p.button.attributes["aria-label"] = "React to this post";
  p.button.innerText = "按讚";
  const {promise} = await p.start(); await p.clock.advance(4000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.attempted.like, 1);
});

test("aria Unlike vetoes Like text and never removes an existing like", async () => {
  const p = setup("like");
  p.button.attributes["aria-label"] = "Unlike";
  const {promise} = await p.start();
  assert.equal(await promise, false);
  assert.equal(p.clicks.length, 0);
});

test("icon-only like markers require an explicit unliked state on the clickable wrapper", async () => {
  for (const state of [null, "false", "true"]) {
    const p = setup("like");
    p.button.innerText = "4";
    const icon = p.button.add(new p.Node("marker"));
    icon.attributes["data-ad-rendering-role"] = "like_button";
    if (state !== null) p.button.attributes["aria-pressed"] = state;
    p.button.onclick = () => { p.button.attributes["aria-pressed"] = "true"; };
    const {promise} = await p.start(); await p.clock.advance(4000);
    assert.equal(await promise, state === "false");
    assert.deepEqual(p.clicks, state === "false" ? ["4"] : []);
    assert.equal(p.ctrl.stats.confirmed.like, Number(state === "false"));
    if (state === null) assert.match(p.ctrl.stats.issue, /缺少已赞／未赞状态/);
  }
});

test("bare rendering markers without a button wrapper are never clicked", async () => {
  const p = setup("comment"); p.button.isConnected = false;
  const icon = p.article.add(new p.Node("marker"));
  icon.attributes["data-ad-rendering-role"] = "comment_button";
  const {promise} = await p.start();
  assert.equal(await promise, false);
  assert.equal(p.clicks.length, 0);
});

test("icon comment opens its editor and finds the deeply nested composer submit", async () => {
  const p = setup("comment"); p.button.innerText = "";
  const icon = p.button.add(new p.Node("marker"));
  icon.attributes["data-ad-rendering-role"] = "comment_button";
  const composer = p.article.add(new p.Node("container"));
  let parent = composer;
  for (let i = 0; i < 5; i++) parent = parent.add(new p.Node("container"));
  const editor = parent.add(new p.Node("editor"));
  const submit = composer.add(new p.Node("container"));
  submit.attributes.id = "focused-state-composer-submit";
  const send = submit.add(new p.Node("button")); send.attributes["aria-label"] = "Post comment";
  send.onclick = () => { editor.innerText = ""; };
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.confirmed.comment, 1);
  assert.equal(p.clicks.length, 2);
  assert.equal(p.keys.length, 0);
});

for (const storyLabel of ["Share to your story (Friends)", "分享至你的限時動態（朋友）", "分享到你的快拍 (好友)"]) {
  test(`${storyLabel}: icon share selects story, never Feed or Messenger`, async () => {
    const p = setup("share"); p.button.innerText = "";
    const icon = p.button.add(new p.Node("marker"));
    icon.attributes["data-ad-rendering-role"] = "share_button";
    const menu = new p.Node("menu"), composer = new p.Node("dialog");
    menu.add(new p.Node("button", "Share to Feed"));
    const story = menu.add(new p.Node("button", storyLabel));
    menu.add(new p.Node("button", "Send in Messenger"));
    const publish = composer.add(new p.Node("button", "Share"));
    publish.onclick = () => { p.document.alerts.push(new p.Node("alert", "Your story was shared")); };
    p.button.onclick = () => { p.document.overlays = [menu]; };
    story.onclick = () => { p.document.overlays = [composer]; };
    const {promise} = await p.start(); await p.clock.advance(10000);
    assert.equal(await promise, true);
    assert.deepEqual(p.clicks, ["", storyLabel, "Share"]);
    assert.equal(p.ctrl.stats.confirmed.share, 1);
  });
}

test("story matching does not accept unrelated trailing instructions", async () => {
  const p = setup("share"), menu = new p.Node("menu");
  menu.add(new p.Node("button", "Share to your story and send in Messenger"));
  p.button.onclick = () => { p.document.overlays = [menu]; };
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true);
  assert.deepEqual(p.clicks, ["Share"]);
  assert.equal(p.ctrl.stats.attempted.share, 0);
});

test("unrecognized post layout is retained as the final zero-action reason", async () => {
  const p = setup("like");
  p.document.articles = [];
  const {promise} = await p.start();
  assert.equal(await promise, false);
  assert.match(p.ctrl.stats.issue, /帖子容器/);
  p.ctrl.stop();
  assert.match(p.window.__fbActivityLastSnapshot.stats.issue, /帖子容器/);
});

test("share telemetry requires a new success notice, not an old one", async () => {
  for (const fresh of [false, true]) {
    const p = setup("share"), menu = new p.Node("menu"), composer = new p.Node("dialog");
    const story = menu.add(new p.Node("button", "Share to your story"));
    const publish = composer.add(new p.Node("button", "Share"));
    const notice = new p.Node("alert", "Your story was shared");
    if (!fresh) p.document.alerts = [notice];
    publish.onclick = () => { composer.isConnected = false; p.document.overlays = []; p.document.alerts = [notice]; };
    p.button.onclick = () => { p.document.overlays = [menu]; };
    story.onclick = () => { p.document.overlays = [composer]; };
    const {promise} = await p.start(); await p.clock.advance(10000); await promise;
    assert.equal(p.ctrl.stats.attempted.share, 1);
    assert.equal(p.ctrl.stats.confirmed.share, Number(fresh));
  }
});

test("missing comment editor does not spend the submit budget for a different post", async () => {
  const p = setup("comment");
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, false);
  assert.equal(p.interactions.counts.comment, 0);
  assert.match(p.ctrl.stats.issues.comment, /未找到可见的评论框/);
  p.anchor.href = "https://www.facebook.com/alice/posts/other";
  p.button.isConnected = false;
  p.article.add(new p.Node("button", "Comment"));
  p.article.add(new p.Node("editor"));
  await p.clock.advance(45000);
  const next = p.interactions.maybeInteract(["comment"]);
  await p.clock.advance(10000); assert.equal(await next, true);
  assert.equal(p.interactions.counts.comment, 1);
  assert.equal(p.ctrl.stats.confirmed.comment, 1);
  assert.equal(p.ctrl.stats.issues.comment, undefined);
});

test("an unsubmitted comment target can be retried in a new run", async () => {
  const p = setup("comment"), first = await p.start();
  await p.clock.advance(10000); assert.equal(await first.promise, false);
  assert.equal(p.window.__fbInteractionHistory.size, 0);
  p.ctrl.stop(); p.article.add(new p.Node("editor"));
  p.window.__fbActivityRequest = {mode: "home", runId: "second"};
  const ctrl = p.window.__fbActivityRuntime.create("home");
  const actions = p.window.__fbActivityInteractions(ctrl);
  await p.clock.advance(25000); const retry = actions.maybeInteract(["comment"]);
  await p.clock.advance(10000); assert.equal(await retry, true);
  assert.equal(ctrl.stats.confirmed.comment, 1);
});

test("a recycled DOM button can act on a different stable post identity", async () => {
  const p = setup("comment"); p.article.add(new p.Node("editor"));
  const first = await p.start(); await p.clock.advance(10000); await first.promise;
  p.anchor.href = "https://www.facebook.com/alice/posts/recycled";
  await p.clock.advance(45000); const next = p.interactions.maybeInteract(["comment"]);
  await p.clock.advance(10000); assert.equal(await next, true);
  assert.equal(p.ctrl.stats.confirmed.comment, 2);
});

for (const label of ["Confirm your identity", "登录验证", "安全檢查"]) {
  test(`${label}: a verification dialog opened during Comment is never edited or closed`, async () => {
    const p = setup("comment"), popup = new p.Node("dialog", label);
    const editor = popup.add(new p.Node("editor"));
    popup.add(new p.Node("button", "Post comment")); popup.add(new p.Node("button", "Close"));
    p.button.onclick = () => { p.document.overlays = [popup]; };
    const {promise} = await p.start(); await p.clock.advance(10000);
    assert.equal(await promise, false);
    p.interactions.maintainPage();
    assert.equal(editor.innerText, ""); assert.deepEqual(p.clicks, ["Comment"]);
    assert.equal(p.ctrl.stats.attempted.comment, 0);
    assert.match(p.ctrl.detail, /安全验证/);
  });
}

test("an unrelated new dialog with a generic Send button is not adopted as a comment composer", async () => {
  const p = setup("comment"), popup = new p.Node("dialog", "Feedback");
  const editor = popup.add(new p.Node("editor")); popup.add(new p.Node("button", "Send"));
  p.button.onclick = () => { p.document.overlays = [popup]; };
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, false); assert.equal(editor.innerText, "");
  assert.equal(p.ctrl.stats.attempted.comment, 0);
});

test("a permanent navigation menu mentioning login does not block feed likes", async () => {
  const p = setup("like"), menu = new p.Node("menu", "Login activity");
  menu.attributes.role = "menu";
  p.document.overlays = [menu];
  // This is navigation, not a floating popup.
  menu.style = {position: "static"};
  p.button.onclick = () => { p.button.attributes["aria-pressed"] = "true"; };
  assert.equal(p.window.__fbActivityRuntime.isProtectedOverlay(menu), false);
  const {promise} = await p.start(); await p.clock.advance(4000); await promise;
  assert.equal(p.ctrl.stats.confirmed.like, 1);
});

test("a post dialog mentioning login tips is not a verification challenge", () => {
  const p = setup("like"), popup = new p.Node("dialog", "Alice shared login tips");
  popup.attributes["aria-label"] = "Comments";
  popup.add(new p.Node("article", "Login tips"));
  assert.equal(p.window.__fbActivityRuntime.isProtectedOverlay(popup), false);
});

test("a missing like target has its own diagnostic even when comments are available", async () => {
  const p = setup("comment"); p.article.add(new p.Node("editor"));
  await p.clock.advance(25000); const attempt = p.interactions.maybeInteract(["like", "comment"]);
  await p.clock.advance(10000); await attempt;
  assert.match(p.ctrl.stats.issues.like, /点赞入口/);
  assert.equal(p.ctrl.stats.confirmed.comment, 1);
});

test("a security dialog appearing after draft insertion blocks both Send and cleanup", async () => {
  const p = setup("comment"), editor = p.article.add(new p.Node("editor")); editor.isContentEditable = true;
  const {promise} = await p.start(); await p.clock.advance(2500);
  assert.equal(editor.innerText, "Thanks for sharing!");
  p.document.overlays = [new p.Node("dialog", "Confirm your identity")];
  await p.clock.advance(10000); assert.equal(await promise, false);
  assert.equal(editor.innerText, "Thanks for sharing!"); assert.equal(p.ctrl.stats.attempted.comment, 0);
  p.interactions.maintainPage(); assert.equal(editor.innerText, "Thanks for sharing!");
});

test("a pending share menu is not dismissed when its confirmation dialog opens beside it", async () => {
  const p = setup("share"), menu = new p.Node("menu"), composer = new p.Node("dialog");
  const option = menu.add(new p.Node("button", "Share to your story (Friends)"));
  composer.add(new p.Node("button", "Share")).onclick = () => {
    p.document.alerts.push(new p.Node("alert", "Your story was shared"));
    p.document.overlays = []; menu.isConnected = false; composer.isConnected = false;
  };
  let escapes = 0;
  menu.dispatchEvent = () => { escapes++; composer.isConnected = false; };
  p.button.onclick = () => { p.document.overlays = [menu]; };
  option.onclick = () => { p.document.overlays = [menu, composer]; };
  const {promise} = await p.start(); await p.clock.advance(10000); await promise;
  assert.equal(p.ctrl.stats.confirmed.share, 1); assert.equal(escapes, 0);
  assert.equal(p.ctrl.interactionScopes.size, 0);
});

test("a comment dialog taller than the viewport is accepted when its editor is visible", async () => {
  const p = setup("comment"), dialog = new p.Node("dialog");
  dialog.attributes["aria-label"] = "Comments";
  dialog.getBoundingClientRect = () => ({width: 500, height: 1200, top: 0, bottom: 1200});
  dialog.add(new p.Node("editor"));
  p.button.onclick = () => { p.document.overlays = [dialog]; };
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, true);
  assert.equal(p.ctrl.stats.confirmed.comment, 1);
});

test("missing post identity is reported for comment and share even if a like succeeds", async () => {
  const p = setup("like"); p.anchor.href = "https://www.facebook.com/alice/";
  p.article.add(new p.Node("button", "Comment")); p.article.add(new p.Node("button", "Share"));
  p.button.onclick = () => { p.button.attributes["aria-pressed"] = "true"; };
  await p.clock.advance(25000); const attempt = p.interactions.maybeInteract();
  await p.clock.advance(4000); await attempt;
  assert.equal(p.ctrl.stats.confirmed.like, 1);
  assert.match(p.ctrl.stats.issues.comment, /帖子链接/);
  assert.match(p.ctrl.stats.issues.share, /帖子链接/);
});

test("one-click story sharing is confirmed once without requiring a composer", async () => {
  const p = setup("share"), menu = new p.Node("menu");
  const option = menu.add(new p.Node("button", "Share to your story (Friends)"));
  p.button.onclick = () => { p.document.overlays = [menu]; };
  option.onclick = () => {
    p.document.overlays = [];
    p.document.alerts.push(new p.Node("alert", "Your story was shared"));
  };
  const {promise} = await p.start(); await p.clock.advance(10000); await promise;
  assert.deepEqual(p.clicks, ["Share", "Share to your story (Friends)"]);
  assert.equal(p.interactions.counts.share, 1);
  assert.equal(p.ctrl.stats.attempted.share, 1);
  assert.equal(p.ctrl.stats.confirmed.share, 1);
});

test("story selection without confirmation stays uncertain and is never submitted again", async () => {
  const p = setup("share"), menu = new p.Node("menu");
  const option = menu.add(new p.Node("button", "Share to your story (Friends)"));
  p.button.onclick = () => { p.document.overlays = [menu]; };
  option.onclick = () => { p.document.overlays = []; };
  const {promise} = await p.start(); await p.clock.advance(10000); await promise;
  assert.equal(p.ctrl.stats.attempted.share, 1); assert.equal(p.ctrl.stats.confirmed.share, 0);
  assert.match(p.ctrl.stats.issues.share, /未收到成功提示/);
  await p.clock.advance(45000); assert.equal(await p.interactions.maybeInteract(["share"]), false);
  assert.equal(p.clicks.length, 2);
});

test("a changed story composer can reuse the original dialog", async () => {
  const p = setup("share"), menu = new p.Node("dialog", "Choose destination");
  const option = menu.add(new p.Node("button", "Share to your story"));
  p.button.onclick = () => { p.document.overlays = [menu]; };
  option.onclick = () => {
    option.isConnected = false; menu.innerText = "Story preview";
    const publish = menu.add(new p.Node("button", "Share"));
    publish.onclick = () => { p.document.alerts.push(new p.Node("alert", "Your story was shared")); };
  };
  const {promise} = await p.start(); await p.clock.advance(10000); await promise;
  assert.deepEqual(p.clicks, ["Share", "Share to your story", "Share"]);
  assert.equal(p.ctrl.stats.confirmed.share, 1); assert.equal(p.ctrl.stats.attempted.share, 1);
});

test("stopping snapshots telemetry and later callbacks cannot add confirmations", async () => {
  const p = setup("like");
  p.ctrl.recordInteraction("like");
  p.ctrl.stop(true);
  p.ctrl.recordInteraction("like", true);
  assert.equal(p.ctrl.stats.confirmed.like, 0);
  assert.equal(p.window.__fbActivityLastSnapshot.stats.attempted.like, 1);
  assert.equal(p.window.__fbActivityLastSnapshot.runId, "run-1");
});

test("an unrelated dialog during comment submission does not strand our draft", async () => {
  const p = setup("comment"), editor = p.article.add(new p.Node("editor"));
  editor.isContentEditable = true;
  editor.dispatchEvent = event => { if (event.type === "keydown") p.document.overlays.push(new p.Node("dialog", "User settings")); };
  const {promise} = await p.start(); await p.clock.advance(15000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "Thanks for sharing!");
  assert.equal(p.document.overlays.length, 1);
  p.document.overlays = [];
  p.interactions.maintainPage(); assert.equal(editor.innerText, "");
  assert.equal(p.ctrl.canAct(), true);
});

test("failed comments close their own empty overlay, never a pre-existing user dialog", async () => {
  const p = setup("comment"), dialog = new p.Node("dialog");
  dialog.attributes["aria-label"] = "Comments";
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
  const close = chat.add(new p.Node("button", "Close chat"));
  close.onclick = () => { chat.isConnected = false; p.document.overlays = []; };
  chat.add(new p.Node("button", "Send"));
  p.button.onclick = () => p.document.overlays.push(chat);
  const {promise} = await p.start(); await p.clock.advance(10000);
  assert.equal(await promise, false);
  assert.equal(editor.innerText, "");
  assert.deepEqual(p.clicks, ["Comment", "Close chat"]);
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

test("home preserves chat drafts but ignores recent input when closing an empty chat", () => {
  const p = setup("like"), chat = new p.Node("dialog");
  const editor = chat.add(new p.Node("editor", "My chat draft"));
  const close = chat.add(new p.Node("button", "Close chat"));
  const original = p.document.querySelectorAll;
  p.document.querySelectorAll = selector => [...original(selector), close];
  p.interactions.maintainPage();
  assert.equal(p.clicks.length, 0); assert.equal(editor.innerText, "My chat draft");
  editor.innerText = ""; p.ctrl.lastInput = 20000;
  p.interactions.maintainPage(); assert.deepEqual(p.clicks, ["Close chat"]);
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

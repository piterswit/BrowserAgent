// Isolated browser fixtures; no Facebook login, messages or external submissions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const folder = path.join(__dirname, "../WS Browser Bridge");

async function checkSecurityFalsePositives(browser) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    await page.context().route("**/*", route => route.abort());
    await page.setContent(`<nav role="menu">Login activity</nav>
      <article role="article"><a href="https://www.facebook.com/alice/posts/123">Post</a><button id="like" aria-pressed="false">Like</button></article>
      <div role="dialog" aria-label="Comments" hidden><article role="article">Alice shared login tips</article>
      <button id="close">Close</button></div>`);
    await page.evaluate(() => {
      window.chrome = {runtime: {sendMessage: async () => {}}};
      window.__fbActivityRequest = {mode: "home", runId: "false-positive-test"};
      window.likeClicks = 0;
      document.querySelector("#like").onclick = event => {
        window.likeClicks++; event.currentTarget.setAttribute("aria-pressed", "true");
      };
      document.querySelector("#close").onclick = () => document.querySelector('[role="dialog"]').hidden = true;
    });
    for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
      await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
    }
    const result = await page.evaluate(async () => {
      const runtime = window.__fbActivityRuntime, ctrl = runtime.create("home");
      ctrl.sleep = async () => { ctrl.guard(); };
      const now = Date.now; let offset = 0; Date.now = () => now() + offset;
      const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
      await actions.maybeInteract(["like"]);
      const dialog = document.querySelector('[role="dialog"]'); dialog.hidden = false;
      if (runtime.isProtectedOverlay(dialog) || !ctrl.canAct() || !dialog.hidden) throw Error("Post content blocked popup recovery");
      dialog.hidden = false; dialog.setAttribute("aria-label", "Confirm your identity");
      if (ctrl.canAct() || dialog.hidden) throw Error("Actual verification challenge was not protected");
      const result = {clicks: window.likeClicks, confirmed: ctrl.stats.confirmed.like};
      ctrl.stop(); return result;
    });
    assert.deepEqual(result, {clicks: 1, confirmed: 1});
    console.log("Security false positives: navigation allows Like; post dialog closes; actual verification stays protected");
  } finally { await page.close(); }
}

async function checkTaskBoundaries(browser) {
  for (const scenario of ["Confirm your identity", "登录验证", "安全檢查", "overlapping-share"]) {
    const page = await browser.newPage({viewport: {width: 1000, height: 700}});
    try {
      await page.context().route("**/*", route => route.abort());
      await page.setContent(`<style>[role=dialog],[role=menu]{position:fixed;left:20px;width:400px;height:140px;background:white}
        [role=menu]{top:100px}[role=dialog]{top:260px}[contenteditable]{min-height:30px}</style>
        <article role="article"><a href="https://www.facebook.com/alice/posts/123">Post</a><button id="action">${scenario === "overlapping-share" ? "Share" : "Comment"}</button></article><div id="notice" role="status"></div>`);
      await page.evaluate(scenario => {
        window.chrome = {runtime: {sendMessage: async () => {}}};
        window.__fbActivityRequest = {mode: "home", runId: "boundary-test"}; Math.random = () => 0;
        window.actions = [];
        document.querySelector("#action").onclick = () => {
          if (scenario !== "overlapping-share") {
            const popup = document.createElement("div"); popup.setAttribute("role", "dialog");
            popup.textContent = scenario;
            popup.insertAdjacentHTML("beforeend", '<div role="textbox" contenteditable="true"></div><button>Post comment</button><button>Close</button>');
            popup.querySelectorAll("button").forEach(button => { button.onclick = () => window.actions.push(button.textContent); });
            document.body.append(popup);
          } else {
            const menu = document.createElement("div"); menu.setAttribute("role", "menu");
            menu.innerHTML = '<button>Share to your story (Friends)</button>'; document.body.append(menu);
            menu.querySelector("button").onclick = () => {
              const popup = document.createElement("div"); popup.setAttribute("role", "dialog");
              popup.innerHTML = '<button>Share</button>'; document.body.append(popup);
              popup.querySelector("button").onclick = () => {
                window.actions.push("published"); document.querySelector("#notice").textContent = "Your story was shared";
                popup.remove(); menu.remove();
              };
              document.addEventListener("keydown", event => {
                if (event.key === "Escape") { window.actions.push("escape"); popup.remove(); }
              });
            };
          }
        };
      }, scenario);
      for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
        await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
      }
      const result = await page.evaluate(async scenario => {
        const ctrl = window.__fbActivityRuntime.create("home");
        ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
        const now = Date.now; let offset = 0; Date.now = () => now() + offset;
        const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
        await actions.maybeInteract([scenario === "overlapping-share" ? "share" : "comment"]);
        actions.maintainPage();
        const result = {actions: window.actions, editor: document.querySelector('[role="textbox"]')?.textContent,
          stats: ctrl.snapshotStats(), detail: ctrl.detail}; ctrl.stop(); return result;
      }, scenario);
      if (scenario === "overlapping-share") {
        assert.deepEqual(result.actions, ["published"]); assert.equal(result.stats.confirmed.share, 1);
      } else {
        assert.deepEqual(result.actions, []); assert.equal(result.editor, "");
        assert.equal(result.stats.attempted.comment, 0); assert.match(result.detail, /安全验证/);
      }
      console.log(`${scenario}: operation boundary passed`);
    } finally { await page.close(); }
  }
}

async function checkRequestCancellation(browser) {
  const page = await browser.newPage();
  try {
    await page.context().route("**/*", route => route.abort());
    await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body:
      '<!doctype html><button id="sent">View sent requests</button><div role="dialog" hidden><h2>Sent requests</h2><div style="height:180px;overflow:auto">' +
      '<button id="cancel">Cancel request</button><div style="height:1600px"></div></div></div>'}));
    await page.goto("https://www.facebook.com/friends/requests");
    await page.evaluate(() => {
      const set = window.setTimeout; window.setTimeout = (callback, ms, ...args) => set(callback, Math.min(ms, 50), ...args);
      window.entryClicks = 0; window.cancelClicks = 0;
      document.querySelector("#sent").onclick = () => { window.entryClicks++; document.querySelector('[role="dialog"]').hidden = false; };
      document.querySelector("#cancel").onclick = () => window.cancelClicks++;
    });
    await page.addScriptTag({content: fs.readFileSync(path.join(folder, "cancel_friend_requests.js"), "utf8")});
    await page.waitForFunction(() => window.entryClicks === 1);
    await page.evaluate(() => window.__fbCancelRequestsCtrl.stop());
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.cancelClicks), 0);
    assert.equal(await page.evaluate(() => window.__fbCancelRequestsCtrl), null);
    console.log("Friend-request task: Stop prevents later cancellation clicks");
  } finally { await page.close(); }
}

async function checkPopupRecovery(browser) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    await page.context().route("**/*", route => route.abort());
    await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body:
      '<!doctype html><style>[role=dialog],[role=alertdialog],[role=menu],dialog{position:fixed;top:80px;left:80px;width:300px;height:180px;background:white}button{padding:10px}</style><main>Feed</main>'}));
    await page.goto("https://www.facebook.com/");
    await page.evaluate(() => {
      window.chrome = {runtime: {sendMessage: async () => {}}};
      window.__fbActivityRequest = {mode: "home", runId: "popup-test"};
      window.fixtureHidden = true;
      Object.defineProperty(document, "hidden", {configurable: true, get: () => window.fixtureHidden});
      document.hasFocus = () => false;
    });
    await page.addScriptTag({content: fs.readFileSync(path.join(folder, "activity_runtime.js"), "utf8")});
    await page.evaluate(() => {
      const ctrl = window.__fbActivityRuntime.create("home");
      if (ctrl.canAct() || ctrl.state !== "等待中" || !ctrl.run) throw Error("Hidden page did not wait");
      window.fixtureHidden = false;
      for (const role of ["dialog", "alertdialog", "menu"]) {
        for (const label of ["Close", "关闭", "關閉", "Not now", "取消"]) {
          const popup = document.createElement("div"); popup.setAttribute("role", role);
          const close = document.createElement("button"); close.setAttribute("aria-label", label); close.textContent = "Dismiss";
          close.onclick = () => popup.remove(); popup.append(close); document.body.append(popup);
          if (!ctrl.canAct() || popup.isConnected) throw Error(`${role}/${label} not dismissed`);
        }
      }
      const popup = document.createElement("dialog"); popup.setAttribute("open", ""); popup.textContent = "Optional notice";
      document.body.append(popup);
      popup.addEventListener("keydown", event => { if (event.key === "Escape") popup.remove(); });
      if (!ctrl.canAct() || popup.isConnected) throw Error("Escape dismissal failed");
      const draft = document.createElement("div"); draft.setAttribute("role", "dialog");
      draft.innerHTML = '<textarea>My unsent message</textarea><button aria-label="Close">Close</button>';
      document.body.append(draft); draft.querySelector("button").onclick = () => draft.remove();
      if (ctrl.canAct() || !draft.isConnected || draft.querySelector("textarea").value !== "My unsent message") throw Error("Draft was not protected");
      draft.remove(); ctrl.stop();
    });
    console.log("Generic dialogs/alertdialogs/menus: multilingual dismiss + Escape fallback + draft protection passed");
  } finally { await page.close(); }
}

async function checkIconControls(browser) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    await page.context().route("**/*", route => route.abort());
    // Preserve the supplied semantic markers; wrappers and state transitions are test scaffolding.
    await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8">
      <style>[role=button]{display:inline-block;padding:10px}article{padding:20px}[contenteditable]{min-height:40px;border:1px solid} [hidden]{display:none}</style>
      <main><article role="article"><a href="/alice/posts/123">Post</a>
      <div id="like" role="button" tabindex="0" aria-pressed="false"><span><i></i><div data-ad-rendering-role="like_button"></div></span><span>4</span></div>
      <div id="comment" role="button" tabindex="0"><span><i></i><div data-ad-rendering-role="comment_button"></div></span></div>
      <div id="share" role="button" tabindex="0"><span><i></i><div data-ad-rendering-role="share_button"></div></span></div>
      <div id="composer" hidden><div><div><div><div><div><div contenteditable="true" role="textbox" id="editor"></div></div></div></div></div></div>
      <div id="focused-state-composer-submit"><span><div aria-label="Post comment" role="button" tabindex="0"><svg width="16" height="16"></svg></div></span></div></div>
      </article></main>
      <div id="menu" role="menu" style="position:fixed;top:50px;width:500px;height:950px" hidden><div role="button">Share to Feed</div><div id="story" role="button"><span>Share to your story (Friends)</span></div><div role="button">Send in Messenger</div></div>
      <div id="storyComposer" role="dialog" style="position:fixed;top:50px;width:500px;height:950px" hidden><button id="publish">Share</button></div><div id="notice" role="status"></div>`}));
    await page.goto("https://www.facebook.com/");
    await page.evaluate(() => {
      window.chrome = {runtime: {sendMessage: async () => {}}};
      window.__fbActivityRequest = {mode: "home", runId: "icon-ui-test"};
      Math.random = () => 0;
      window.actions = [];
      const get = id => document.getElementById(id);
      get("like").onclick = () => { window.actions.push("like"); get("like").setAttribute("aria-pressed", "true"); };
      get("comment").onclick = () => { window.actions.push("comment"); get("composer").hidden = false; };
      get("focused-state-composer-submit").querySelector('[role="button"]').onclick = () => {
        window.actions.push("send"); get("editor").textContent = "";
      };
      get("share").onclick = () => { window.actions.push("share"); get("menu").hidden = false; };
      get("story").onclick = () => { window.actions.push("story"); get("menu").hidden = true; get("storyComposer").hidden = false; };
      get("publish").onclick = () => { window.actions.push("publish"); get("storyComposer").hidden = true; get("notice").textContent = "Your story was shared"; };
    });
    for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
      await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
    }
    const result = await page.evaluate(async () => {
      const ctrl = window.__fbActivityRuntime.create("home");
      ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
      const now = Date.now.bind(Date); let offset = 0;
      Date.now = () => now() + offset;
      for (const kind of ["like", "comment", "share"]) {
        const interactions = window.__fbActivityInteractions(ctrl);
        offset += 31000;
        if (!await interactions.maybeInteract([kind])) throw Error(`Icon ${kind} was not handled`);
      }
      document.getElementById("like").removeAttribute("aria-pressed");
      window.__fbInteractionHistory.clear();
      const unknown = window.__fbActivityInteractions(ctrl); offset += 31000;
      if (await unknown.maybeInteract(["like"])) throw Error("Unknown icon like state was clicked");
      const result = {actions: window.actions, confirmed: ctrl.snapshotStats().confirmed};
      ctrl.stop(); return result;
    });
    assert.deepEqual(result.actions, ["like", "comment", "send", "share", "story", "publish"]);
    assert.deepEqual(result.confirmed, {like: 1, comment: 1, share: 1});
    console.log("Icon markers, scoped nested comment submit, story audience suffix and unknown-like guard passed");
  } finally { await page.close(); }
}

async function checkPlainDivComments(browser) {
  for (const labels of [
    {comment: "Comment", send: "Post comment"},
    {comment: "评论", send: "发表评论"},
    {comment: "留言", send: "發佈留言"}
  ]) {
    const page = await browser.newPage({viewport: {width: 1000, height: 700}});
    try {
      await page.context().route("**/*", route => route.abort());
      // The supplied marker/icon and sibling label structure, without adding role=button.
      await page.setContent(`<style>#comment{display:inline-flex;padding:12px;gap:8px}[contenteditable]{min-height:40px}</style>
        <article role="article"><a href="https://www.facebook.com/alice/posts/plain-div">Post</a>
        <div id="counter"><i></i><div data-ad-rendering-role="comment_button"></div><span>47</span></div>
        <div id="comment"><div><i data-visualcompletion="css-img"></i><div data-ad-rendering-role="comment_button"></div></div>
        <div><span dir="auto">${labels.comment}</span></div></div>
        <div id="composer" hidden><div contenteditable="true" role="textbox" id="editor"></div>
        <div id="focused-state-composer-submit"><button id="send" aria-label="${labels.send}" disabled>${labels.send}</button></div></div></article>`);
      await page.evaluate(() => {
        window.chrome = {runtime: {sendMessage: async () => {}}};
        window.__fbActivityRequest = {mode: "home", runId: "plain-div-comment"};
        Math.random = () => 0; window.events = [];
        const get = id => document.getElementById(id);
        get("counter").onclick = () => window.events.push("wrong-counter");
        get("comment").onclick = () => { window.events.push("comment"); get("composer").hidden = false; };
        get("editor").oninput = () => {
          if (get("editor").textContent) setTimeout(() => { get("send").disabled = false; }, 30);
        };
        get("editor").onkeydown = event => { if (event.key === "Enter") window.events.push("enter"); };
        get("send").onclick = () => { window.events.push("send"); get("editor").textContent = ""; };
      });
      for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
        await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
      }
      const result = await page.evaluate(async () => {
        const ctrl = window.__fbActivityRuntime.create("home");
        ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
        const now = Date.now; let offset = 0; Date.now = () => now() + offset;
        const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
        const submitted = await actions.maybeInteract(["comment"]);
        const result = {submitted, events: window.events, confirmed: ctrl.stats.confirmed.comment};
        ctrl.stop(); return result;
      });
      assert.deepEqual(result, {submitted: true, events: ["comment", "send"], confirmed: 1});
      console.log(`${labels.comment}: plain-div entry, counter exclusion and delayed send passed`);
    } finally { await page.close(); }
  }
}

async function checkPlainDivSharing(browser) {
  for (const labels of [
    {share: "Share", story: "Share to your story (Friends)", publish: "Post", success: "Your story was shared"},
    {share: "分享", story: "分享到快拍(好友)", publish: "发布", success: "快拍已分享"},
    {share: "分享", story: "分享到限時動態（好友）", publish: "發佈", success: "限時動態已發佈"}
  ]) {
    for (const scenario of ["enabled", "disabled", "missing"]) {
      const hasStory = scenario !== "missing", shouldPublish = scenario === "enabled";
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        // Preserve the supplied nested div/span action structure; click must bubble to its row.
        await page.setContent(`<style>#share{display:inline-flex;padding:12px;gap:8px}[role=menu],[role=dialog]{position:fixed;top:120px;left:20px;background:white;padding:20px}</style>
          <article role="article"><a href="https://www.facebook.com/alice/posts/plain-share">Post</a>
          <div id="share"><div><i data-visualcompletion="css-img"></i><div data-ad-rendering-role="share_button"></div></div>
          <div><span dir="auto">${labels.share}</span></div></div></article>
          <div role="menu" id="menu" hidden><button id="feed">${labels.share}</button>
          <h3>${labels.story}</h3>
          ${hasStory ? `<div id="story" ${scenario === "disabled" ? 'aria-disabled="true"' : ""}><div><div><div><span dir="auto" id="_r_2o3_"><span>${labels.story}</span></span></div></div></div></div>` : ""}</div>
          <div role="dialog" id="composer" hidden><button id="publish">${labels.publish}</button></div>
          <div role="status" id="notice"></div>`);
        await page.evaluate(success => {
          window.chrome = {runtime: {sendMessage: async () => {}}};
          window.__fbActivityRequest = {mode: "home", runId: "plain-div-share"};
          Math.random = () => 0; window.events = [];
          const get = id => document.getElementById(id);
          get("share").onclick = () => { window.events.push("share"); get("menu").hidden = false; };
          get("feed").onclick = () => window.events.push("wrong-feed");
          if (get("story")) get("story").onclick = () => {
            window.events.push("story"); get("menu").hidden = true; get("composer").hidden = false;
          };
          get("publish").onclick = () => {
            window.events.push("publish"); get("composer").hidden = true; get("notice").textContent = success;
          };
        }, labels.success);
        for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
          await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
        }
        const result = await page.evaluate(async () => {
          const ctrl = window.__fbActivityRuntime.create("home");
          ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
          const now = Date.now; let offset = 0; Date.now = () => now() + offset;
          const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
          await actions.maybeInteract(["share"]);
          const result = {events: window.events, stats: ctrl.snapshotStats()}; ctrl.stop(); return result;
        });
        assert.deepEqual(result.events, shouldPublish ? ["share", "story", "publish"] : ["share"]);
        assert.equal(result.stats.attempted.share, Number(shouldPublish));
        assert.equal(result.stats.confirmed.share, Number(shouldPublish));
        if (!shouldPublish) assert.match(result.stats.issues.share, /没有可见的快拍入口/);
        console.log(`${labels.story}: nested-span story option (${scenario}) passed`);
      } finally { await page.close(); }
    }
  }
}

async function checkCommentFailureCleanup(browser) {
  for (const labels of [
    {editor: "Write a comment…", send: "Post comment", close: "Close post"},
    {editor: "写评论…", send: "发布评论", close: "关闭帖子"},
    {editor: "撰寫留言…", send: "發佈留言", close: "關閉貼文"}
  ]) {
    for (const scenario of ["missing-editor", "disabled-send", "unconfirmed-send", "ready"]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        // The supplied Lexical DOM attributes; the fixture simulates input-state updates, not Lexical itself.
        await page.setContent(`<style>[role=dialog]{position:fixed;top:60px;left:20px;width:600px;padding:20px;background:white}[contenteditable]{min-height:40px}</style>
          <article role="article"><a href="https://www.facebook.com/alice/posts/comment-cleanup">Post</a><button id="comment">Comment</button></article>
          <div role="dialog" aria-label="Comments" id="popup" hidden>
          <button id="close" aria-label="${labels.close}">X</button>
          <a href="https://www.facebook.com/alice/posts/comment-cleanup">Post</a>
          <div id="composer">${scenario === "missing-editor" ? "" : `<div><div aria-label="${labels.editor}" contenteditable="true" role="textbox" spellcheck="true" tabindex="0" aria-placeholder="${labels.editor}" data-lexical-editor="true" data-interactable="|keydown||input||click|" id="editor"><p dir="auto"><br data-lexical-managed-linebreak="true"></p></div><div aria-hidden="true">${labels.editor}</div></div>
          <div><div><div><div id="focused-state-composer-submit"><span><div id="send" aria-disabled="true" aria-label="${labels.send}" role="button" tabindex="-1"><svg viewBox="0 0 16 16" width="16" height="16"></svg></div></span></div></div></div></div>`}</div></div>`);
        await page.evaluate(scenario => {
          window.chrome = {runtime: {sendMessage: async () => {}}};
          window.__fbActivityRequest = {mode: "home", runId: "comment-cleanup"};
          Math.random = () => 0; window.events = [];
          const get = id => document.getElementById(id);
          get("comment").onclick = () => { window.events.push("comment"); get("popup").hidden = false; };
          get("close").onclick = () => {
            if (get("editor")?.innerText.trim()) window.events.push("closed-with-draft");
            window.events.push("close"); get("popup").hidden = true;
          };
          if (get("editor")) {
            get("editor").oninput = () => {
              if (scenario !== "disabled-send" && get("editor").innerText.trim()) {
                setTimeout(() => get("send").setAttribute("aria-disabled", "false"), 30);
              }
            };
            get("send").onclick = () => {
              window.events.push("send");
              if (scenario === "ready") get("editor").textContent = "";
            };
          }
        }, scenario);
        for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
          await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
        }
        const result = await page.evaluate(async () => {
          const ctrl = window.__fbActivityRuntime.create("home");
          ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
          const now = Date.now; let offset = 0; Date.now = () => now() + offset;
          const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
          const submitted = await actions.maybeInteract(["comment"]);
          const result = {submitted, events: window.events, closed: document.getElementById("popup").hidden,
            draft: document.getElementById("editor")?.innerText.trim() || "", stats: ctrl.snapshotStats()};
          ctrl.stop(); return result;
        });
        const sends = ["ready", "unconfirmed-send"].includes(scenario);
        assert.equal(result.submitted, scenario === "ready");
        assert.deepEqual(result.events, sends ? ["comment", "send", "close"] : ["comment", "close"]);
        assert.equal(result.closed, true); assert.equal(result.draft, "");
        assert.equal(result.stats.confirmed.comment, Number(scenario === "ready"));
        assert.equal(result.stats.attempted.comment, Number(sends));
        console.log(`${labels.editor}: supplied editor/aria-disabled submit, popup cleanup (${scenario}) passed`);
      } finally { await page.close(); }
    }
  }
}

async function checkHomeCommentRoutes(browser) {
  for (const labels of [
    {comment: "Comment", input: "Write a comment…", send: "Post comment", close: "Close post"},
    {comment: "评论", input: "写评论…", send: "发布评论", close: "关闭帖子"},
    {comment: "留言", input: "撰寫留言…", send: "發佈留言", close: "關閉貼文"}
  ]) {
    for (const missingEditor of [false, true]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body:
          `<style>body{height:1800px}[role=dialog]{position:fixed;top:80px;left:20px;width:600px;background:white;padding:20px}[contenteditable]{min-height:40px}</style>
          <article role="article"><a href="/alice/posts/route-test">Post</a><button id="comment">${labels.comment}</button><button id="like">Like</button></article>
          <div role="dialog" aria-label="${labels.comment}" id="popup" hidden><a href="/alice/posts/route-test">Post</a>
          ${missingEditor ? "" : `<div contenteditable="true" role="textbox" aria-label="${labels.input}" id="editor"></div><button id="send">${labels.send}</button>`}
          <button id="close">${labels.close}</button></div>`}));
        await page.goto("https://www.facebook.com/");
        await page.evaluate(() => {
          window.stops = 0; window.chrome = {runtime: {sendMessage: async message => {
            if (message.cmd === "fb_bridge_active_stopped") window.stops++;
          }}};
          window.__fbActivityRequest = {mode: "home", runId: "home-comment-route"}; Math.random = () => 0;
          const get = id => document.getElementById(id);
          get("comment").onclick = () => {
            history.pushState({}, "", "/permalink.php?story_fbid=route-test&id=1"); get("popup").hidden = false;
          };
          if (get("send")) get("send").onclick = () => { get("editor").textContent = ""; };
          get("close").onclick = () => { get("popup").hidden = true; history.replaceState({}, "", "/"); };
          get("like").onclick = () => get("like").setAttribute("aria-pressed", "true");
        });
        for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
          await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
        }
        const result = await page.evaluate(async () => {
          const ctrl = window.__fbActivityRuntime.create("home"), deadline = ctrl.deadline;
          ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
          const now = Date.now; let offset = 0; Date.now = () => now() + offset;
          const actions = window.__fbActivityInteractions(ctrl); offset = 31000;
          await actions.maybeInteract(["comment"]); offset += 35000;
          await actions.maybeInteract(["like"]);
          await ctrl.scroll(window, 80, "y", 2);
          const result = {running: ctrl.run, path: location.pathname, scroll: scrollY, stats: ctrl.snapshotStats(),
            stops: window.stops, sameDeadline: ctrl.deadline === deadline}; ctrl.stop(); return result;
        });
        assert.equal(result.running, true); assert.equal(result.path, "/"); assert.ok(result.scroll > 0);
        assert.equal(result.stats.confirmed.comment, Number(!missingEditor)); assert.equal(result.stats.confirmed.like, 1);
        assert.equal(result.stops, 0); assert.equal(result.sameDeadline, true);
        console.log(`${labels.comment}: own permalink dialog (${missingEditor ? "missing editor" : "sent"}) returns to home, likes and scrolling continue`);
      } finally { await page.close(); }
    }
  }
}

async function main() {
  const browser = await chromium.launch({headless: true, channel: "chrome"});
  try {
    await checkSecurityFalsePositives(browser);
    await checkTaskBoundaries(browser);
    await checkRequestCancellation(browser);
    await checkPopupRecovery(browser);
    await checkIconControls(browser);
    await checkPlainDivComments(browser);
    await checkPlainDivSharing(browser);
    await checkCommentFailureCleanup(browser);
    await checkHomeCommentRoutes(browser);
    for (const labels of [
      {comment: "Comment", send: "Post comment", chat: "Close chat", notifications: "Notifications"},
      {comment: "评论", send: "发表评论", chat: "关闭聊天", notifications: "通知"},
      {comment: "留言", send: "發佈留言", chat: "關閉聊天室", notifications: "通知訊息"}
    ]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8">
          <style>body{margin:0;overflow:hidden}main{height:700px;overflow-y:auto}article{padding:20px;height:250px}
          [contenteditable]{min-height:40px;border:1px solid #999}#chat{position:fixed;right:0;bottom:0;width:350px;height:300px;background:white}
          #notifications{position:fixed;right:20px;top:50px;width:350px;height:300px;overflow-y:auto;background:white}#notifications p{height:80px}</style>
          <header role="banner"><button id="trigger" aria-expanded="false" aria-controls="notifications" aria-label="${labels.notifications}">${labels.notifications}</button></header>
          <main role="main"><article role="article"><a href="/alice/posts/123">Alice</a>
          <button id="comment">${labels.comment}</button><div id="editor" contenteditable="true" role="textbox"></div>
          <button id="send">${labels.send}</button></article>${"<article>Feed</article>".repeat(15)}</main>
          <div id="chat" role="dialog"><button id="closeChat" aria-label="${labels.chat}">${labels.chat}</button><div contenteditable="true" role="textbox"></div></div>
          <div id="notifications" role="dialog" aria-label="${labels.notifications}" hidden>${"<p>Notification</p>".repeat(12)}</div>`}));
        await page.goto("https://www.facebook.com/");
        await page.evaluate(() => {
          window.chrome = {runtime: {sendMessage: async () => {}}};
          window.__fbActivityRequest = {mode: "home", runId: "ui-test"};
          window.fixtureHidden = false;
          Object.defineProperty(document, "hidden", {configurable: true, get: () => window.fixtureHidden});
          document.hasFocus = () => false;
          Math.random = () => 0;
          window.sent = 0; window.notificationClicks = 0;
          document.querySelector("#comment").setAttribute("aria-label", "Open comments for this post");
          document.querySelector("#closeChat").onclick = () => document.querySelector("#chat").remove();
          document.querySelector("#send").onclick = () => {
            if (!window.refuseComment) { window.sent++; document.querySelector("#editor").textContent = ""; }
            if (window.hideDuringComment) window.fixtureHidden = true;
          };
          document.querySelector("#trigger").onclick = () => {
            const panel = document.querySelector("#notifications");
            if (!panel.hidden) window.notificationScrollTop = panel.scrollTop;
            panel.hidden = !panel.hidden;
            document.querySelector("#trigger").setAttribute("aria-expanded", String(!panel.hidden));
            window.notificationClicks++;
          };
        });
        for (const file of ["activity_runtime.js", "activity_interactions.js"]) {
          await page.addScriptTag({content: fs.readFileSync(path.join(folder, file), "utf8")});
        }
        await page.evaluate(async () => {
          const ctrl = window.__fbActivityRuntime.create("home");
          ctrl.sleep = async () => {
            ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard();
            if (window.hideDuringNotifications && document.querySelector("#trigger").getAttribute("aria-expanded") === "true") {
              window.hideDuringNotifications = false; window.fixtureHidden = true;
            }
          };
          const now = Date.now.bind(Date); let offset = 0;
          Date.now = () => now() + offset;
          const interactions = window.__fbActivityInteractions(ctrl);
          interactions.maintainPage();
          if (document.querySelector("#chat")) throw Error("Chat was not closed");
          offset = 31000;
          if (!await interactions.maybeInteract(["comment"])) throw Error("Comment was not submitted");
          if (window.sent !== 1 || document.querySelector("#editor").textContent) throw Error("Comment send verification failed");
          offset = 45000;
          if (!await interactions.maybeNotifications()) throw Error("Notifications did not open");
          const panel = document.querySelector("#notifications");
          if (!panel.hidden || window.notificationScrollTop < 100 || window.notificationClicks !== 2) throw Error("Notification scroll/close failed");
          const interrupted = window.__fbActivityInteractions(ctrl);
          offset += 45000; window.hideDuringNotifications = true;
          if (await interrupted.maybeNotifications()) throw Error("Hidden notification browsing did not yield");
          if (panel.hidden || ctrl.state !== "等待中") throw Error("Notification panel changed while hidden");
          interrupted.maintainPage();
          if (window.notificationClicks !== 3) throw Error("Notification cleanup clicked while hidden");
          window.fixtureHidden = false; interrupted.maintainPage();
          if (!panel.hidden || window.notificationClicks !== 4) throw Error("Notification cleanup did not resume");
          window.__fbInteractionHistory.clear();
          const failed = window.__fbActivityInteractions(ctrl);
          window.refuseComment = true; window.hideDuringComment = true; offset += 31000;
          if (await failed.maybeInteract(["comment"])) throw Error("Unconfirmed comment reported as success");
          if (!document.querySelector("#editor").textContent || ctrl.state !== "等待中") throw Error("Hidden comment draft was not deferred");
          window.fixtureHidden = false; failed.maintainPage();
          if (document.querySelector("#editor").textContent || !ctrl.canAct()) throw Error("Failed comment stranded the page");
          if (window.sent !== 1) throw Error("Duplicate comment submission");
          window.__fbActivityRuntime.stop();
        });
        console.log(`${labels.comment}: explicit send, hidden/visible draft and notification recovery, chat close passed`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

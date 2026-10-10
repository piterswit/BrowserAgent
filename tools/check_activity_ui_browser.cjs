// Isolated browser fixtures; no Facebook login, messages or external submissions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const folder = path.join(__dirname, "../WS Browser Bridge");

async function checkPopupRecovery(browser) {
  const page = await browser.newPage({viewport: {width: 1000, height: 700}});
  try {
    await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body:
      '<!doctype html><style>[role=dialog],[role=alertdialog],[role=menu],dialog{position:fixed;top:80px;left:80px;width:300px;height:180px;background:white}button{padding:10px}</style><main>Feed</main>'}));
    await page.goto("https://www.facebook.com/");
    await page.evaluate(() => {
      window.chrome = {runtime: {sendMessage: async () => {}}};
      window.__fbActivityRequest = {mode: "home", runId: "popup-test"};
    });
    await page.addScriptTag({content: fs.readFileSync(path.join(folder, "activity_runtime.js"), "utf8")});
    await page.evaluate(() => {
      const ctrl = window.__fbActivityRuntime.create("home");
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
      <div id="menu" role="menu" hidden><div role="button">Share to Feed</div><div id="story" role="button"><span>Share to your story (Friends)</span></div><div role="button">Send in Messenger</div></div>
      <div id="storyComposer" role="dialog" hidden><button id="publish">Share</button></div><div id="notice" role="status"></div>`}));
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

async function main() {
  const browser = await chromium.launch({headless: true, channel: "chrome"});
  try {
    await checkPopupRecovery(browser);
    await checkIconControls(browser);
    for (const labels of [
      {comment: "Comment", send: "Post comment", chat: "Close chat", notifications: "Notifications"},
      {comment: "评论", send: "发表评论", chat: "关闭聊天", notifications: "通知"},
      {comment: "留言", send: "發佈留言", chat: "關閉聊天室", notifications: "通知訊息"}
    ]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
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
          Math.random = () => 0;
          window.sent = 0; window.notificationClicks = 0;
          document.querySelector("#comment").setAttribute("aria-label", "Open comments for this post");
          document.querySelector("#closeChat").onclick = () => document.querySelector("#chat").remove();
          document.querySelector("#send").onclick = () => {
            if (!window.refuseComment) { window.sent++; document.querySelector("#editor").textContent = ""; }
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
          ctrl.sleep = async () => { ctrl.guard(); await new Promise(resolve => setTimeout(resolve, 5)); ctrl.guard(); };
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
          window.__fbInteractionHistory.clear();
          const failed = window.__fbActivityInteractions(ctrl);
          window.refuseComment = true; offset += 31000;
          if (await failed.maybeInteract(["comment"])) throw Error("Unconfirmed comment reported as success");
          if (document.querySelector("#editor").textContent || !ctrl.canAct()) throw Error("Failed comment stranded the page");
          if (window.sent !== 1) throw Error("Duplicate comment submission");
          window.__fbActivityRuntime.stop();
        });
        console.log(`${labels.comment}: explicit send, failed-draft recovery, chat close and notification scroll/close passed`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

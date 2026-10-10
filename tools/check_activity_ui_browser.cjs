// Isolated browser fixtures; no Facebook login, messages or external submissions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const folder = path.join(__dirname, "../WS Browser Bridge");

async function main() {
  const browser = await chromium.launch({headless: true, channel: "chrome"});
  try {
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

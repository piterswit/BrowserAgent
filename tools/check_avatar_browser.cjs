// Isolated Chrome fixtures: no real login, network uploads or account changes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/change_avatar.js"), "utf8");

async function main() {
  const browser = await chromium.launch({headless: true, channel: "chrome"});
  try {
    for (const menu of [false, true]) {
      const page = await browser.newPage();
      try {
        await page.route("**/*", route => route.fulfill({contentType: "text/html", body: `<!doctype html>
          <main><h1>Alice</h1><section id="profile">
          <button id="edit" aria-label="${menu ? "Alice's profile picture" : "Edit profile picture"}" style="width:168px;height:168px">
          <img alt="Alice's profile picture" width="168" height="168" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"></button>
          </section></main>`}));
        await page.goto("https://www.facebook.com/me");
        await page.evaluate(menu => {
          window.messages = [];
          window.chrome = {runtime: {sendMessage: async message => {
            window.messages.push(message.cmd);
            return {accepted: true};
          }}};
          const editor = () => {
            document.querySelector('[role="menu"]')?.remove();
            const dialog = document.createElement("div");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-label", "Update profile picture");
            dialog.innerHTML = '<button>Upload photo</button><input type="file" accept="image/*"><button id="save">Save</button>';
            document.body.append(dialog);
            dialog.querySelector("#save").onclick = () => {
              if (!dialog.querySelector("input").files.length) throw new Error("no uploaded file");
              document.querySelector("#profile img").src = "https://scontent.test.fbcdn.net/new-avatar.jpg";
              const alert = document.createElement("div");
              alert.setAttribute("role", "status");
              alert.textContent = "Your profile picture was updated";
              document.body.append(alert);
              dialog.remove();
            };
          };
          document.querySelector("#edit").onclick = () => {
            if (!menu) return editor();
            const popup = document.createElement("div");
            popup.setAttribute("role", "menu");
            popup.setAttribute("aria-label", "Profile picture options for viewing and editing your photo");
            popup.innerHTML = '<a href="/photo/" role="menuitem">See profile picture</a><div role="menuitem" tabindex="-1"><span>Choose profile picture</span></div>';
            popup.querySelector("a").onclick = () => { throw new Error("clicked See instead of Choose"); };
            popup.querySelector("div").onclick = editor;
            document.body.append(popup);
          };
        }, menu);
        await page.addScriptTag({content: source});
        await page.evaluate(() => { window.__fbAvatar.operationId = "fixture"; });
        assert.equal(await page.evaluate(() => window.__fbAvatar.prepare()), "input");
        await page.locator('input[data-fb-avatar-upload="true"]').setInputFiles({name: "avatar.png", mimeType: "image/png", buffer: fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/icon/avatar-placeholder.png"))});
        assert.equal((await page.evaluate(() => window.__fbAvatar.save())).confirmed, true);
        assert.equal(await page.locator('[role="dialog"]').count(), 0);
        assert.ok((await page.evaluate(() => window.messages)).includes("fb_avatar_submitting"));
        console.log(`${menu ? "Profile menu" : "Direct edit"}: upload, activation and confirmed save passed`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

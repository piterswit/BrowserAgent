// Real Chromium DOM checks; no login, account mutations or external network requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright");
const folder = path.join(__dirname, "../WS Browser Bridge");
const source = name => fs.readFileSync(path.join(folder, name), "utf8");
const html = nested => `<!doctype html><style>
  body {margin:0; ${nested ? "height:100vh;overflow:hidden" : ""}}
  main {${nested ? "height:100vh;overflow-y:auto" : ""}}
  article {height:250px;border-bottom:1px solid #ddd}
  .hidden {display:none} .transparent {opacity:0;position:fixed;inset:0}
  </style><div class="hidden" role="dialog"></div><div class="transparent" role="menu"></div>
  <main role="main"><input type="search" autofocus aria-label="Empty search"><nav role="menu">Permanent navigation, not a popup</nav>${"<article>Scroll test content</article>".repeat(30)}</main>`;
async function inject(page, mode) {
  await page.evaluate(mode => {
    window.chrome = {runtime: {sendMessage: async () => {}}};
    window.__fbActivityRequest = {mode, runId: "browser-test"};
    Math.random = () => 0.5;
  }, mode);
  for (const file of ["activity_runtime.js", "activity_interactions.js", mode === "reels" ? "auto_reels.js" : "tools.js"]) {
    await page.addScriptTag({content: source(file)});
  }
}
async function main() {
  const browser = await chromium.launch({headless: true, channel: "chrome"});
  try {
    for (const mode of ["home", "group", "custom", "reels"]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body: html(true)}));
        await page.goto("https://www.facebook.com" + (mode === "reels" ? "/reel/123" : "/"));
        if (mode === "home") await page.evaluate(() => {
          // Simulate the visibility signal from an occluded window without changing browser settings.
          window.fixtureHidden = true;
          Object.defineProperty(document, "hidden", {configurable: true, get: () => window.fixtureHidden});
          document.hasFocus = () => false;
        });
        await inject(page, mode);
        assert.equal(await page.evaluate(() => window.__fbActivityCtrl.started), true);
        if (mode === "home") {
          await page.waitForTimeout(1600);
          assert.equal(await page.locator("main").evaluate(node => node.scrollTop), 0);
          assert.equal(await page.evaluate(() => window.__fbActivityCtrl.state), "等待中");
          await page.evaluate(() => { window.fixtureHidden = false; });
        }
        await page.waitForFunction(() => document.querySelector("main").scrollTop > 100, null, {timeout: 22000});
        await page.evaluate(() => window.__fbActivityRuntime.stop());
        const stopped = await page.locator("main").evaluate(node => node.scrollTop);
        await page.waitForTimeout(1500);
        assert.equal(await page.locator("main").evaluate(node => node.scrollTop), stopped);
        console.log(mode + ": real nested-container scrolling and stop passed (" + stopped + "px)" +
          (mode === "home" ? " after simulated hidden/visible recovery" : ""));
      } finally { await page.close(); }
    }
    for (const control of [false, true]) {
      const page = await browser.newPage({viewport: {width: 1000, height: 700}});
      try {
        await page.context().route("**/*", route => route.abort());
        await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body: `<!doctype html>
          <style>body{margin:0;overflow:hidden}main{display:flex;width:100vw;height:100vh;overflow-x:auto;scroll-snap-type:x mandatory}
          section{min-width:100vw;scroll-snap-align:start}video{width:400px;height:500px;margin:50px 200px}
          button{position:fixed;right:20px;top:300px}</style><main role="${control ? "main" : "dialog"}">
          ${"<section><video></video></section>".repeat(3)}
          ${control ? '<button aria-label="Next reel" onclick="this.parentElement.scrollBy({left:1000,behavior:\'instant\'});window.turns=(window.turns||0)+1">Next</button>' : ''}
          </main>`}));
        await page.goto("https://www.facebook.com/reel/123"); await inject(page, "reels");
        await page.waitForFunction(() => document.querySelector("main").scrollLeft >= 900, null, {timeout: 9000});
        if (control) assert.equal(await page.evaluate(() => window.turns), 1);
        await page.evaluate(() => window.__fbActivityRuntime.stop());
        const stopped = await page.locator("main").evaluate(node => node.scrollLeft);
        await page.waitForTimeout(1000);
        assert.equal(await page.locator("main").evaluate(node => node.scrollLeft), stopped);
        console.log("Reels " + (control ? "arrow" : "horizontal CSS snap") + ": passed (" + stopped + "px)");
      } finally { await page.close(); }
    }
    const page = await browser.newPage({viewport: {width: 1000, height: 700}});
    try {
      await page.context().route("**/*", route => route.abort());
      await page.route("https://www.facebook.com/**", route => route.fulfill({contentType: "text/html", body: html(false)}));
      await page.goto("https://www.facebook.com/"); await inject(page, "home");
      await page.waitForFunction(() => window.scrollY > 100, null, {timeout: 6000});
      await page.evaluate(() => {
        const popup = document.createElement("div"); popup.id = "visible-popup"; popup.setAttribute("role", "dialog");
        popup.style = "position:fixed;top:100px;left:100px;width:300px;height:100px;background:white";
        popup.innerHTML = '<button aria-label="Close">Dismiss</button>'; document.body.append(popup);
        popup.querySelector("button").onclick = () => popup.remove();
        if (!window.__fbActivityCtrl.canAct()) throw Error("Dismissed popup still blocked browsing");
      });
      assert.equal(await page.locator("#visible-popup").count(), 0);
      const continued = await page.evaluate(() => window.scrollY);
      await page.waitForFunction(start => window.scrollY > start, continued, {timeout: 10000});
      await page.evaluate(() => {
        const popup = document.createElement("div"); popup.id = "visible-popup"; popup.setAttribute("role", "dialog");
        popup.style = "position:fixed;top:100px;left:100px;width:300px;height:100px;background:white";
        popup.innerHTML = 'Confirm your identity <button aria-label="Close">Close</button>'; document.body.append(popup);
        popup.querySelector("button").onclick = () => popup.remove();
        window.__fbActivityCtrl.canAct();
      });
      assert.match(await page.evaluate(() => window.__fbActivityCtrl.detail), /安全验证/);
      const stopped = await page.evaluate(() => window.scrollY);
      await page.waitForTimeout(1500); assert.equal(await page.evaluate(() => window.scrollY), stopped);
      await page.evaluate(() => document.getElementById("visible-popup").remove());
      await page.waitForFunction(start => window.scrollY > start, stopped, {timeout: 10000});
      await page.evaluate(() => window.__fbActivityRuntime.stop());
      console.log("Window scrolling + ordinary-popup auto-close + protected-dialog pause/resume: passed");
    } finally { await page.close(); }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

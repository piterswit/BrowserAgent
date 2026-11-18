// Uses a genuinely background tab, with no visibility or timer overrides.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {connect, withBrowser} = require("./check_cover_browser.cjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = name => fs.readFileSync(path.join(__dirname, "../WS Browser Bridge", name), "utf8");

withBrowser(async port => {
  const targets = [], clients = [];
  try {
    const create = async () => {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"})).json();
      targets.push(target);
      const cdp = await connect(target.webSocketDebuggerUrl);
      clients.push(cdp);
      return cdp;
    };
    const page = await create();
    await page.call("Page.enable");
    page.events.set("Fetch.requestPaused", params => {
      page.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: "text/html"}],
        body: Buffer.from('<!doctype html><main style="height:30000px">Local activity fixture</main>').toString("base64")
      }).catch(console.error);
    });
    await page.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    const evaluate = async expression => {
      const result = await page.call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await page.call("Page.navigate", {url: "https://www.facebook.com/"});
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('document.readyState === "complete" && location.hostname === "www.facebook.com"')) break;
      await pause(50);
    }
    const foreground = await create();
    await foreground.call("Page.bringToFront");
    assert.equal(await evaluate("document.hidden"), true, "fixture must really be a background tab");
    for (const mode of ["home", "group", "custom", "reels"]) {
      await evaluate('scrollTo(0, 0); window.chrome = {runtime: {sendMessage: async () => ({})}}; ' +
        'window.__fbActivityRequest = ' + JSON.stringify({mode, runId: mode, background: true}));
      await evaluate(["fb_ui.js", "activity_runtime.js", "activity_interactions.js",
        mode === "reels" ? "auto_reels.js" : "tools.js"].map(source).join("\n"));
      let moved = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate("scrollY > 0")) { moved = true; break; }
        await pause(100);
      }
      assert.equal(moved, true, mode + " must scroll in the background");
      assert.equal(await evaluate("document.hidden"), true);
      await evaluate("window.__fbActivityRuntime.stop()");
      const stoppedAt = await evaluate("scrollY");
      await pause(1500);
      assert.equal(await evaluate("scrollY"), stoppedAt, "Stop must cancel remaining work");
      console.log(mode + ": real background scrolling and Stop passed");
    }
  } finally {
    for (const client of clients) client.close();
    for (const target of targets) await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });

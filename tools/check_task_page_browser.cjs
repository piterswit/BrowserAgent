// Real Chrome DOM checks; Facebook traffic is fulfilled locally, with no accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {connect, withBrowser} = require("./check_cover_browser.cjs");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/bg.js"), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("function taskPageState() {");
assert.ok(start >= 0);
const probe = source.slice(start, source.indexOf("\n}\n", start) + 2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

withBrowser(async port => {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"})).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    cdp.events.set("Fetch.requestPaused", params => {
      // An unfinished image reproduces the page being usable before load completes.
      if (params.request.url.endsWith("/slow.png")) return;
      cdp.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: "text/html"}],
        body: Buffer.from('<!doctype html><main>Ready controls</main><img src="/slow.png">').toString("base64")
      }).catch(() => {});
    });
    await cdp.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    await cdp.call("Page.navigate", {url: "https://www.facebook.com/friends/requests"});
    const evaluate = async expression => {
      const result = await cdp.call("Runtime.evaluate", {expression, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    let state;
    for (let i = 0; i < 100; i++) {
      state = await evaluate(`(${probe})()`);
      if (state?.ready) break;
      await pause(50);
    }
    assert.equal(state.ready, true);
    assert.equal(state.state, "interactive");
    for (const change of [
      'document.querySelector("main").style.display = "none"',
      'document.querySelector("main").style.display = "block"; document.querySelector("main").setAttribute("aria-hidden", "true")',
      'document.querySelector("main").removeAttribute("aria-hidden"); document.querySelector("main").style.opacity = "0"',
    ]) {
      await evaluate(change);
      assert.equal((await evaluate(`(${probe})()`)).ready, false);
    }
    console.log("Task page readiness: unfinished resource, visible/hidden/aria-hidden/transparent DOM checks passed");
  } finally { cdp.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });

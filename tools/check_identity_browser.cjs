// Run the actual injected identity reader against isolated Romanian DOM fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {connect, withBrowser} = require("./check_cover_browser.cjs");
const background = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/bg.js"), "utf8");
const readerSource = background.slice(background.indexOf("async function readProfileIdentity("),
  background.indexOf("async function loadAvatarThumbnail("));
const imageURL = "https://scontent.fixture.fbcdn.net/avatar.png";
const fixtureImage = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/icon/avatar-placeholder.png")).toString("base64");

withBrowser(async port => {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"})).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const response = await cdp.call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const read = vm.runInNewContext("(" + readerSource + ")", {chrome: {scripting: {
    executeScript: async options => [{result: await evaluate("(" + options.func + ")()") }]
  }}});
  try {
    await cdp.call("Page.enable");
    cdp.events.set("Fetch.requestPaused", params => {
      const image = params.request.url === imageURL;
      cdp.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: image ? "image/png" : "text/html; charset=utf-8"}],
        body: image ? fixtureImage : Buffer.from("<!doctype html><meta charset='utf-8'><body></body>").toString("base64")}).catch(console.error);
    });
    await cdp.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    const img = alt => `<img src="${imageURL}" alt="${alt}" style="width:168px;height:168px">`;
    const svg = `<svg width="168" height="168"><image href="${imageURL}" width="168" height="168" aria-label="Fotografia de profil"/></svg>`;
    for (const fixture of [
      {name: "named profile photo", html: img("Fotografia de profil a lui Alice Chen")},
      {name: "generic photo inside Romanian actions", html: `<div role="button" aria-label="Acțiuni privind fotografia de profil">${img("Fotografia de profil")}</div>`},
      {name: "SVG photo inside Romanian actions", html: `<div role="button" aria-label="Acțiuni privind fotografia de profil">${svg}</div>`},
      {name: "navigation menu fallback", html: "", nav: `<div role="button" aria-label="Profilul tău">${svg}</div>`},
      {name: "homepage own-profile SVG link", home: true, html: "", nav: `<a href="/alice" aria-label="Profilul tău">${svg}</a>`},
      {name: "foreign profile photo rejected", html: img("Fotografia de profil a lui Bob Smith"), missing: true},
      {name: "cover photo rejected", html: img("Fotografia de profil Alice Chen copertă"), missing: true},
      {name: "feed author photo rejected", html: `<article role="article">${img("Fotografia de profil a lui Alice Chen")}</article>`, missing: true},
    ]) {
      await cdp.call("Page.navigate", {url: "https://www.facebook.com/" + (fixture.home ? "" : "profile.php?id=123")});
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('document.readyState === "complete" && location.hostname === "www.facebook.com"')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const html = `<nav role="navigation">${fixture.nav || ""}</nav><main><h1>Alice Chen</h1>${fixture.html}</main>`;
      await evaluate(`document.documentElement.lang='ro'; document.title='Alice Chen | Facebook';
        document.body.innerHTML=${JSON.stringify(html)};
        window.require=()=>({USER_ID:'123',NAME:'Alice Chen'});`);
      await evaluate(`Promise.all([...document.images].map(image => image.decode())).then(() =>
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
      const identity = await read(target.id);
      assert.equal(identity.fb_name, "Alice Chen", fixture.name);
      assert.equal(identity.fb_id, "123", fixture.name);
      const diagnostic = identity.avatar_url || fixture.missing ? "" : JSON.stringify(await evaluate(`({url:location.href,
        images:[...document.querySelectorAll('img,svg image')].map(image=>({alt:image.getAttribute('alt'),
        label:image.getAttribute('aria-label'),rect:image.getBoundingClientRect().toJSON()}))})`));
      assert.equal(identity.avatar_url, fixture.missing ? null : imageURL, fixture.name + diagnostic);
      console.log("Romanian identity: " + fixture.name + " passed");
    }
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });

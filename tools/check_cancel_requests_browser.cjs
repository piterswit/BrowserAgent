// Isolated real DOM fixtures. All Facebook requests are fulfilled locally.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {connect, withBrowser} = require("./check_cover_browser.cjs");
const source = ["fb_ui.js", "cancel_friend_requests.js"].map(name =>
  fs.readFileSync(path.join(__dirname, "../WS Browser Bridge", name), "utf8")).join("\n");

function setup(options) {
  const realTimer = window.setTimeout.bind(window), wall = Date.now(), started = performance.now();
  // Accelerate only this isolated fixture's waits and its matching clock by the same factor.
  window.setTimeout = (fn, ms) => realTimer(fn, ms / 20);
  Date.now = () => wall + (performance.now() - started) * 20;
  const labels = options.labels || {sent: "View sent requests", cancel: "Cancel request"};
  document.body.innerHTML = '<button id="entry"></button><main><button id="wrong">Cancel request</button></main>';
  document.querySelector("#entry").textContent = labels.sent;
  window.clicked = [];
  window.wrongClicks = 0;
  document.querySelector("#wrong").onclick = () => window.wrongClicks++;
  let requests = Array.from({length: options.count || (options.virtual ? 12 : 2)}, (_, id) => id);
  const makeModal = () => {
    const modal = document.createElement("section");
    modal.setAttribute("role", "dialog");
    modal.style.cssText = "position:fixed;top:40px;left:50px;width:400px;background:white";
    modal.innerHTML = '<h2></h2><div id="pane" style="height:216px;overflow-y:auto;position:relative"></div>';
    modal.querySelector("h2").textContent = labels.sent;
    const pane = modal.querySelector("#pane");
    const slots = [];
    const row = () => {
      const node = document.createElement("div");
      node.style.cssText = "height:72px;position:absolute;left:0;right:0;background:#eee";
      node.innerHTML = '<a></a><span role="button" tabindex="0" style="display:inline-block;padding:10px"></span>';
      node.querySelector("span").textContent = labels.cancel;
      return node;
    };
    function render() {
      const start = options.virtual ? Math.floor(pane.scrollTop / 72) : 0;
      if (!options.recycled) pane.replaceChildren();
      let spacer = pane.querySelector(".spacer");
      if (!spacer) {
        spacer = document.createElement("div");
        spacer.className = "spacer";
        pane.append(spacer);
      }
      spacer.style.height = requests.length * 72 + "px";
      const shown = requests.slice(start, start + (options.virtual ? 4 : requests.length));
      shown.forEach((id, index) => {
        let node = options.recycled && slots[index];
        if (!node) { node = row(); slots[index] = node; pane.append(node); }
        node.hidden = false;
        node.style.top = (start + index) * 72 + "px";
        const link = node.querySelector("a"), button = node.querySelector("span");
        link.href = "/person" + id;
        link.textContent = "Person " + id + " ";
        button.setAttribute("aria-label", options.genericAria ? "Manage request for Person " + id : labels.cancel);
        button.setAttribute("aria-disabled", options.disabledPrefix && id < options.disabledPrefix ? "true" : "false");
        button.onclick = () => {
          window.clicked.push(id);
          if (options.stop) window.__fbCancelRequestsCtrl.stop();
          if (options.blockAfterClick) {
            const warning = document.createElement("div");
            warning.setAttribute("role", "alert");
            warning.textContent = "Please try again later";
            document.body.append(warning);
            return;
          }
          if (options.noResponse) return;
          const remove = () => {
            requests = requests.filter(value => value !== id);
            render();
          };
          if (options.confirm) {
            const confirmation = document.createElement("div");
            confirmation.setAttribute("role", "dialog");
            confirmation.innerHTML = '<h2>Cancel request?</h2><button>Cancel</button><button class="confirm"></button>';
            confirmation.querySelector(".confirm").textContent = labels.cancel;
            confirmation.querySelector("button").onclick = () => window.wrongClicks++;
            confirmation.querySelector(".confirm").onclick = () => { confirmation.remove(); remove(); };
            (options.nestedConfirm ? modal : document.body).append(confirmation);
          } else setTimeout(remove, options.delayed ? 1800 : 200);
        };
      });
      if (options.recycled) slots.slice(shown.length).forEach(node => { node.hidden = true; });
    }
    pane.onscroll = render;
    document.body.append(modal);
    render();
  };
  document.querySelector("#entry").onclick = makeModal;
  if (options.alreadyOpen) makeModal();
}

async function scenario(port, options) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: "PUT"})).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const result = await cdp.call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    await cdp.call("Page.enable");
    cdp.events.set("Fetch.requestPaused", params => {
      cdp.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: "text/html"}],
        body: Buffer.from("<!doctype html><body></body>").toString("base64")}).catch(console.error);
    });
    await cdp.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    await cdp.call("Page.navigate", {url: "https://www.facebook.com/friends/requests"});
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('document.readyState === "complete" && location.hostname === "www.facebook.com"')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate("(" + setup + ")(" + JSON.stringify(options) + ")");
    await evaluate("window.__fbCancelRequestOptions = " + JSON.stringify({limit: options.limit}));
    const result = await evaluate(source);
    const clicked = await evaluate("window.clicked");
    assert.equal(await evaluate("window.wrongClicks"), 0, "unrelated Cancel and out-of-dialog actions must remain untouched");
    assert.equal(new Set(clicked).size, clicked.length, "never repeat a request");
    if (options.stop || options.blockAfterClick) assert.equal(clicked.length, 1);
    else if (options.noResponse) {
      assert.equal(clicked.length, 2);
      assert.equal(result.confirmed, 0);
      assert.ok(result.error);
    } else {
      assert.equal(result.error, "", result.detail);
      const limit = Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 1000 ? options.limit : 100;
      const expected = Array.from({length: options.count || (options.virtual ? 12 : 2)}, (_, id) => id)
        .filter(id => id >= (options.disabledPrefix || 0)).reverse().slice(0, limit);
      assert.deepEqual(clicked, expected, "must process from the bottom and respect the per-run cap: " + result.detail);
      assert.equal(result.confirmed, clicked.length, result.detail);
    }
    if (options.blockAfterClick) assert.ok(result.error);
    assert.equal(await evaluate("window.__fbCancelRequestsCtrl"), null);
    console.log("cancel requests " + JSON.stringify(options) + ": passed");
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
}

withBrowser(async port => {
  for (const options of [{}, {genericAria: true}, {virtual: true}, {virtual: true, recycled: true},
    {virtual: true, limit: 3}, {virtual: true, recycled: true, limit: 5}, {virtual: true, count: 110},
    {virtual: true, disabledPrefix: 9}, {alreadyOpen: true}, {delayed: true}, {confirm: true},
    {confirm: true, nestedConfirm: true}, {noResponse: true}, {stop: true}, {blockAfterClick: true},
    {labels: {sent: "查看已发送的请求", cancel: "取消请求"}},
    {labels: {sent: "查看已傳送邀請", cancel: "取消邀請"}},
    {labels: {sent: "عرض الطلبات المرسلة", cancel: "إلغاء الطلب"}},
    {labels: {sent: "送信済みリクエストを表示", cancel: "リクエストをキャンセル"}}]) {
    await scenario(port, options);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });

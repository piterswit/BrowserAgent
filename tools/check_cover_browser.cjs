// Isolated Chrome fixtures. All Facebook traffic is fulfilled locally.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {randomUUID} = require("node:crypto");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const project = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(project, "WS Browser Bridge/fb_ui.js"), "utf8") + "\n" + fs.readFileSync(path.join(project, "WS Browser Bridge/change_cover.js"), "utf8");

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  let nextId = 0;
  const pending = new Map(), events = new Map();
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("Test browser connection closed"));
    pending.clear();
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    } else events.get(message.method)?.(message.params);
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        socket.send(JSON.stringify({id, method, params}));
      });
    },
    events,
    close: () => socket.close(),
  };
}

function setupFixture(labels, chooser, options) {
  document.documentElement.lang = labels.language || "en";
  document.documentElement.dir = labels.rtl ? "rtl" : "ltr";
  document.body.innerHTML = '<main><h1>Demo</h1><section><img id="cover" alt="cover photo" width="700" height="220"><button id="edit"></button></section></main>' +
    '<div role="dialog" aria-label="Settings"><button id="wrong">Save</button></div>';
  const picture = color => options.samePath ? "https://scontent.test.fbcdn.net/cover.jpg?variant=" + color :
    "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="220"><rect width="700" height="220" fill="' + color + '"/></svg>');
  document.querySelector("#cover").src = picture("blue");
  window.saved = false;
  window.messages = [];
  window.chrome = {runtime: {sendMessage: async message => {
    window.messages.push(message.cmd);
    return {accepted: message.cmd !== "fb_cover_submitting" || window.authorized !== false};
  }}};
  document.querySelector("#wrong").onclick = () => { throw new Error("unrelated Save button"); };
  const edit = document.querySelector("#edit");
  edit.textContent = labels.edit;
  edit.onclick = () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML = '<button id="upload"></button>';
    menu.querySelector("button").textContent = labels.upload;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    if (!chooser) menu.append(input);
    input.onchange = () => {
      if (!input.files.length) throw new Error("missing cover file");
      menu.remove();
      const editor = document.createElement("section");
      editor.innerHTML = '<img alt="cover photo preview" width="700" height="220"><button>Cancel</button><button id="save"></button>';
      if (options.background) {
        const preview = document.createElement("div");
        preview.setAttribute("role", "img");
        preview.setAttribute("aria-label", "cover photo preview");
        preview.style.cssText = 'width:700px;height:220px;background-image:url("' + picture("green") + '")';
        editor.querySelector("img").replaceWith(preview);
      } else {
        const preview = editor.querySelector("img");
        preview.src = picture(options.noPreview ? "blue" : "green");
        if (options.portrait) {
          preview.width = 220;
          preview.height = 440;
        }
        if (options.croppedPortrait) {
          preview.removeAttribute("alt");
          preview.width = 700;
          preview.height = 700;
          const crop = document.createElement("div");
          crop.style.cssText = "width:700px;height:220px;overflow:hidden";
          preview.replaceWith(crop);
          crop.append(preview);
        }
      }
      if (options.unrelatedFeed) {
        const article = document.createElement("article");
        article.setAttribute("role", "article");
        article.innerHTML = '<img alt="cover photo" width="700" height="220">';
        article.querySelector("img").src = picture("red");
        document.querySelector("main").append(article);
      }
      const save = editor.querySelector("#save");
      save.textContent = labels.save;
      if (options.ariaLabel) save.setAttribute("aria-label", "Save your cover photo");
      document.querySelector("main").append(editor);
      const toolbar = document.createElement("div");
      if (options.fixedToolbar) {
        toolbar.style.cssText = "position:fixed;bottom:0;left:0;right:0;background:white";
        toolbar.append(...editor.querySelectorAll("button"));
        document.body.append(toolbar);
      }
      save.onclick = () => {
        save.disabled = true;
        // A disabled Save button must not become a confirmed save.
        setTimeout(() => {
          document.querySelector("#cover").src = picture("green");
          window.saved = true;
          editor.remove();
          toolbar.remove();
        }, 400);
      };
    };
    menu.querySelector("button").onclick = () => {
      if (!input.isConnected) document.body.append(input);
      input.click();
    };
    document.body.append(menu);
  };
}

async function scenario(port, labels, chooser, denied = false, options = {}) {
  const response = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", {method: "PUT"});
  const target = await response.json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    cdp.events.set("Fetch.requestPaused", params => {
      const isImage = params.request.resourceType === "Image" || params.resourceType === "Image" ||
        params.request.url.startsWith("https://scontent.test.fbcdn.net/");
      const body = isImage ? '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="220"><rect width="700" height="220" fill="green"/></svg>' :
        "<!doctype html><body></body>";
      cdp.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: isImage ? "image/svg+xml" : "text/html; charset=utf-8"}],
        body: Buffer.from(body).toString("base64")}).catch(console.error);
    });
    await cdp.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    await cdp.call("Page.navigate", {url: "https://www.facebook.com/me"});
    const evaluate = async expression => {
      const result = await cdp.call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('location.hostname === "www.facebook.com" && document.readyState === "complete"')) break;
      await pause(50);
    }
    await evaluate("(" + setupFixture + ")(" + JSON.stringify(labels) + "," + chooser + "," + JSON.stringify(options) + ")");
    await evaluate(source);
    await evaluate('window.__fbCover.operationId = "fixture"; window.__fbCover.expires = Date.now() + 4000');
    assert.equal(await evaluate("window.__fbCover.prepare()"), chooser ? "chooser" : "input");
    const image = path.join(project, "WS Browser Bridge/icon/avatar-placeholder.png");
    if (chooser) {
      await cdp.call("Page.setInterceptFileChooserDialog", {enabled: true});
      const point = await evaluate("window.__fbCover.upload()");
      const selected = new Promise((resolve, reject) => {
        cdp.events.set("Page.fileChooserOpened", params => {
          cdp.call("DOM.setFileInputFiles", {backendNodeId: params.backendNodeId, files: [image]}).then(resolve, reject);
        });
      });
      await cdp.call("Input.dispatchMouseEvent", {type: "mousePressed", ...point, button: "left", clickCount: 1});
      await cdp.call("Input.dispatchMouseEvent", {type: "mouseReleased", ...point, button: "left", clickCount: 1});
      await selected;
    } else {
      const {root} = await cdp.call("DOM.getDocument");
      const {nodeId} = await cdp.call("DOM.querySelector", {nodeId: root.nodeId, selector: 'input[data-fb-cover-upload="true"]'});
      await cdp.call("DOM.setFileInputFiles", {nodeId, files: [image]});
    }
    if (denied) {
      await evaluate("window.authorized = false");
      await assert.rejects(evaluate("window.__fbCover.save()"));
      assert.equal(await evaluate("window.saved"), false);
      assert.ok((await evaluate("window.messages")).includes("fb_cover_submitting"));
    } else if (options.noPreview) {
      await assert.rejects(evaluate("window.__fbCover.save()"), /任务已过期/);
      assert.equal(await evaluate("window.saved"), false);
      assert.ok(!(await evaluate("window.messages")).includes("fb_cover_submitting"));
    } else {
      if (options.uploadDelay) {
        await evaluate('document.querySelector("#save").disabled = true; setTimeout(() => document.querySelector("#save").disabled = false, 500)');
      }
      assert.equal((await evaluate("window.__fbCover.save()")).confirmed, true);
      assert.equal(await evaluate("window.saved"), true);
      assert.ok((await evaluate("window.messages")).includes("fb_cover_submitting"));
    }
    const result = denied ? "denied save" : options.noPreview ? "no preview, no save" : "confirmed save";
    console.log(labels.edit + " / " + (chooser ? "chooser" : "input") + " / " + result +
      " " + JSON.stringify(options) + ": passed");
  } finally {
    cdp.close();
    await fetch("http://127.0.0.1:" + port + "/json/close/" + target.id);
  }
}

async function waitForDevToolsEndpoint(file, {read = fs.promises.readFile, wait = pause, attempts = 150,
  stopped = () => false} = {}) {
  let last = "file not ready";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (stopped()) throw new Error("Fixture browser exited before DevTools became ready");
    try {
      const [number, endpoint] = (await read(file, "utf8")).split(/\r?\n/);
      const port = Number(number);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(endpoint || "")) {
        return {port, endpoint};
      }
      last = "incomplete DevTools endpoint";
    } catch (error) {
      if (!["ENOENT", "EBUSY", "EPERM"].includes(error.code)) throw error;
      last = error.code;
    }
    await wait(100);
  }
  throw new Error("Fixture browser DevTools startup timed out: " + last);
}

async function withBrowser(check) {
  const chrome = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  ].find(file => file && fs.existsSync(file));
  assert.ok(chrome, "Chrome or Edge is required");
  const cache = path.resolve(project, ".audit-venv");
  const profile = path.resolve(cache, "cover-fixtures-" + randomUUID());
  assert.ok(profile.startsWith(cache + path.sep));
  fs.mkdirSync(profile, {recursive: true});
  const browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"],
  {stdio: "ignore", windowsHide: true});
  let controller;
  try {
    const activePort = path.join(profile, "DevToolsActivePort");
    const {port, endpoint} = await waitForDevToolsEndpoint(activePort, {
      stopped: () => browser.exitCode !== null || browser.signalCode !== null,
    });
    controller = await connect("ws://127.0.0.1:" + port + endpoint);
    await check(port);
  } finally {
    const exited = () => browser.exitCode !== null || browser.signalCode !== null;
    const closed = exited() ? Promise.resolve() : new Promise(resolve => browser.once("exit", resolve));
    const bounded = async (promise, timeout) => {
      let timer;
      try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, timeout); })]); }
      finally { clearTimeout(timer); }
    };
    // Browser.close lets macOS Chrome helpers flush and exit before their profile is removed.
    if (controller) await bounded(controller.call("Browser.close").catch(() => {}), 3000);
    controller?.close();
    if (!exited()) await bounded(closed, 5000);
    if (!exited()) { browser.kill(); await bounded(closed, 3000); }
    if (!exited()) { browser.kill("SIGKILL"); await bounded(closed, 3000); }
    const actualCache = fs.realpathSync(cache);
    assert.ok(actualCache.startsWith(fs.realpathSync(project) + path.sep));
    assert.ok(fs.realpathSync(profile).startsWith(actualCache + path.sep));
    await fs.promises.rm(profile, {recursive: true, force: true, maxRetries: 20, retryDelay: 200});
  }
}

async function main() {
  await withBrowser(async port => {
    const languages = [
      {edit: "Edit cover photo", upload: "Upload photo", save: "Save changes"},
      {edit: "编辑封面照片", upload: "上传照片", save: "保存更改"},
      {edit: "編輯封面相片", upload: "上傳相片", save: "儲存變更"},
    ];
    for (const labels of languages) {
      await scenario(port, labels, false);
      await scenario(port, labels, true);
    }
    await scenario(port, languages[0], false, true);
    await scenario(port, languages[1], false, false, {fixedToolbar: true});
    await scenario(port, languages[1], false, false, {fixedToolbar: true, background: true});
    await scenario(port, languages[0], false, false, {portrait: true});
    await scenario(port, languages[0], false, false, {samePath: true});
    await scenario(port, languages[0], false, false, {ariaLabel: true});
    await scenario(port, languages[0], false, false, {fixedToolbar: true, uploadDelay: true});
    await scenario(port, languages[0], false, false, {croppedPortrait: true});
    await scenario(port, languages[0], false, false, {fixedToolbar: true, noPreview: true, unrelatedFeed: true});
  });
}

module.exports = {connect, scenario, withBrowser, waitForDevToolsEndpoint};
if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

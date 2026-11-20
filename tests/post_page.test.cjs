const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const source = ["fb_ui.js", "publish_post.js"].map(name =>
  fs.readFileSync(path.join(__dirname, "../WS Browser Bridge", name), "utf8")).join("\n");

function page(options = {}) {
  let clock = 0, open = false, preview = !!options.existingImage, published = 0;
  const messages = [];
  class Input {}
  class TextArea {
    constructor() { this._value = options.draft || ""; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
  }
  const node = label => ({isConnected: true, offsetWidth: 80, innerText: label,
    getAttribute: name => name === "aria-label" ? label : null,
    getClientRects: () => [{}], scrollIntoView() {}, querySelectorAll: () => [],
    dispatchEvent() {}, focus() {}, click() {}});
  const editor = Object.assign(new TextArea(), node(""));
  const secondEditor = Object.assign(new TextArea(), node(""));
  let currentEditor = editor;
  const input = Object.assign(new Input(), node(""), {accept: "image/*", dataset: {}});
  const remove = node("Remove photo");
  const publish = Object.assign(node("Post"), {disabled: !!options.disabled});
  const photo = Object.assign(node("Photo/video"), {click() {
    if (options.chooser) preview = true;
  }});
  const dialog = Object.assign(node("Create post"), {querySelectorAll(selector) {
    if (selector.includes("contenteditable")) return options.multipleEditors ? [currentEditor, secondEditor] : [currentEditor];
    if (selector.includes('input[type="file"]')) return [input];
    if (selector.includes("img[")) return [];
    if (selector.includes("progressbar")) return options.busy ? [node("")] : [];
    if (selector === '[role="button"], button') return options.multiplePublish ? [publish, publish] : [publish];
    return [photo, publish, ...(preview ? [remove] : [])];
  }});
  const launch = Object.assign(node(options.composer || "Create post"), {click() { open = true; }});
  const launchParent = Object.assign(node(options.composer || "Create post"), {contains: other => other === launch});
  const main = Object.assign(node(""), {querySelectorAll: () => options.multipleLaunch ? [launch, launch] :
    options.nestedLaunch ? [launchParent, launch] : [launch]});
  const emptyMain = Object.assign(node(""), {querySelectorAll: () => []});
  const notice = node(options.notice || "Your post has been published");
  publish.click = () => { published++; if (!options.keepOpen) dialog.isConnected = false; };
  const window = {__fbPostRequest: {operationId: "post-1", text: "Hello from a test", hasImage: !!options.image}};
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const context = vm.createContext({window, HTMLInputElement: Input, HTMLTextAreaElement: TextArea,
    InputEvent: class {}, Event: class {}, Date: {now: () => clock},
    setTimeout: fn => { clock += 1000; queueMicrotask(fn); },
    getComputedStyle: () => ({visibility: "visible", display: "block"}),
    location: {hostname: "www.facebook.com", pathname: "/me"},
    document: {querySelector: () => main, querySelectorAll: selector => {
      if (selector === '[role="main"], main') return options.multipleMains ? [emptyMain, main] : [main];
      if (selector === '[role="dialog"]') return open ? options.multipleDialogs ? [dialog, dialog] : [dialog] : [];
      if (selector.includes('[role="alert"]')) return published || options.staleNotice ? [notice] : [];
      return [];
    }},
    chrome: {runtime: {sendMessage: async message => {
      messages.push(message);
      if (message.cmd === "fb_post_result") { resolve(message); return {accepted: true}; }
      if (message.cmd === "fb_post_upload") {
        if (options.uploadDenied) return {accepted: false};
        preview = !options.noPreview;
        if (options.replaceAfterUpload) {
          secondEditor.value = options.loseText ? "" : editor.value;
          currentEditor = secondEditor;
        }
      }
      if (message.cmd === "fb_post_submitting") {
        if (options.cancel) window.__fbPostController.stop();
        if (options.editDuringAuth) editor.value = "Changed by user";
        if (options.imageDuringAuth) preview = !preview;
        if (options.replaceEditor) options.multipleEditors = true;
        if (options.replaceDuringAuth) {
          secondEditor.value = options.loseText ? "" : editor.value;
          currentEditor = secondEditor;
        }
        if (options.loginDuringAuth) context.location.pathname = "/login";
      }
      return {accepted: !options.denied};
    }}}
  });
  const inject = () => vm.runInContext(source, context);
  inject();
  if (options.reinject) inject();
  return {result, window, messages, input, published: () => published, editor};
}

for (const options of [{}, {image: true}, {image: true, chooser: true}, {reinject: true},
  {composer: "有什么新鲜事，Sophia？"}, {composer: "有什麼新鮮事，Sophia？"},
  {multipleMains: true}, {nestedLaunch: true}, {image: true, replaceAfterUpload: true},
  {replaceDuringAuth: true}]) {
  test("post succeeds exactly once " + JSON.stringify(options), async () => {
    const p = page(options), result = await p.result;
    assert.equal(result.success, true, result.detail);
    assert.equal(result.confirmed, true, result.detail);
    assert.equal(p.published(), 1);
    assert.equal(p.editor.value, "Hello from a test");
    assert.equal(p.input.dataset.browseragentPostUpload, undefined);
  });
}

for (const options of [
  {draft: "Existing draft"}, {existingImage: true}, {multipleEditors: true},
  {multipleDialogs: true}, {multiplePublish: true}, {multipleLaunch: true},
  {disabled: true}, {busy: true}, {image: true, uploadDenied: true},
  {image: true, noPreview: true}, {denied: true}, {cancel: true},
  {editDuringAuth: true}, {image: true, imageDuringAuth: true},
  {imageDuringAuth: true}, {replaceEditor: true}, {loginDuringAuth: true},
  {image: true, replaceAfterUpload: true, loseText: true}, {replaceDuringAuth: true, loseText: true},
]) {
  test("unsafe post never clicks Publish " + JSON.stringify(options), async () => {
    const p = page(options), result = await p.result;
    assert.equal(result.success, false, result.detail);
    assert.equal(result.submitted, false);
    assert.equal(p.published(), 0);
    assert.equal(p.messages.filter(message => message.cmd === "fb_post_result").length, 1);
    assert.equal(p.input.dataset.browseragentPostUpload, undefined);
    if (options.draft) assert.equal(p.editor.value, options.draft);
  });
}

test("timeout diagnostics name the failed step instead of unrelated navigation", async () => {
  const result = await page({composer: "Unrecognized composer"}).result;
  assert.match(result.detail, /发帖入口/);
  assert.match(result.detail, /Unrecognized composer/);
});

for (const options of [{notice: "Post has not been published"}, {staleNotice: true}, {notice: "Uploading post"}]) {
  test("unconfirmed submissions are never retried " + JSON.stringify(options), async () => {
    const p = page(options), result = await p.result;
    assert.equal(result.success, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.submitted, true);
    assert.equal(p.published(), 1);
  });
}

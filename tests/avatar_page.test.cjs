const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/change_avatar.js"), "utf8");

function page({input = true, changed = true, error = ""} = {}) {
  let clock = 0, open = false, scrolled = false;
  const element = text => ({
    textContent: text, disabled: false, getAttribute: name => name === "aria-label" ? text : null,
    getClientRects: () => [{}], closest: () => null,
    getBoundingClientRect: () => ({left: 10, top: 20, width: 80, height: 60}),
    scrollIntoView: () => { scrolled = true; }
  });
  const picture = {...element(""), currentSrc: "old-avatar.png"};
  const container = {isConnected: true, querySelectorAll: () => [picture]};
  const file = {accept: "image/*", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }};
  const upload = element("Upload photo"), save = element("Save"), edit = element("Edit profile picture");
  const dialog = {...element("Update profile picture Upload photo Save"), isConnected: true,
    querySelectorAll: selector => selector === 'input[type="file"]' ? (input ? [file] : []) : [upload, save]};
  save.closest = () => dialog;
  save.click = () => { dialog.isConnected = false; open = false; if (changed) picture.currentSrc = "new-avatar.png"; };
  edit.parentElement = container;
  edit.click = () => { open = true; };
  const wrongSave = {...element("Save"), click() { throw new Error("clicked unrelated settings dialog"); }};
  const wrongDialog = {...element("Settings"), querySelectorAll: () => [wrongSave]};
  const window = {__reelCtrl: {run: true}};
  const context = vm.createContext({window,
    Date: {now: () => clock}, setTimeout: fn => { clock += 300; queueMicrotask(fn); },
    getComputedStyle: () => ({visibility: "visible"}),
    document: {querySelectorAll: selector => {
      if (selector === '[role="dialog"]') return open ? [dialog, wrongDialog] : [];
      if (selector.includes('[role="alert"]')) return error ? [element(error)] : [];
      return [edit];
    }}
  });
  vm.runInContext(source, context);
  return {api: window.__fbAvatar, file, window, scrolled: () => scrolled};
}

test("finds the avatar input and confirms changed picture after saving", async () => {
  const p = page();
  assert.equal(await p.api.prepare(), "input");
  assert.equal(p.file.attributes["data-fb-avatar-upload"], "true");
  assert.equal(p.window.__reelCtrl.run, false);
  assert.equal((await p.api.save()).confirmed, true);
});

test("chooser fallback returns click coordinates", async () => {
  const p = page({input: false});
  assert.equal(await p.api.prepare(), "chooser");
  const point = await p.api.upload();
  assert.equal(point.x, 50);
  assert.equal(point.y, 50);
  assert.equal(p.scrolled(), true);
});

test("dialog closure without a changed picture remains unconfirmed", async () => {
  const p = page({changed: false});
  await p.api.prepare();
  assert.equal((await p.api.save()).confirmed, false);
});

test("visible Facebook errors do not become success", async () => {
  const p = page({error: "Upload failed"});
  await p.api.prepare();
  await assert.rejects(p.api.save(), /Upload failed/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/change_avatar.js"), "utf8");

function page({input = true, changed = true, error = "", success = "", menu = false, accepted = true, labels = {upload: "Upload photo", save: "Save", edit: "Edit profile picture", picture: "Alice's profile picture", choose: "Choose profile picture", see: "See profile picture"}} = {}) {
  let clock = 0, open = false, scrolled = false, menuOpen = false;
  const messages = [];
  const element = text => ({
    textContent: text, disabled: false, getAttribute: name => name === "aria-label" ? text : null,
    querySelectorAll: () => [],
    getClientRects: () => [{}], closest: () => null,
    getBoundingClientRect: () => ({left: 10, top: 20, width: 80, height: 60}),
    scrollIntoView: () => { scrolled = true; }
  });
  const picture = {...element(""), currentSrc: "old-avatar.png", getBoundingClientRect: () => ({width: 168, height: 168})};
  const container = {isConnected: true, querySelectorAll: () => [picture]};
  const file = {accept: "image/*", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }};
  const upload = element(labels.upload), save = element(labels.save), edit = element(menu ? labels.picture : labels.edit);
  if (menu) edit.getBoundingClientRect = () => ({width: 168, height: 168, top: 120});
  const choose = {...element(labels.choose), click() { menuOpen = false; open = true; }};
  const see = {...element(labels.see), click() { throw new Error("must not view photo"); }};
  const dialog = {...element(`${labels.edit} ${labels.upload} ${labels.save}`), isConnected: true,
    querySelectorAll: selector => selector === 'input[type="file"]' ? (input ? [file] : []) : [upload, save]};
  save.closest = selector => selector === '[role="dialog"]' ? dialog : null;
  save.click = () => { dialog.isConnected = false; open = false; if (changed) picture.currentSrc = "new-avatar.png"; };
  edit.parentElement = container;
  edit.click = () => { if (menu) menuOpen = true; else open = true; };
  const wrongSave = {...element("Save"), click() { throw new Error("clicked unrelated settings dialog"); }};
  const wrongDialog = {...element("Settings"), querySelectorAll: () => [wrongSave]};
  const window = {__reelCtrl: {run: true}};
  const context = vm.createContext({window, URL, location: {href: "https://www.facebook.com/me"},
    chrome: {runtime: {sendMessage: async message => { messages.push(message); return {accepted}; }}},
    Date: {now: () => clock}, setTimeout: fn => { clock += 300; queueMicrotask(fn); },
    getComputedStyle: () => ({visibility: "visible"}),
    document: {querySelectorAll: selector => {
      if (selector === '[role="dialog"]') return open ? [dialog, wrongDialog] : [];
      if (selector === '[role="menu"] [role="menuitem"]') return menuOpen ? [see, choose] : [];
      if (selector.includes('[role="alert"]')) return error ? [element(error)] : success && !dialog.isConnected ? [element(success)] : [];
      return [edit];
    }}
  });
  vm.runInContext(source, context);
  return {api: window.__fbAvatar, file, window, messages, scrolled: () => scrolled};
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

test("profile avatar opens the menu and selects Choose, never See", async () => {
  const p = page({menu: true});
  assert.equal(await p.api.prepare(), "input");
  assert.equal((await p.api.save()).confirmed, true);
});

test("save submission is acknowledged before clicking Save", async () => {
  const p = page();
  p.api.operationId = "operation";
  await p.api.prepare();
  await p.api.save();
  assert.deepEqual(p.messages.map(message => message.cmd), ["fb_avatar_activate", "fb_avatar_activate", "fb_avatar_submitting"]);
});

test("expired task cannot click Save", async () => {
  const p = page({accepted: false});
  await p.api.prepare();
  p.api.operationId = "expired";
  await assert.rejects(p.api.save(), /无法激活/);
});

for (const labels of [
  {upload: "上传照片", save: "保存", edit: "编辑头像", picture: "Alice的头像", choose: "选择头像", see: "查看头像", success: "头像已更新", error: "上传失败"},
  {upload: "上傳相片", save: "儲存", edit: "編輯大頭貼", picture: "Alice的大頭貼", choose: "選擇大頭貼", see: "檢視大頭貼", success: "大頭貼已更新", error: "上傳失敗"},
  {upload: "上傳照片", save: "儲存", edit: "編輯頭像", picture: "Alice的頭像", choose: "選擇頭像", see: "查看頭像", success: "頭像已儲存", error: "發生錯誤"}
]) {
  for (const menu of [false, true]) test(`${labels.edit}: ${menu ? "menu" : "direct"} upload and save`, async () => {
    const p = page({labels, menu, changed: false, success: labels.success});
    assert.equal(await p.api.prepare(), "input");
    assert.equal((await p.api.save()).confirmed, true);
  });
  test(`${labels.edit}: localized upload error remains a failure`, async () => {
    const p = page({labels, error: labels.error});
    await p.api.prepare();
    await assert.rejects(p.api.save(), error => error.message === labels.error);
  });
}

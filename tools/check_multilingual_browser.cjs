const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {connect, scenario, withBrowser} = require("./check_cover_browser.cjs");
const project = path.resolve(__dirname, "..");
const uiSource = fs.readFileSync(path.join(project, "WS Browser Bridge/fb_ui.js"), "utf8");
const postSource = fs.readFileSync(path.join(project, "WS Browser Bridge/publish_post.js"), "utf8");

const languages = [
  {language: "es-MX", edit: "Editar foto de portada", upload: "Subir foto", save: "Guardar cambios",
    composer: "¿Qué estás pensando, Ana?", photo: "Foto/video", remove: "Eliminar foto", publish: "Publicar", notice: "Tu publicación se ha publicado"},
  {language: "pt-BR", edit: "Editar foto da capa", upload: "Carregar foto", save: "Salvar alterações",
    composer: "No que você está pensando, Ana?", photo: "Foto/vídeo", remove: "Remover foto", publish: "Publicar", notice: "Sua publicação foi publicada"},
  {language: "fr-FR", edit: "Modifier la photo de couverture", upload: "Importer une photo", save: "Enregistrer les modifications",
    composer: "Quoi de neuf, Alice ?", photo: "Photo/vidéo", remove: "Supprimer la photo", publish: "Publier", notice: "Votre publication a été publiée"},
  {language: "de-DE", edit: "Titelbild bearbeiten", upload: "Foto hochladen", save: "Änderungen speichern",
    composer: "Was machst du gerade, Anna?", photo: "Foto/Video", remove: "Foto entfernen", publish: "Posten", notice: "Dein Beitrag wurde veröffentlicht"},
  {language: "ru-RU", edit: "Редактировать фото обложки", upload: "Загрузить фото", save: "Сохранить изменения",
    composer: "Что у вас нового, Анна?", photo: "Фото/видео", remove: "Удалить фото", publish: "Опубликовать", notice: "Публикация опубликована"},
  {language: "vi-VN", edit: "Chỉnh sửa ảnh bìa", upload: "Tải ảnh lên", save: "Lưu thay đổi",
    composer: "Bạn đang nghĩ gì, An?", photo: "Ảnh/video", remove: "Gỡ ảnh", publish: "Đăng", notice: "Bài viết đã được đăng"},
  {language: "ja-JP", edit: "カバー写真を編集", upload: "写真をアップロード", save: "変更を保存",
    composer: "投稿を作成", photo: "写真・動画", remove: "写真を削除", publish: "投稿", notice: "投稿が公開されました"},
  {language: "ko-KR", edit: "커버 사진 수정", upload: "사진 업로드", save: "변경 내용 저장",
    composer: "게시물 만들기", photo: "사진/동영상", remove: "사진 삭제", publish: "게시", notice: "게시물이 게시되었습니다"},
  {language: "ar-EG", rtl: true, edit: "تعديل صورة الغلاف", upload: "تحميل صورة", save: "\u200fحفظ التغييرات",
    composer: "إنشاء منشور", photo: "صورة/فيديو", remove: "إزالة الصورة", publish: "نشر", notice: "تم نشر المنشور"},
  {language: "th-TH", edit: "แก้ไขรูปภาพหน้าปก", upload: "อัปโหลดรูปภาพ", save: "บันทึกการเปลี่ยนแปลง",
    composer: "สร้างโพสต์", photo: "รูปภาพ/วิดีโอ", remove: "ลบรูปภาพ", publish: "โพสต์", notice: "โพสต์เผยแพร่แล้ว"},
];

function setupPost(labels, hasImage, deny, options = {}) {
  document.documentElement.lang = labels.language;
  document.documentElement.dir = labels.rtl ? "rtl" : "ltr";
  document.body.innerHTML = '<main><button id="composer"></button></main>';
  document.querySelector("#composer").textContent = labels.composer;
  if (options.emptyMain) document.body.prepend(document.createElement("main"));
  if (options.nestedControls) {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "button");
    document.querySelector("main:has(#composer)").append(wrapper);
    wrapper.append(document.querySelector("#composer"));
  }
  if (options.rejectedInput) document.execCommand = () => false;
  window.clicks = 0;
  window.uploaded = false;
  window.postResult = new Promise(resolve => { window.reportResult = resolve; });
  window.chrome = {runtime: {sendMessage: async message => {
    if (message.cmd === "fb_post_result") {
      window.reportResult(message);
      return {accepted: true};
    }
    if (message.cmd === "fb_post_upload") {
      return new Promise(resolve => {
        window.uploadResult = resolve;
        window.fixtureUpload("upload");
      });
    }
    if (message.cmd === "fb_post_submitting") {
      if (options.cancelDuringAuth) window.__fbPostController.stop();
      if (options.editDuringAuth) document.querySelector('[role="textbox"]').textContent = "User changed this draft";
      if (options.replaceDuringAuth) {
        const old = document.querySelector('[role="textbox"]');
        const replacement = old.cloneNode(true);
        if (options.loseText) replacement.textContent = "";
        old.replaceWith(replacement);
      }
      if (options.disableDuringAuth) document.querySelector("#publish").parentElement.setAttribute("aria-disabled", "true");
      if (options.removeDuringAuth) {
        for (const node of document.querySelectorAll('img, [data-remove-photo]')) node.remove();
      }
    }
    return {accepted: !deny && (!hasImage || window.uploaded)};
  }}};
  document.querySelector("#composer").onclick = () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = '<div contenteditable="true" role="textbox" style="min-height:60px;border:1px solid"></div>' +
      '<button id="photo"></button><input type="file" accept="image/*" hidden><button id="publish"></button>';
    const input = dialog.querySelector("input");
    if (options.draft) dialog.querySelector('[role="textbox"]').textContent = "Existing user draft";
    const publish = dialog.querySelector("#publish");
    dialog.querySelector("#photo").textContent = labels.photo;
    publish.textContent = labels.publish;
    if (options.nestedControls) {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("role", "button");
      publish.replaceWith(wrapper);
      wrapper.append(publish);
    }
    publish.disabled = hasImage;
    dialog.querySelector("#photo").onclick = () => input.click();
    input.onchange = () => {
      if (options.replaceAfterUpload) {
        const old = dialog.querySelector('[role="textbox"]');
        const replacement = old.cloneNode(true);
        if (options.loseText) replacement.textContent = "";
        old.replaceWith(replacement);
      }
      const image = document.createElement("img");
      image.style.cssText = "width:80px;height:80px";
      image.src = URL.createObjectURL(input.files[0]);
      image.onload = () => { window.uploaded = true; publish.disabled = false; };
      const remove = document.createElement("button");
      remove.setAttribute("aria-label", labels.remove);
      remove.dataset.removePhoto = "true";
      dialog.append(image, remove);
    };
    publish.onclick = () => {
      if (deny || (hasImage && !window.uploaded)) throw new Error("premature publish");
      if (dialog.querySelector('[role="textbox"]').innerText !== (options.text || "A local multilingual fixture.")) {
        throw new Error("wrong post content");
      }
      window.clicks++;
      dialog.remove();
      const notice = document.createElement("div");
      notice.setAttribute("role", "status");
      notice.textContent = labels.notice;
      document.body.append(notice);
    };
    document.body.append(dialog);
  };
}

async function postScenario(port, labels, hasImage, deny = false, options = {}) {
  const target = await (await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", {method: "PUT"})).json();
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Runtime.addBinding", {name: "fixtureUpload"});
    await cdp.call("Page.setInterceptFileChooserDialog", {enabled: true});
    cdp.events.set("Fetch.requestPaused", params => {
      cdp.call("Fetch.fulfillRequest", {requestId: params.requestId, responseCode: 200,
        responseHeaders: [{name: "Content-Type", value: "text/html"}],
        body: Buffer.from("<!doctype html><body></body>").toString("base64")}).catch(console.error);
    });
    await cdp.call("Fetch.enable", {patterns: [{urlPattern: "*"}]});
    await cdp.call("Page.navigate", {url: "https://www.facebook.com/me"});
    const evaluate = async expression => {
      const result = await cdp.call("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    cdp.events.set("Runtime.bindingCalled", async params => {
      if (params.name !== "fixtureUpload") return;
      try {
        const {root} = await cdp.call("DOM.getDocument");
        const {nodeId} = await cdp.call("DOM.querySelector", {nodeId: root.nodeId, selector: 'input[data-browseragent-post-upload="true"]'});
        await cdp.call("DOM.setFileInputFiles", {nodeId, files: [path.join(project, "WS Browser Bridge/icon/avatar-placeholder.png")]});
        await evaluate("window.uploadResult({accepted: true})");
      } catch (error) {
        await evaluate("window.uploadResult({accepted: false, detail: " + JSON.stringify(error.message) + "})");
      }
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('location.hostname === "www.facebook.com" && document.readyState === "complete"')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate("(" + setupPost + ")(" + JSON.stringify(labels) + "," + hasImage + "," + deny + "," + JSON.stringify(options) + ")");
    await evaluate("window.__fbPostRequest = " + JSON.stringify({operationId: "fixture",
      text: options.text || "A local multilingual fixture.", hasImage}));
    await evaluate(uiSource + "\n" + postSource);
    if (options.reinject) await evaluate(uiSource + "\n" + postSource);
    const result = await evaluate("Promise.race([window.postResult, new Promise((_, reject) => setTimeout(() => reject(new Error('Post fixture timed out')), 12000))])");
    const expected = !deny && !options.draft && !options.cancelDuringAuth && !options.editDuringAuth &&
      !options.removeDuringAuth && !options.loseText && !options.rejectedInput && !options.disableDuringAuth;
    assert.equal(result.success, expected, result.detail);
    assert.equal(result.confirmed, expected, result.detail);
    assert.equal(await evaluate("window.clicks"), expected ? 1 : 0);
    console.log(labels.language + ": " + (deny ? "denied post" : hasImage ? "photo post" : "text post") +
      " " + JSON.stringify(options) + " passed");
  } finally {
    cdp.close();
    await fetch("http://127.0.0.1:" + port + "/json/close/" + target.id);
  }
}

async function main() { await withBrowser(async port => {
  for (const labels of languages) {
    await scenario(port, labels, true, false, {fixedToolbar: true});
    await postScenario(port, labels, false);
    await postScenario(port, labels, true);
  }
  await postScenario(port, languages[8], true, true);
}); }

module.exports = {postScenario, languages};
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

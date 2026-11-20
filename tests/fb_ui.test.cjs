const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../WS Browser Bridge/fb_ui.js"), "utf8");

function fixture(language = "en") {
  const window = {};
  const document = {documentElement: {lang: language}, querySelector: () => null};
  const context = vm.createContext({window, document});
  vm.runInContext(source, context);
  return {ui: window.__fbUI, document, window, context};
}

// Independent examples exercise the public recognition API, including regional locales.
const examples = [
  ["en-GB", "Edit cover photo", "Save changes", "Post", "Like"],
  ["zh-CN", "编辑封面照片", "保存更改", "发布", "点赞"],
  ["zh-Hant-HK", "編輯封面相片", "儲存變更", "發佈", "按讚"],
  ["es-MX", "Editar foto de portada", "Guardar cambios", "Publicar", "Me gusta"],
  ["pt-BR", "Editar foto da capa", "Salvar alterações", "Publicar", "Curtir"],
  ["fr-FR", "Modifier la photo de couverture", "Enregistrer les modifications", "Publier", "J’aime"],
  ["de-DE", "Titelbild bearbeiten", "Änderungen speichern", "Posten", "Gefällt mir"],
  ["it-IT", "Modifica immagine di copertina", "Salva le modifiche", "Pubblica", "Mi piace"],
  ["nl-NL", "Omslagfoto bewerken", "Wijzigingen opslaan", "Plaatsen", "Vind ik leuk"],
  ["ru-RU", "Редактировать фото обложки", "Сохранить изменения", "Опубликовать", "Нравится"],
  ["uk-UA", "Редагувати світлину обкладинки", "Зберегти зміни", "Опублікувати", "Подобається"],
  ["pl-PL", "Edytuj zdjęcie w tle", "Zapisz zmiany", "Opublikuj", "Lubię to"],
  ["tr-TR", "Kapak fotoğrafını düzenle", "Değişiklikleri kaydet", "Paylaş", "Beğen"],
  ["ar-EG", "تعديل صورة الغلاف", "\u200fحفظ التغييرات\u200e", "نشر", "أعجبني"],
  ["fa-IR", "ویرایش عکس روی جلد", "ذخیره تغییرات", "انتشار", "پسندیدن"],
  ["he-IL", "עריכת תמונת הנושא", "שמירת השינויים", "פרסום", "לייק"],
  ["hi-IN", "कवर फ़ोटो एडिट करें", "बदलाव सेव करें", "पोस्ट करें", "लाइक करें"],
  ["bn-BD", "কভার ফটো এডিট করুন", "পরিবর্তন সেভ করুন", "পোস্ট করুন", "লাইক"],
  ["id-ID", "Edit foto sampul", "Simpan perubahan", "Posting", "Suka"],
  ["ms-MY", "Edit foto kulit", "Simpan perubahan", "Siarkan", "Suka"],
  ["vi-VN", "Chỉnh sửa ảnh bìa", "Lưu thay đổi", "Đăng", "Thích"],
  ["th-TH", "แก้ไขรูปภาพหน้าปก", "บันทึกการเปลี่ยนแปลง", "โพสต์", "ถูกใจ"],
  ["ja-JP", "カバー写真を編集", "変更を保存", "投稿", "いいね！"],
  ["ko-KR", "커버 사진 수정", "변경 내용 저장", "게시", "좋아요"],
  ["tl-PH", "I-edit ang cover photo", "I-save ang mga pagbabago", "I-post", "I-like"],
  ["ro-RO", "Editează fotografia de copertă", "Salvează modificările", "Postează", "Îmi place"],
  ["cs-CZ", "Upravit úvodní fotku", "Uložit změny", "Zveřejnit", "To se mi líbí"],
  ["hu-HU", "Borítókép szerkesztése", "Módosítások mentése", "Közzététel", "Tetszik"],
  ["el-GR", "Επεξεργασία φωτογραφίας εξωφύλλου", "Αποθήκευση αλλαγών", "Δημοσίευση", "Μου αρέσει"],
  ["sv-SE", "Redigera omslagsbild", "Spara ändringar", "Publicera", "Gilla"],
  ["da-DK", "Rediger coverbillede", "Gem ændringer", "Slå op", "Synes godt om"],
  ["fi-FI", "Muokkaa kansikuvaa", "Tallenna muutokset", "Julkaise", "Tykkää"],
];

for (const [language, edit, save, publish, like] of examples) {
  test(language + ": cover, save, publish and like aliases", () => {
    const {ui} = fixture(language);
    assert.equal(ui.pattern("coverEdit").test(edit), true);
    assert.equal(ui.pattern("saveChanges").test(save), true);
    assert.equal(ui.pattern("publish").test(publish), true);
    assert.equal(ui.pattern("like").test(like), true);
    assert.equal(ui.pattern("publish").test(save), false);
    assert.equal(ui.pattern("saveChanges").test(publish), false);
  });
}

test("normalization supports full-width characters, punctuation and Turkish casing", () => {
  const {ui} = fixture("tr-TR");
  assert.equal(ui.pattern("saveChanges").test("  ＳＡＶＥ　ＣＨＡＮＧＥＳ… "), true);
  assert.equal(ui.pattern("cancel").test("iptal"), true);
  assert.equal(ui.pattern("photoVideo").test(" Foto / vídeo "), true);
});

test("page language detection supports regions, Chinese scripts and mixed labels", () => {
  assert.equal(fixture("zh-Hant-HK").ui.language(), "zh-TW");
  assert.equal(fixture("pt_BR").ui.language(), "pt");
  assert.equal(fixture("xx-Unknown").ui.language(), "xx-Unknown");
  assert.equal(fixture("xx-Unknown").ui.pattern("saveChanges").test("Guardar cambios"), true);
});

test("only labelled composer prefixes accept account names", () => {
  const {ui} = fixture();
  for (const value of ["What's on your mind, Alice?", "¿Qué estás pensando, Ana?", "Bạn đang nghĩ gì, An?"]) {
    assert.equal(ui.pattern("composer").test(value), true);
  }
  assert.equal(ui.pattern("save").test("Save this post"), false);
  assert.equal(ui.pattern("publish").test("Publish settings"), false);
});

test("a generic Send button never identifies a comment dialog", () => {
  const {ui} = fixture();
  for (const value of ["Send", "Enviar", "Envoyer", "إرسال", "Gửi", "送信", "보내기", "发送", "傳送"]) {
    assert.equal(ui.pattern("commentSubmit").test(value), false, value);
  }
  for (const value of ["Publicar comentario", "Publier le commentaire", "Gửi bình luận", "댓글 게시", "送出留言"]) {
    assert.equal(ui.pattern("commentSubmit").test(value), true, value);
  }
});

test("like, unlike, cancel and destructive actions remain distinct", () => {
  const {ui} = fixture();
  for (const value of ["Ya no me gusta", "Je n’aime plus", "Gefällt mir nicht mehr", "Bỏ thích", "좋아요 취소"]) {
    assert.equal(ui.pattern("like").test(value), false, value);
    assert.equal(ui.pattern("liked").test(value), true, value);
  }
  for (const value of ["Delete", "Eliminar", "Supprimer", "حذف", "削除"]) {
    assert.equal(ui.pattern(["publish", "save", "cancelRequest"]).test(value), false);
  }
  assert.equal(ui.pattern("cancelRequest").test("Cancelar"), false);
  assert.equal(ui.pattern("cancelRequest").test("Cancelar solicitud"), true);
});

test("story audience suffixes do not allow arbitrary trailing instructions", () => {
  const {ui} = fixture();
  assert.equal(ui.pattern("story").test("Compartir en tu historia (Público)"), true);
  assert.equal(ui.pattern("story").test("Partilhar na tua história (Amigos)"), true);
  assert.equal(ui.pattern("story").test("Share to your story (Delete account)"), false);
  assert.equal(ui.pattern("story").test("Share to your story and send to a group"), false);
});

for (const [kind, value] of [
  ["avatar", "La photo de profil a été mise à jour"],
  ["cover", "Dein Titelbild wurde aktualisiert"],
  ["cover", "Фото обложки обновлено"],
  ["cover", "تم تحديث صورة الغلاف"],
  ["cover", "カバー写真が更新されました"],
  ["cover", "커버 사진이 업데이트되었습니다"],
  ["cover", "Ảnh bìa đã được cập nhật"],
  ["post", "Tu publicación se ha publicado"],
  ["story", "Shared to your story"],
]) {
  test("localized success feedback: " + value, () => {
    assert.equal(fixture().ui.success(kind, value), true);
  });
}

test("failed, unsaved and in-progress feedback is never confirmed", () => {
  const {ui} = fixture();
  for (const value of ["Profile picture is being updated", "Profile picture was not saved",
    "Unsaved profile picture", "Foto de portada: no se ha guardado",
    "Photo de profil n'a pas été enregistrée", "Titelbild nicht gespeichert"]) {
    assert.equal(ui.success("avatar", value) || ui.success("cover", value), false, value);
  }
});

test("negated completion notices are never treated as success", () => {
  const {ui} = fixture();
  for (const [kind, value] of [
    ["avatar", "Profile picture has not been updated"],
    ["cover", "Cover photo has never been updated"],
    ["post", "Publicación no publicada"],
    ["cover", "Фото обложки не обновлено"],
    ["cover", "Ảnh bìa chưa được cập nhật"],
    ["cover", "封面照片尚未更新"],
    ["post", "Post has not been published"],
  ]) assert.equal(ui.success(kind, value), false, value);
});

test("accessible names use aria labels, visible text and referenced headings", () => {
  const {ui, document} = fixture("es");
  const node = {
    innerText: "Guardar cambios",
    getAttribute: name => ({ "aria-label": "Save your cover photo", "aria-labelledby": "save-title" }[name] || null),
  };
  document.getElementById = () => ({textContent: "Enregistrer les modifications"});
  assert.equal(ui.matches(node, "saveChanges"), true);
  assert.equal(ui.unique([node, node], "saveChanges"), null);
  assert.equal(ui.unique([node], "saveChanges"), node);
});

test("reinjection is idempotent and diagnostics include the actual page language", () => {
  const {ui, window, context} = fixture("vi-VN");
  vm.runInContext(source, context);
  assert.equal(window.__fbUI, ui);
  assert.equal(ui.languages.length, 32);
  const scope = {querySelectorAll: () => [{
    isConnected: true, innerText: "Nút chưa biết", getAttribute: () => null,
  }]};
  const detail = ui.describe("保存", scope);
  assert.match(detail, /vi/);
  assert.match(detail, /Nút chưa biết/);
});

test("reinjection upgrades the previous helper and recognizes Chinese composer variants", () => {
  const {window, context} = fixture("zh-CN");
  const old = window.__fbUI = {version: 1};
  vm.runInContext(source, context);
  assert.notEqual(window.__fbUI, old);
  for (const label of ["有什么新鲜事，Sophia？", "有什麼新鮮事，Sophia？", "创建贴文"]) {
    assert.equal(window.__fbUI.pattern("composer").test(label), true, label);
  }
});

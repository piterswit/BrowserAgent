// Real DOM/editor/file upload checks; all Facebook responses are local fixtures.
const {withBrowser} = require("./check_cover_browser.cjs");
const {postScenario, languages} = require("./check_multilingual_browser.cjs");

withBrowser(async port => {
  const labels = languages[0];
  for (const options of [{reinject: true}, {text: "A bright day ☀️ 一起分享生活"},
    {draft: true}, {cancelDuringAuth: true}, {editDuringAuth: true}, {removeDuringAuth: true},
    {replaceAfterUpload: true}, {replaceDuringAuth: true}, {emptyMain: true}, {nestedControls: true},
    {replaceAfterUpload: true, loseText: true}, {replaceDuringAuth: true, loseText: true}, {rejectedInput: true},
    {nestedControls: true, disableDuringAuth: true}]) {
    await postScenario(port, labels, true, false, options);
  }
  for (const composer of ["有什么新鲜事，Sophia？", "你在想什么，Sophia？", "有什麼新鮮事，Sophia？"]) {
    await postScenario(port, {language: "zh-CN", composer, photo: "照片/视频", remove: "移除照片",
      publish: "发布", notice: "帖子已发布"}, true, false, {replaceAfterUpload: true});
  }
  for (const composer of ["Spune la ce te gândești…", "Spune la ce te gândești...",
    "Spune la ce te gândești, Isabella", "Spune la ce te gândeşti…"]) {
    await postScenario(port, {language: "ro", composer, photo: "Fotografie/clip video", remove: "Elimină fotografia",
      publish: "Postează", notice: "Postarea a fost publicată"}, true, false,
      {text: "O zi frumoasă alături de prieteni.", replaceAfterUpload: true});
  }
}).catch(error => { console.error(error); process.exitCode = 1; });

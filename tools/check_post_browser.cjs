// Real DOM/editor/file upload checks; all Facebook responses are local fixtures.
const {withBrowser} = require("./check_cover_browser.cjs");
const {postScenario, languages} = require("./check_multilingual_browser.cjs");

withBrowser(async port => {
  const labels = languages[0];
  for (const options of [{reinject: true}, {text: "A bright day ☀️ 一起分享生活"},
    {draft: true}, {cancelDuringAuth: true}, {editDuringAuth: true}, {removeDuringAuth: true}]) {
    await postScenario(port, labels, true, false, options);
  }
}).catch(error => { console.error(error); process.exitCode = 1; });

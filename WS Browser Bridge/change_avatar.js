(() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const label = el => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  const buttons = root => [...root.querySelectorAll('button, [role="button"], a[role="link"]')].filter(visible);
  const matches = (el, words) => words.some(word => label(el).toLowerCase() === word.toLowerCase());
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const waitFor = async (find, description, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await delay(300);
    }
    throw new Error(`未找到${description}，请检查 Facebook 页面语言或布局`);
  };
  const editWords = ["Edit profile picture", "Update profile picture", "编辑头像", "編輯大頭貼", "更新头像", "更新大頭貼", "更换头像", "更換大頭貼"];
  const uploadWords = ["Upload photo", "上传照片", "上傳相片", "上傳照片"];
  const saveWords = ["Save", "保存", "儲存"];

  window.__fbAvatar = {
    async prepare() {
      if (window.__hsCtrl) window.__hsCtrl.stop();
      if (window.__reelCtrl) window.__reelCtrl.stop();
      const edit = await waitFor(() => buttons(document).find(el => matches(el, editWords)), "编辑头像按钮");
      edit.click();
      const editor = await waitFor(() => dialogs().find(dialog => buttons(dialog).some(el => matches(el, uploadWords))), "上传照片窗口");
      // Restrict upload discovery to the avatar editor, not the feed composer.
      const input = [...editor.querySelectorAll('input[type="file"]')].find(el => /image|\.jpg|\.png/i.test(el.accept));
      if (input) {
        input.setAttribute("data-fb-avatar-upload", "true");
        return "input";
      }
      return "chooser";
    },
    async upload() {
      const button = await waitFor(() => dialogs().flatMap(buttons).find(el => matches(el, uploadWords)), "上传照片按钮");
      button.scrollIntoView({block: "center"});
      const rect = button.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    },
    async save() {
      const save = await waitFor(() => dialogs().flatMap(buttons).find(el => matches(el, saveWords) && el.getAttribute("aria-disabled") !== "true" && !el.disabled), "头像保存按钮", 60000);
      const editor = save.closest('[role="dialog"]');
      save.click();
      await waitFor(() => !editor.isConnected || !visible(editor), "保存完成", 60000);
      await delay(1000);
      const error = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(label).find(text => /error|failed|couldn't|出错|失败|失敗|錯誤/i.test(text));
      if (error) throw new Error(error);
    }
  };
})();

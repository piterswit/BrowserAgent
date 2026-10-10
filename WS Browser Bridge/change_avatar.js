(() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length && !el.closest('[aria-hidden="true"]') &&
    getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0";
  const label = el => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  const buttons = root => [...root.querySelectorAll('button, [role="button"], a[role="link"], a[href]')].filter(visible);
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
  const editWords = ["Edit profile picture", "Update profile picture", "编辑头像", "編輯大頭貼", "編輯頭像", "更新头像", "更新大頭貼", "更新頭像", "更换头像", "更換大頭貼", "更換頭像"];
  const chooseWords = ["Choose profile picture", "Select profile picture", "选择头像", "選擇大頭貼", "選擇頭像", "选择个人头像", "選擇個人頭像"];
  const uploadWords = ["Upload photo", "Upload picture", "上传照片", "上传图片", "上傳相片", "上傳照片", "上傳圖片"];
  const saveWords = ["Save", "保存", "储存", "儲存"];
  let originalPictures = [];
  let pictureContainer;
  const activate = async () => {
    if (!window.__fbAvatar.operationId) return;
    const response = await chrome.runtime.sendMessage({cmd: "fb_avatar_activate", operationId: window.__fbAvatar.operationId});
    if (!response?.accepted) throw new Error("无法激活头像任务标签页");
  };
  const pictureSources = root => [...root.querySelectorAll('img, svg image')]
    .filter(el => !el.closest('[role="dialog"], [role="article"]') && !/cover|封面/i.test(el.getAttribute("alt") || ""))
    .filter(el => { const rect = el.getBoundingClientRect(); return rect.width >= 100 && rect.height >= 100 && rect.width / rect.height > 0.8 && rect.width / rect.height < 1.25; })
    .map(el => el.currentSrc || el.src || el.getAttribute("href") || el.getAttribute("xlink:href"))
    .filter(Boolean)
    .map(src => { try { return new URL(src, location.href).pathname; } catch { return src; } })
    .filter(Boolean);

  window.__fbAvatar = {
    async prepare() {
      if (window.__hsCtrl) window.__hsCtrl.stop();
      if (window.__reelCtrl) window.__reelCtrl.run = false;
      const edit = await waitFor(() => buttons(document).find(el => matches(el, [...editWords, ...chooseWords])) ||
        buttons(document).find(el => {
          if (el.closest('[role="banner"], [role="navigation"], [role="article"], [role="dialog"], [role="menu"]')) return false;
          const description = label(el) + " " + [...el.querySelectorAll('img, svg image')].map(image => image.getAttribute("alt") || image.getAttribute("aria-label") || "").join(" ");
          if (!/profile picture|头像|頭像|大頭貼/i.test(description) || /see profile picture|view profile picture|查看|檢視/i.test(label(el))) return false;
          const rect = el.getBoundingClientRect();
          return rect.width >= 100 && rect.height >= 100 && rect.top < 600;
        }), "主页头像或编辑头像按钮");
      pictureContainer = edit.parentElement;
      for (let depth = 0; depth < 3 && pictureContainer && !pictureSources(pictureContainer).length; depth++) {
        pictureContainer = pictureContainer.parentElement;
      }
      originalPictures = pictureContainer ? pictureSources(pictureContainer) : [];
      await activate();
      edit.click();
      await waitFor(() => {
        if (dialogs().some(dialog => buttons(dialog).some(el => matches(el, uploadWords)))) return true;
        const choices = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].filter(visible);
        const choose = choices.find(el => matches(el, chooseWords));
        if (choose) { choose.click(); return true; }
        return false;
      }, "选择头像菜单或上传照片窗口");
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
      await activate();
      button.scrollIntoView({block: "center"});
      const rect = button.getBoundingClientRect();
      return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    },
    async save() {
      const save = await waitFor(() => dialogs().reverse()
        .filter(dialog => /profile picture|头像|頭像|大頭貼/i.test(label(dialog)))
        .flatMap(buttons).find(el => matches(el, saveWords) && el.getAttribute("aria-disabled") !== "true" && !el.disabled), "头像保存按钮", 60000);
      const editor = save.closest('[role="dialog"]');
      await activate();
      if (this.operationId) {
        const response = await chrome.runtime.sendMessage({cmd: "fb_avatar_submitting", operationId: this.operationId});
        if (!response?.accepted) throw new Error("换头像任务已失效，未提交保存");
      }
      save.click();
      await waitFor(() => !editor.isConnected || !visible(editor), "保存完成", 60000);
      await delay(1000);
      const error = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(label).find(text => /error|failed|couldn't|could not|出错|出錯|错误|失败|失敗|錯誤|无法|無法/i.test(text));
      if (error) throw new Error(error);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const success = [...document.querySelectorAll('[role="alert"], [role="status"]')].filter(visible).map(label)
          .some(text => /profile picture.*(updated|saved)|(?:头像|頭像|大頭貼).*(更新|保存|储存|儲存|成功)/i.test(text));
        const currentPictures = pictureContainer?.isConnected ? pictureSources(pictureContainer) : [];
        const changed = originalPictures.length > 0 && currentPictures.some(src => !originalPictures.includes(src));
        if (success || changed) return {confirmed: true};
        await delay(300);
      }
      return {confirmed: false};
    }
  };
})();

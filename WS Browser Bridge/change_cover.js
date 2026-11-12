(() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => node?.isConnected && node.getClientRects().length &&
    !node.closest('[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden" &&
    getComputedStyle(node).display !== "none" && getComputedStyle(node).opacity !== "0";
  const text = node => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const label = node => (node?.getAttribute("aria-label") || text(node)).replace(/\s+/g, " ").trim();
  const coverWords = /cover photo|cover picture|封面(?:照片|相片|圖片|图片)?|封面相片/i;
  const editWords = /^(edit cover photo|edit cover picture|add cover photo|add cover picture|change cover photo|编辑封面(?:照片|图片)?|編輯封面(?:相片|照片|圖片)?|添加封面(?:照片|图片)?|新增封面(?:相片|照片|圖片)?|更换封面(?:照片|图片)?|更換封面(?:相片|照片|圖片)?)$/i;
  const uploadWords = /^(upload photo|upload picture|upload cover photo|上传(?:照片|图片|封面照片)|上傳(?:照片|相片|圖片|封面相片|封面照片))$/i;
  const saveWords = /^(save changes|save|保存更改|保存修改|保存|儲存變更|储存变更|儲存|储存)$/i;
  const cancelWords = /^(cancel|取消)$/i;
  const excluded = '[role="article"], [role="navigation"], [role="banner"]';
  const buttons = scope => [...scope.querySelectorAll('button, [role="button"], [role="menuitem"], a[href]')]
    .filter(node => visible(node) && !node.closest(excluded));
  const matches = (node, words) => words.test(label(node)) || words.test(text(node));
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(visible);
  const pictureKey = node => {
    const source = node.currentSrc || node.src || node.getAttribute("href") || node.getAttribute("xlink:href");
    try { return source ? new URL(source, location.href).pathname : null; } catch { return null; }
  };
  const coverPictures = (scope = document) => [...scope.querySelectorAll('img, svg image')].filter(node => {
    if (!visible(node) || node.closest(excluded)) return false;
    const rect = node.getBoundingClientRect();
    const description = (node.getAttribute("alt") || "") + " " + label(node);
    return rect.width >= 300 && rect.height >= 90 && rect.width / rect.height >= 1.8 &&
      (coverWords.test(description) || rect.top < 650);
  });
  const sources = () => coverPictures().filter(node => !node.closest('[role="dialog"]')).map(pictureKey).filter(Boolean);
  let previousDialogs = new Set();
  let baseline = [];
  let uploadScope = null;
  let uploadButton = null;
  let started = false;

  const assertCurrent = () => {
    if (!window.__fbCover.operationId || Date.now() >= window.__fbCover.expires) throw new Error("封面任务已过期");
    if (location.protocol !== "https:" || !/(^|\.)facebook\.com$/.test(location.hostname) ||
        /\/(login|checkpoint)(\/|\.php|$)/.test(location.pathname)) throw new Error("请先完成 Facebook 登录或安全验证");
  };
  const waitFor = async (find, description, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      assertCurrent();
      const result = find();
      if (result) return result;
      await delay(200);
    }
    throw new Error("未找到" + description + "，请检查 Facebook 页面语言或布局");
  };
  const request = async cmd => {
    assertCurrent();
    const response = await chrome.runtime.sendMessage({cmd, operationId: window.__fbCover.operationId});
    if (!response?.accepted) throw new Error("封面任务或账号已变化，未执行保存");
    assertCurrent();
  };
  const enabled = node => !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const saveControl = () => {
    const candidates = buttons(document).filter(node => matches(node, saveWords));
    const owned = candidates.map(button => {
      const dialog = button.closest('[role="dialog"]');
      if (dialog) {
        if (!previousDialogs.has(dialog) && coverWords.test(label(dialog) + " " + text(dialog))) {
          return {button, scope: dialog};
        }
        return null;
      }
      // Facebook can show its cover reposition toolbar directly on the profile.
      if (!/^(save changes|保存更改|保存修改|儲存變更|储存变更)$/i.test(label(button))) return null;
      for (let scope = button.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
        if (!scope.closest('[role="main"], main')) continue;
        if (buttons(scope).some(node => matches(node, cancelWords)) && coverPictures(scope).length) {
          return {button, scope};
        }
      }
      return null;
    }).filter(Boolean);
    return owned.length === 1 ? owned[0] : null;
  };
  const imageReady = scope => coverPictures(scope).some(node => {
    const key = pictureKey(node);
    const loaded = !("complete" in node) || (node.complete && node.naturalWidth > 0);
    return loaded && key && !baseline.includes(key);
  });

  window.__fbCover = {
    async prepare() {
      assertCurrent();
      if (started) throw new Error("封面任务已启动");
      started = true;
      previousDialogs = new Set(dialogs());
      baseline = sources();
      const edit = await waitFor(() => {
        const matchesEdit = buttons(document).filter(node =>
          !node.closest('[role="dialog"], [role="menu"]') && matches(node, editWords));
        return matchesEdit.length === 1 ? matchesEdit[0] : null;
      }, "编辑封面或添加封面按钮");
      await request("fb_cover_activate");
      edit.scrollIntoView({block: "center"});
      edit.click();
      await waitFor(() => {
        const choices = dialogs().filter(scope => !previousDialogs.has(scope)).flatMap(scope =>
          buttons(scope).filter(node => matches(node, uploadWords)).map(button => ({scope, button})));
        if (choices.length !== 1) return null;
        uploadScope = choices[0].scope;
        uploadButton = choices[0].button;
        return true;
      }, "封面上传菜单");
      const inputs = [...uploadScope.querySelectorAll('input[type="file"]')]
        .filter(input => !input.disabled && /image|\.jpg|\.png|\.webp/i.test(input.accept));
      if (inputs.length === 1) {
        inputs[0].setAttribute("data-fb-cover-upload", "true");
        return "input";
      }
      return "chooser";
    },

    async upload() {
      assertCurrent();
      if (!visible(uploadScope) || !visible(uploadButton)) throw new Error("封面上传菜单已关闭");
      await request("fb_cover_activate");
      uploadButton.scrollIntoView({block: "center"});
      const rect = uploadButton.getBoundingClientRect();
      const point = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) {
        throw new Error("封面上传按钮不在可操作区域");
      }
      return point;
    },

    async save() {
      const control = await waitFor(() => {
        const found = saveControl();
        if (!found || !enabled(found.button) || !imageReady(found.scope)) return null;
        if ([...found.scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return null;
        return found;
      }, "封面图片加载及保存按钮", 60000);
      await request("fb_cover_activate");
      await request("fb_cover_submitting");
      const fresh = saveControl();
      if (!fresh || !enabled(fresh.button) || fresh.scope !== control.scope || !imageReady(fresh.scope)) throw new Error("封面编辑窗口已变化");
      const alerts = new Map([...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => [node, text(node)]));
      fresh.button.scrollIntoView({block: "center"});
      fresh.button.click();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        assertCurrent();
        const notices = [...document.querySelectorAll('[role="alert"], [role="status"]')]
          .filter(node => visible(node) && alerts.get(node) !== text(node)).map(text);
        const error = notices.find(value => /error|failed|couldn't|could not|出错|出錯|错误|失败|失敗|錯誤|无法|無法/i.test(value));
        if (error) throw new Error(error);
        const saved = notices.some(value => coverWords.test(value) && /updated|saved|成功|更新|保存|儲存|储存/i.test(value));
        const editing = saveControl();
        const changed = sources().some(key => !baseline.includes(key));
        if (saved || (!editing && changed)) return {confirmed: true};
        if (!editing) return {confirmed: false};
        await delay(200);
      }
      return {confirmed: false};
    }
  };
})();

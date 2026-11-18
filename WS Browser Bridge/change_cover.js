(() => {
  const ui = window.__fbUI;
  if (!ui) throw new Error("页面识别组件未加载，请重新加载插件");
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => node?.isConnected && node.getClientRects().length &&
    !node.closest('[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden" &&
    getComputedStyle(node).display !== "none" && getComputedStyle(node).opacity !== "0";
  const text = node => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const label = node => (node?.getAttribute("aria-label") || text(node)).replace(/\s+/g, " ").trim();
  const coverWords = ui.pattern("coverSubject", /cover photo|cover picture|封面(?:照片|相片|圖片|图片)?|封面相片/i, {contains: true});
  const editWords = ui.pattern("coverEdit", /^(edit cover photo|edit cover picture|add cover photo|add cover picture|change cover photo|编辑封面(?:照片|图片)?|編輯封面(?:相片|照片|圖片)?|添加封面(?:照片|图片)?|新增封面(?:相片|照片|圖片)?|更换封面(?:照片|图片)?|更換封面(?:相片|照片|圖片)?)$/i);
  const uploadWords = ui.pattern("photoUpload", /^(upload photo|upload picture|upload cover photo|上传(?:照片|图片|封面照片)|上傳(?:照片|相片|圖片|封面相片|封面照片))$/i);
  const saveWords = ui.pattern(["save","saveChanges"], /^(save changes|save|保存更改|保存修改|保存|儲存變更|储存变更|儲存|储存)$/i);
  const saveChangesWords = ui.pattern("saveChanges", /^(save changes|保存更改|保存修改|儲存變更|储存变更)$/i);
  const cancelWords = ui.pattern("cancel", /^(cancel|取消)$/i);
  const excluded = '[role="article"], [role="navigation"]';
  const buttons = scope => [...scope.querySelectorAll('button, [role="button"], [role="menuitem"], a[href]')]
    .filter(node => visible(node) && !node.closest(excluded));
  const matches = (node, words) => ui.values(node).some(value => words.test(value));
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(visible);
  const backgroundImages = new Map();
  const pictureKey = node => {
    const background = getComputedStyle(node).backgroundImage.match(/^url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)$/);
    const source = node.currentSrc || node.src || node.getAttribute("href") || node.getAttribute("xlink:href") ||
      (background && (background[1] || background[2] || background[3]));
    // CDN variants can change the image using only a URL query parameter.
    try { return source ? new URL(source, location.href).href : null; } catch { return null; }
  };
  const coverPictures = scope => [...scope.querySelectorAll('img, svg image, [role="img"], [style*="background-image"]')].filter(node => {
    if (!visible(node) || node.closest(excluded)) return false;
    const rect = node.getBoundingClientRect();
    const description = (node.getAttribute("alt") || "") + " " + label(node);
    if (coverWords.test(description)) return rect.width >= 120 && rect.height >= 60;
    const landscape = box => box.width >= 300 && box.height >= 90 && box.width / box.height >= 1.8 && box.top < 650;
    if (landscape(rect)) return true;
    if (rect.width < 120 || rect.height < 60) return false;
    // A portrait upload may extend beyond the visible landscape crop.
    for (let parent = node.parentElement, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if (/hidden|clip/.test(style.overflowX + " " + style.overflowY) &&
          landscape(parent.getBoundingClientRect())) return true;
    }
    return false;
  });
  let profileScope = document;
  const currentProfile = () => {
    if (!profileScope.isConnected) profileScope = document.querySelector('[role="main"], main') || document;
    return profileScope;
  };
  const sources = () => coverPictures(currentProfile()).filter(node => !node.closest('[role="dialog"]')).map(pictureKey).filter(Boolean);
  let previousDialogs = new Set();
  let previousSaveButtons = new Set();
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
    throw new Error("未找到" + description + "；" + ui.describe(description));
  };
  const request = async cmd => {
    assertCurrent();
    const response = await chrome.runtime.sendMessage({cmd, operationId: window.__fbCover.operationId});
    if (!response?.accepted) throw new Error("封面任务或账号已变化，未执行保存");
    assertCurrent();
  };
  const enabled = node => !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const saveControl = () => {
    const candidates = buttons(document).filter(node => matches(node, saveWords) && !previousSaveButtons.has(node));
    const owned = candidates.map(button => {
      const dialog = button.closest('[role="dialog"]');
      if (dialog) {
        if (!previousDialogs.has(dialog) &&
            (coverWords.test(label(dialog) + " " + text(dialog)) || imageReady(dialog))) {
          return {button, scope: dialog, previewScope: dialog};
        }
        return null;
      }
      // Facebook can show its cover reposition toolbar directly on the profile.
      if (!matches(button, saveChangesWords)) return null;
      for (let scope = button.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
        if (buttons(scope).some(node => matches(node, cancelWords))) {
          // The reposition toolbar can be a portal outside the profile's main.
          return {button, scope, previewScope: currentProfile()};
        }
      }
      return null;
    }).filter(Boolean);
    return owned.length === 1 ? owned[0] : null;
  };
  const imageReady = scope => coverPictures(scope).some(node => {
    const key = pictureKey(node);
    let loaded = !("complete" in node) || (node.complete && node.naturalWidth > 0);
    if (key && !node.matches("img, svg image")) {
      if (!backgroundImages.has(key)) {
        const image = new Image();
        image.src = key;
        backgroundImages.set(key, image);
      }
      const image = backgroundImages.get(key);
      loaded = image.complete && image.naturalWidth > 0;
    }
    return loaded && key && !baseline.includes(key);
  });

  window.__fbCover = {
    async prepare() {
      assertCurrent();
      if (started) throw new Error("封面任务已启动");
      started = true;
      previousDialogs = new Set(dialogs());
      const edit = await waitFor(() => {
        const matchesEdit = buttons(document).filter(node =>
          !node.closest('[role="dialog"], [role="menu"]') && matches(node, editWords));
        return matchesEdit.length === 1 ? matchesEdit[0] : null;
      }, "编辑封面或添加封面按钮");
      profileScope = edit.closest('[role="main"], main') || document;
      baseline = sources();
      previousSaveButtons = new Set(buttons(document).filter(node => matches(node, saveWords)));
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
      await waitFor(() => {
        const found = saveControl();
        if (!found || !enabled(found.button) || !imageReady(found.previewScope)) return null;
        if ([...found.scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return null;
        return found;
      }, "封面图片加载及保存按钮", 60000);
      await request("fb_cover_activate");
      await request("fb_cover_submitting");
      const fresh = saveControl();
      if (!fresh || !enabled(fresh.button) || !imageReady(fresh.previewScope)) throw new Error("封面编辑窗口已变化");
      const alerts = new Map([...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => [node, text(node)]));
      fresh.button.scrollIntoView({block: "center"});
      fresh.button.click();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        assertCurrent();
        const notices = [...document.querySelectorAll('[role="alert"], [role="status"]')]
          .filter(node => visible(node) && alerts.get(node) !== text(node)).map(text);
        const error = notices.find(value => ui.contains("error", value) || /error|failed|couldn't|could not|出错|出錯|错误|失败|失敗|錯誤|无法|無法/i.test(value));
        if (error) throw new Error(error);
        const saved = notices.some(value => ui.success("cover", value));
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

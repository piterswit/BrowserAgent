(() => {
  const ui = window.__fbUI;
  if (!ui) throw new Error("页面识别组件未加载，请重新加载插件");
  const request = window.__fbPostRequest;
  if (!request?.operationId || typeof request.text !== "string") return;
  if (window.__fbPostController?.operationId === request.operationId) return;
  window.__fbPostController?.stop?.();

  let stopped = false;
  let finished = false;
  let submitted = false;
  const visible = node => !!node && node.isConnected && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length) &&
    getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
  const text = node => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const words = {
    composer: /^(what['’]?s on your mind.*|create post|写点什么.*|你在想什么.*|分享近况.*|建立貼文|在想些什麼.*)$/i,
    photo: /^(photo\s*\/\s*video|photo|照片\/影片|相片\/影片|照片|相片|图片\/视频|图片|圖像\/影片)$/i,
    publish: /^(post|publish|发布|發佈|發表)$/i,
    removeImage: /^(remove (photo|image)|移除照片|移除相片|移除图片|移除圖片|移除圖像)$/i,
  };
  for (const [key, action] of Object.entries({composer: "composer", photo: "photoVideo", publish: "publish", removeImage: "photoRemove"})) {
    words[key] = ui.pattern(action, words[key]);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const guard = () => {
    if (stopped || window.__fbPostController?.operationId !== request.operationId) throw new Error("发帖任务已取消");
    if (!/(^|\.)facebook\.com$/.test(location.hostname) || /\/(login|checkpoint)(\/|\.php|$)/.test(location.pathname)) {
      throw new Error("请先登录 Facebook 并完成账号验证");
    }
  };
  const complete = (success, confirmed, submitted, detail) => {
    if (finished) return;
    finished = true;
    chrome.runtime.sendMessage({cmd: "fb_post_result", operationId: request.operationId, success, confirmed, submitted, detail})?.catch(() => {});
  };
  const waitFor = async (finder, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!stopped && Date.now() < deadline) {
      guard();
      const result = finder();
      if (result) return result;
      await sleep(150);
    }
    throw new Error(stopped ? "发帖任务已取消" : ui.describe("发布控件"));
  };
  const click = node => {
    guard();
    if (!visible(node)) throw new Error("未找到可操作的发布控件");
    node.scrollIntoView({block: "center", inline: "center"});
    node.click();
  };
  const controls = '[role="button"], button, label';
  const matches = (node, matcher) => ui.values(node).some(value => matcher.test(value));
  const clickable = (scope, matcher) => ui.unique(
    [...scope.querySelectorAll(controls)].filter(visible), matcher);
  const getEditor = dialog => {
    const editors = [...dialog.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')].filter(visible);
    return editors.length === 1 ? editors[0] : null;
  };
  const getValue = editor => editor?.isContentEditable ? editor.innerText : editor?.value;
  const normalize = value => value?.replace(/\s+/g, " ").trim();
  const send = async cmd => {
    guard();
    const reply = await chrome.runtime.sendMessage({cmd, operationId: request.operationId});
    guard();
    if (!reply?.accepted) throw new Error(reply?.detail || "发帖任务已失效");
  };
  const fill = editor => {
    guard();
    editor.focus();
    if (editor.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, request.text)) editor.textContent = request.text;
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(editor, request.text);
    }
    editor.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: request.text}));
    editor.dispatchEvent(new Event("change", {bubbles: true}));
  };

  window.__fbPostController = {operationId: request.operationId, stop: () => { stopped = true; }};
  (async () => {
    try {
      if (!/(^|\.)facebook\.com$/.test(location.hostname) || /\/(login|checkpoint)(\/|\.php|$)/.test(location.pathname)) {
        throw new Error("请先登录 Facebook 并完成账号验证");
      }
      const previousDialogs = new Set([...document.querySelectorAll('[role="dialog"]')].filter(visible));
      const launch = await waitFor(() => {
        const main = document.querySelector('[role="main"], main');
        return main && clickable(main, words.composer);
      });
      click(launch);
      const postDialog = await waitFor(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')]
          .filter(node => visible(node) && !previousDialogs.has(node) && getEditor(node));
        return dialogs.length === 1 ? dialogs[0] : null;
      });
      const editor = getEditor(postDialog);
      if (getValue(editor)?.trim()) throw new Error("发布窗口已有文字，请先核对草稿");
      const imagePreview = () => clickable(postDialog, words.removeImage) ||
        [...postDialog.querySelectorAll('img[src^="blob:"]')].some(node => visible(node) && node.complete && node.naturalWidth > 0);
      if (imagePreview()) throw new Error("发布窗口已有图片，请先核对草稿");
      fill(editor);
      if (request.hasImage) {
        const photoButton = await waitFor(() => clickable(postDialog, words.photo));
        const findInput = () => {
          const inputs = [...postDialog.querySelectorAll('input[type="file"]')]
            .filter(node => !node.disabled && /image|\.(jpg|jpeg|png|webp)/i.test(node.accept));
          return inputs.length === 1 ? inputs[0] : null;
        };
        click(photoButton);
        const input = await waitFor(() => imagePreview() || findInput(), 25000);
        if (input instanceof HTMLInputElement) {
          input.dataset.browseragentPostUpload = "true";
          try { await send("fb_post_upload"); }
          finally { delete input.dataset.browseragentPostUpload; }
        }
        try { await waitFor(imagePreview, 30000); }
        catch { throw new Error("未确认图片已添加，已停止发布"); }
      }
      const findPublish = () => {
        if (!visible(postDialog) || (request.hasImage ? !imagePreview() : imagePreview()) ||
            [...postDialog.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return null;
        const buttons = [...postDialog.querySelectorAll('[role="button"], button')].filter(node =>
          visible(node) && matches(node, words.publish) && node.getAttribute("aria-disabled") !== "true" && !node.disabled);
        return buttons.length === 1 ? buttons[0] : null;
      };
      await waitFor(findPublish);
      await send("fb_post_submitting");
      const publish = findPublish();
      if (!publish || getEditor(postDialog) !== editor || normalize(getValue(editor)) !== normalize(request.text)) {
        throw new Error("发布窗口或正文已变化，已停止发布");
      }
      const initial = new Set([...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => text(node)));
      submitted = true;
      click(publish);
      const confirmed = await waitFor(() => [...document.querySelectorAll('[role="alert"], [role="status"]')]
        .some(node => visible(node) && !initial.has(text(node)) && ui.success("post", text(node))), 15000)
        .then(() => true, () => false);
      complete(true, confirmed, true, confirmed ? "贴文已发布" : "已点击发布，请核对贴文");
    } catch (error) {
      complete(submitted, false, submitted, submitted ? "发布结果无法确认，请核对个人主页" : error.message);
    }
  })();
})();

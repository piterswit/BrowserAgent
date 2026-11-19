(() => {
  const ui = window.__fbUI;
  if (!ui) throw new Error("页面识别组件未加载，请重新加载插件");
  window.__fbCancelRequestsCtrl?.stop();
  const pending = new Map();
  const taskPath = location.pathname;
  const controls = '[role="button"], button, a[href]';
  const cancelWords = ui.pattern("cancelRequest");
  const sentWords = ui.pattern("sentRequests");
  const blockWords = ui.pattern("blocked", null, {contains: true});
  const securityWords = ui.pattern("security", null, {contains: true});
  const attemptedNodes = new WeakMap(), attemptedProfiles = new Set();
  let attempted = 0, confirmed = 0, progress;
  const ctrl = {
    run: true,
    stop() {
      if (!this.run) return;
      this.run = false;
      for (const [id, reject] of pending) {
        clearTimeout(id);
        reject(Object.assign(new Error("取消好友请求任务已停止"), {name: "AbortError"}));
      }
      pending.clear();
      progress?.remove();
      if (window.__fbCancelRequestsCtrl === this) window.__fbCancelRequestsCtrl = null;
    }
  };
  window.__fbCancelRequestsCtrl = ctrl;
  const result = (detail, error = "") => ({attempted, confirmed, detail, error});
  const guard = () => {
    if (location.pathname !== taskPath) ctrl.stop();
    if (!ctrl.run) throw Object.assign(new Error("取消好友请求任务已停止"), {name: "AbortError"});
  };
  const sleep = ms => {
    guard();
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => { pending.delete(id); resolve(); }, ms);
      pending.set(id, reject);
    }).then(guard);
  };
  const style = node => window.getComputedStyle?.(node) || {};
  const visible = node => {
    if (!node || node.isConnected === false) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const css = style(parent);
      if (parent.hidden || parent.inert || parent.getAttribute?.("aria-hidden") === "true" ||
          css.display === "none" || /hidden|collapse/.test(css.visibility || "") ||
          css.opacity === "0") return false;
    }
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight)) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(style(parent).overflowY || "")) continue;
      const clip = parent.getBoundingClientRect();
      if (rect.bottom <= clip.top || rect.top >= clip.bottom) return false;
    }
    return true;
  };
  const matches = (node, matcher) => ui.values(node).some(value => matcher.test(value));
  const enabled = node => visible(node) && !node.disabled && node.getAttribute?.("aria-disabled") !== "true";
  const buttons = scope => [...scope.querySelectorAll(controls)];
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const blocked = () => [...document.querySelectorAll('[role="dialog"], [role="alert"], [role="alertdialog"]')]
    .filter(visible).some(node => blockWords.test(node.innerText || "") ||
      securityWords.test(node.getAttribute?.("aria-label") || "") ||
      [...node.querySelectorAll('[role="heading"], h1, h2')].some(heading =>
        visible(heading) && securityWords.test(heading.innerText || "")) ||
      [...node.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"]')].some(visible));
  const ensureUnblocked = () => {
    guard();
    if (blocked()) throw new Error("页面出现限制或登录验证，已停止取消请求，请人工检查");
  };
  const show = text => {
    if (!progress) {
      progress = document.createElement("div");
      progress.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);" +
        "z-index:999999;background:#1877f2;color:#fff;padding:10px 20px;border-radius:8px;" +
        "font:14px 'Segoe UI',sans-serif;pointer-events:none";
      document.body.appendChild(progress);
    }
    progress.innerText = text;
  };
  const waitFor = async (finder, timeout = 15000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      ensureUnblocked();
      const value = finder();
      if (value) return value;
      await sleep(300);
    }
    return null;
  };
  const findModal = () => {
    const candidates = dialogs().filter(dialog =>
      [...dialog.querySelectorAll('[role="heading"], h1, h2'), ...buttons(dialog)]
        .some(node => visible(node) && (matches(node, sentWords) || matches(node, cancelWords))));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const scrollContainer = modal => {
    const candidates = [modal, ...modal.querySelectorAll("div")].filter(node =>
      /auto|scroll/.test(style(node).overflowY || "") && node.scrollHeight > node.clientHeight);
    // Prefer the request list itself over unrelated scrollable headers or side panels.
    return candidates.find(node => buttons(node).some(button => matches(button, cancelWords))) ||
      candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || modal;
  };
  const profileKey = (button, modal) => {
    // A recycled DOM button can belong to another person after virtual-list scrolling.
    for (let row = button.parentElement, depth = 0; row && row !== modal && depth < 6; row = row.parentElement, depth++) {
      if (buttons(row).filter(node => matches(node, cancelWords)).length > 1) break;
      const links = [...row.querySelectorAll('a[href]')].map(link => {
        try {
          const url = new URL(link.href, location.href);
          if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
          if (url.pathname === "/profile.php" && /^[1-9]\d+$/.test(url.searchParams.get("id") || "")) {
            return "/profile.php?id=" + url.searchParams.get("id");
          }
          const path = url.pathname.replace(/\/$/, "");
          return /^\/[^/]+$/.test(path) && !/^\/(?:friends|me|settings|help|login|checkpoint|groups)$/i.test(path) ? path : null;
        } catch { return null; }
      }).filter(Boolean);
      const unique = [...new Set(links)];
      if (unique.length === 1) return unique[0];
    }
    return "";
  };
  const wasAttempted = (button, modal) => {
    const key = profileKey(button, modal);
    return key ? attemptedProfiles.has(key) : attemptedNodes.has(button);
  };
  const summary = () => "已尝试 " + attempted + " 个，界面确认取消 " + confirmed + " 个";
  async function auto() {
    guard();
    if (!location.pathname.startsWith("/friends/requests")) throw new Error("请先打开 Facebook 好友请求页面");
    await sleep(1500);
    ensureUnblocked();
    let modal = findModal();
    if (!modal) {
      const entry = await waitFor(() => {
        const entries = buttons(document).filter(node => enabled(node) && matches(node, sentWords));
        return entries.length === 1 ? entries[0] : null;
      });
      if (!entry) throw new Error(ui.describe("查看已发送请求"));
      ensureUnblocked();
      entry.click();
      modal = await waitFor(findModal);
    }
    if (!modal) throw new Error(ui.describe("已发送请求窗口"));
    let scroll = scrollContainer(modal);
    scroll.scrollTop = 0;
    await sleep(300);
    let failures = 0, idle = 0, scrolls = 0;
    for (;;) {
      ensureUnblocked();
      if (modal.isConnected === false || !visible(modal)) throw new Error("好友请求窗口已关闭，已停止任务");
      scroll = scrollContainer(modal);
      const button = buttons(modal).find(node => enabled(node) &&
        matches(node, cancelWords) && !wasAttempted(node, modal));
      if (button) {
        button.scrollIntoView?.({block: "nearest", inline: "nearest", behavior: "instant"});
        await sleep(150);
        ensureUnblocked();
        // Scrolling can rerender a virtual list. Never click a stale or changed control.
        if (!enabled(button) || !matches(button, cancelWords)) continue;
        const key = profileKey(button, modal);
        if (wasAttempted(button, modal)) continue;
        attemptedNodes.set(button, key);
        if (key) attemptedProfiles.add(key);
        attempted++;
        show("正在取消好友请求：" + summary());
        const previousDialogs = new Set(dialogs());
        button.click();
        let confirmationClicked = false;
        let replacedAt = null;
        const position = scroll.scrollTop;
        const changed = await waitFor(() => {
          // Some layouts ask for confirmation. Only the explicit request-cancellation action is allowed.
          const confirmations = dialogs().filter(node => !previousDialogs.has(node))
            .flatMap(node => buttons(node)).filter(node => enabled(node) && matches(node, cancelWords));
          if (confirmations.length === 1 && !confirmationClicked) {
            ensureUnblocked();
            confirmations[0].click();
            confirmationClicked = true;
            return false;
          }
          if (button.isConnected === false || !document.body.contains(button)) return true;
          if (profileKey(button, modal) !== key || !visible(button)) {
            const stillListed = key && buttons(modal).some(node =>
              visible(node) && matches(node, cancelWords) && profileKey(node, modal) === key);
            if (!key || stillListed || !visible(modal) || scroll.scrollTop !== position) { replacedAt = null; return false; }
            // A stable replacement in the same viewport can reuse the same DOM button.
            replacedAt ??= Date.now();
            return Date.now() - replacedAt >= 600;
          }
          return !matches(button, cancelWords);
        }, 4500);
        if (changed) { confirmed++; failures = 0; }
        else if (++failures >= 2) throw new Error("连续两次未确认取消结果，已停止，请检查页面");
        idle = 0;
        await sleep(2000 + Math.floor(Math.random() * 1500));
        continue;
      }
      if (idle >= 5) return result(summary() + (attempted > confirmed ? "；仍有结果未确认，请人工核对，不会重复点击" :
        attempted ? "；当前列表处理完毕" : "；当前列表没有可识别的可用取消按钮"));
      if (++scrolls > 100) return result(summary() + "；已达到本次滚动上限，可检查后再次运行");
      show("正在加载已发送请求：" + summary());
      // Process each rendered viewport before moving. Loading everything first loses virtualized rows.
      const step = Math.max(100, (scroll.clientHeight || 600) * 0.75);
      const previousTop = scroll.scrollTop, previousHeight = scroll.scrollHeight;
      scroll.scrollTop += step;
      await sleep(1000);
      idle = scroll.scrollTop === previousTop && scroll.scrollHeight === previousHeight ? idle + 1 : 0;
    }
  }
  return auto().catch(error => {
    if (error.name === "AbortError") return result(summary() + "；任务已停止");
    return result(summary() + "；" + error.message, error.message);
  }).finally(() => ctrl.stop());
})();

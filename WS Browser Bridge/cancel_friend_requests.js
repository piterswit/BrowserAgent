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
  const requestedLimit = window.__fbCancelRequestOptions?.limit;
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 1000 ? requestedLimit : 100;
  const loadTarget = Math.ceil(limit * 1.5);
  const loadedProfiles = new Set(), loadedNodes = new WeakSet();
  let loaded = 0;
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
  const result = (detail, error = "") => ({attempted, confirmed, loaded, loadTarget, detail, error});
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
  const rendered = node => {
    if (!node || node.isConnected === false) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const css = style(parent);
      if (parent.hidden || parent.inert || parent.getAttribute?.("aria-hidden") === "true" ||
          css.display === "none" || /hidden|collapse/.test(css.visibility || "") ||
          css.opacity === "0") return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const visible = node => {
    if (!rendered(node)) return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.bottom > 0 && rect.top < window.innerHeight)) return false;
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
  const inLoadedBatch = (button, modal) => {
    const key = profileKey(button, modal);
    return key ? loadedProfiles.has(key) : loadedNodes.has(button);
  };
  const summary = () => "预加载 " + loaded + " 个，已尝试 " + attempted + " 个，界面确认取消 " + confirmed + " 个";
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
    let stable = 0;
    const loadDeadline = Date.now() + 30000;
    for (let loading = 0; ; loading++) {
      ensureUnblocked();
      if (!visible(modal)) throw new Error("好友请求窗口已关闭，已停止任务");
      scroll = scrollContainer(modal);
      const batch = buttons(modal).filter(node => rendered(node) && matches(node, cancelWords) &&
        !node.disabled && node.getAttribute?.("aria-disabled") !== "true")
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const previousLoaded = loaded;
      for (const button of batch) {
        if (loaded >= loadTarget) break;
        if (inLoadedBatch(button, modal)) continue;
        const key = profileKey(button, modal);
        if (key) loadedProfiles.add(key);
        else loadedNodes.add(button);
        loaded++;
      }
      show("正在预加载好友请求：" + loaded + "/" + loadTarget + "，随后从下往上取消");
      if (loaded >= loadTarget || stable >= 3 || loading >= 60 || Date.now() >= loadDeadline) {
        // Stay inside the sampled batch even if scrolling or deleting rows loads more requests.
        const boundary = batch.filter(button => inLoadedBatch(button, modal)).at(-1);
        boundary?.scrollIntoView?.({block: "end", inline: "nearest", behavior: "instant"});
        await sleep(300);
        break;
      }
      const previousTop = scroll.scrollTop, previousHeight = scroll.scrollHeight;
      const step = Math.max(100, (scroll.clientHeight || 600) * 0.75);
      scroll.scrollTop = Math.min(Math.max(0, scroll.scrollHeight - scroll.clientHeight), scroll.scrollTop + step);
      await sleep(Math.min(750, Math.max(1, loadDeadline - Date.now())));
      stable = scroll.scrollTop === previousTop && scroll.scrollHeight === previousHeight &&
        loaded === previousLoaded ? stable + 1 : 0;
    }
    let failures = 0, idle = 0, scrolls = 0, unstable = 0;
    for (;;) {
      ensureUnblocked();
      if (attempted >= limit) return result(summary() + "；已达到本次取消上限 " + limit + " 个");
      if (modal.isConnected === false || !visible(modal)) throw new Error("好友请求窗口已关闭，已停止任务");
      scroll = scrollContainer(modal);
      // Virtual lists render extra rows just outside the viewport. Include those
      // when choosing the bottom row, then reveal and revalidate it before clicking.
      const button = buttons(modal).filter(node => rendered(node) && !node.disabled &&
        node.getAttribute?.("aria-disabled") !== "true" &&
        matches(node, cancelWords) && inLoadedBatch(node, modal) && !wasAttempted(node, modal)).reverse()
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
      if (button) {
        const originalKey = profileKey(button, modal);
        button.scrollIntoView?.({block: "nearest", inline: "nearest", behavior: "instant"});
        await sleep(150);
        ensureUnblocked();
        // Scrolling can rerender a virtual list. Never click a stale or changed control.
        if (!enabled(button) || !matches(button, cancelWords) || !inLoadedBatch(button, modal) ||
            profileKey(button, modal) !== originalKey) {
          if (++unstable >= 20) throw new Error("好友请求列表持续重绘，无法确认操作对象，已停止任务");
          continue;
        }
        unstable = 0;
        const key = profileKey(button, modal);
        if (wasAttempted(button, modal)) continue;
        attemptedNodes.set(button, key);
        if (key) attemptedProfiles.add(key);
        attempted++;
        show("正在取消好友请求：" + summary());
        const previousDialogs = new Set(dialogs());
        const previousHeight = scroll.scrollHeight;
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
            if (!key || stillListed || !visible(modal) ||
                (scroll.scrollTop !== position && scroll.scrollHeight >= previousHeight)) { replacedAt = null; return false; }
            // A stable replacement in the same viewport can reuse the same DOM button.
            replacedAt ??= Date.now();
            return Date.now() - replacedAt >= 600;
          }
          return !matches(button, cancelWords);
        }, 4500);
        if (changed) { confirmed++; failures = 0; }
        else if (++failures >= 2) throw new Error("连续两次未确认取消结果，已停止，请检查页面");
        idle = 0;
        if (attempted >= limit) continue;
        await sleep(2000 + Math.floor(Math.random() * 1500));
        continue;
      }
      if (idle >= 5) return result(summary() + (attempted > confirmed ? "；仍有结果未确认，请人工核对，不会重复点击" :
        attempted ? "；本次预加载范围已处理完毕" : "；本次预加载范围没有可识别的可用取消按钮"));
      if (++scrolls > 100) return result(summary() + "；已达到本次滚动上限，可检查后再次运行");
      show("正在加载已发送请求：" + summary());
      // Requery each viewport while moving upward; virtualized rows are never cached for clicking.
      const step = Math.max(100, (scroll.clientHeight || 600) * 0.75);
      const previousTop = scroll.scrollTop, previousHeight = scroll.scrollHeight;
      scroll.scrollTop = Math.max(0, scroll.scrollTop - step);
      await sleep(1000);
      idle = scroll.scrollTop === previousTop && scroll.scrollHeight === previousHeight ? idle + 1 : 0;
    }
  }
  return auto().catch(error => {
    if (error.name === "AbortError") return result(summary() + "；任务已停止");
    return result(summary() + "；" + error.message, error.message);
  }).finally(() => ctrl.stop());
})();

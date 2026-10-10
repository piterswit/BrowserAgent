(() => {
  const labels = {
    like: /^(Like|赞|讚|点赞|點讚|按赞|按讚)$/i,
    comment: /^(Comment|评论|評論|留言|回覆)$/i,
    share: /^(Share|分享)$/i,
    story: /^(Share to (your )?story|分享至(你的|您的)?(快拍|限时动态|限時動態)|分享到(你的|您的)?(快拍|限时动态|限時動態)|限时动态|限時動態|快拍)$/i,
    publish: /^(Share( now)?|Post|分享|立即分享|发布|發佈|發表)$/i,
    join: /^(Join( group)?|加入(小组|小組|社團)?)$/i
  };
  const comments = ["Thanks for sharing!", "Interesting perspective.", "Nice post!", "Great photos!"];
  const random = (min, max) => min + Math.random() * (max - min);
  const text = node => (node.getAttribute("aria-label") || node.innerText || "").replace(/\s+/g, " ").trim();
  const visible = node => {
    if (!node?.isConnected || node.getAttribute("aria-disabled") === "true" || node.disabled) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  };
  const buttons = scope => [...scope.querySelectorAll('[role="button"], button')].filter(visible);
  const closeChatWords = /^(Close chat|Close conversation|Close chat window|Close chat with .+|关闭聊天|关闭聊天窗口|关闭对话|关闭与.+的聊天|關閉聊天|關閉聊天室|關閉聊天視窗|關閉對話|關閉與.+的聊天室)$/i;
  const chatScope = scope => buttons(scope).some(node => closeChatWords.test(text(node)));
  const unliked = node => labels.like.test(text(node)) &&
    !["aria-pressed", "aria-checked"].some(name => node.getAttribute(name) === "true") &&
    !/^(Liked|Unlike|Remove like|已赞|已讚|已点赞|已點讚|取消赞|取消讚|取消点赞|取消點讚|收回赞|收回讚)$/i.test((node.innerText || "").trim());
  const findButton = (scope, pattern) => buttons(scope).find(node => pattern.test(text(node)));
  const overlays = () => [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(visible);
  const history = window.__fbInteractionHistory ||= new Map();
  for (const [key, time] of history) if (Date.now() - time > 86400000) history.delete(key);
  while (history.size > 2000) history.delete(history.keys().next().value);

  function identity(scope, kind) {
    for (const anchor of scope.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.href, location.href);
        if (!/(^|\.)facebook\.com$/.test(url.hostname)) continue;
        if (kind === "join") {
          const match = url.pathname.match(/^\/groups\/([^/]+)\/?$/);
          if (match && !["feed", "discover", "joins"].includes(match[1])) return "group:" + match[1];
        } else {
          const match = url.pathname.match(/\/(posts|videos|permalink)\/([^/]+)/);
          if (match) return match[1] + ":" + match[2];
          const id = url.searchParams.get("story_fbid");
          if (id) return "post:" + id;
        }
      } catch {}
    }
    return null;
  }

  window.__fbActivityInteractions = ctrl => {
    const counts = {like: 0, comment: 0, share: 0, join: 0};
    const reels = window.__fbActivityRequest?.mode === "reels";
    const limits = {like: reels ? 2 : 3, comment: 2, share: 2, join: 1};
    const seenNodes = new WeakSet();
    let nextAttempt = Date.now() + random(30000, 50000);
    const ownedOverlays = new Set();
    const draft = node => (node.value || node.innerText || "").trim();
    const editors = scope => [...scope.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')];
    const closeWords = /^(Close|Close dialog|关闭|關閉)$/i;
    let nextNotifications = Date.now() + random(45000, 90000), notificationVisits = 0;
    function safeCleanup() {
      if (!ctrl.run || document.hidden || Date.now() - ctrl.lastInput < 10000) return;
      for (const scope of ownedOverlays) {
        if (!visible(scope)) { ownedOverlays.delete(scope); continue; }
        if (editors(scope).some(node => draft(node))) continue;
        const close = findButton(scope, closeWords);
        if (close) { close.click(); ownedOverlays.delete(scope); }
        else if (scope.dispatchEvent) scope.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", bubbles: true}));
      }
    }
    function maintainPage() {
      safeCleanup();
      if (ctrl.mode !== "home" || !ctrl.run || document.hidden || Date.now() - ctrl.lastInput < 10000) return;
      for (const button of buttons(document).filter(node => closeChatWords.test(text(node)))) {
        let scope = button.closest('[role="dialog"], [role="complementary"]');
        if (!scope) {
          for (let parent = button.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
            const rect = parent.getBoundingClientRect();
            if (rect.width >= 180 && rect.width < innerWidth * 0.5 && rect.left > innerWidth * 0.4 && rect.bottom >= innerHeight - 80) { scope = parent; break; }
          }
        }
        if (!scope || !visible(scope)) continue;
        if (editors(scope).some(node => draft(node))) { ctrl.report("暂停：聊天窗口有未发送草稿，请人工处理"); continue; }
        button.click();
      }
    }
    async function maybeNotifications() {
      if (ctrl.mode !== "home" || notificationVisits >= 2 || Date.now() < nextNotifications || !ctrl.canAct()) return false;
      nextNotifications = Date.now() + random(90000, 150000);
      const notificationWords = /^(Notifications?|通知|通知消息|通知訊息)(?:[,，:：\s]+\d+.*)?$/i;
      const trigger = [...document.querySelectorAll('[role="banner"] [role="button"], [role="banner"] button, header [role="button"], header button')]
        .filter(visible).find(node => notificationWords.test(text(node)));
      if (!trigger || trigger.getAttribute("aria-expanded") === "true") return false;
      const previous = new Set(overlays());
      const lastInput = ctrl.lastInput;
      let panel;
      try {
        await click(trigger);
        notificationVisits++;
        panel = await waitFor(() => {
          const controlled = document.getElementById?.(trigger.getAttribute("aria-controls"));
          return controlled && visible(controlled) && !previous.has(controlled) ? controlled :
            overlays().find(node => !previous.has(node) && (/^(Notifications?|通知)/i.test(text(node)) ||
              [...node.querySelectorAll('[role="heading"], h1, h2')].some(heading => notificationWords.test(text(heading)))));
        }, () => panel || overlays().find(node => !previous.has(node)) || null);
        if (!panel) return true;
        const scrolling = node => node.scrollHeight > node.clientHeight + 24 && /auto|scroll/.test(getComputedStyle(node).overflowY);
        const target = [panel, ...panel.querySelectorAll("*")].find(node => visible(node) && scrolling(node));
        const turns = Math.floor(random(2, 5));
        for (let i = 0; i < turns; i++) {
          await ctrl.sleep(random(1200, 2200));
          check(panel);
          if (!visible(panel)) break;
          target?.scrollBy({top: (target.clientHeight || 300) * random(0.45, 0.8), behavior: "instant"});
        }
        return true;
      } catch (error) { if (error.name === "AbortError") throw error; return false; }
      finally {
        if (ctrl.run && !document.hidden && ctrl.lastInput === lastInput &&
            (trigger.getAttribute("aria-expanded") === "true" || panel && visible(panel))) {
          trigger.click();
          if (panel) ownedOverlays.add(panel);
          safeCleanup();
        }
      }
    }
    const check = (scope, editor) => {
      ctrl.guard();
      if (!ctrl.canAct(scope, editor, true)) throw Object.assign(new Error("Interaction paused"), {name: "InteractionPaused"});
    };
    async function click(node, scope = null, editor = null, validate = () => true) {
      await ctrl.sleep(random(800, 1800));
      check(scope, editor);
      if (!visible(node) || !validate()) throw new Error("Target is no longer available");
      node.click();
    }
    async function waitFor(find, scope = null, editor = null) {
      for (let elapsed = 0; elapsed < 6000; elapsed += 300) {
        ctrl.guard();
        const result = find();
        check(typeof scope === "function" ? scope() : scope, editor);
        if (result) return result;
        await ctrl.sleep(300);
      }
      return null;
    }
    // Only adopt a new overlay opened by our own click, never a pre-existing dialog.
    async function openedOverlay(previous) {
      const scope = await waitFor(() => overlays().find(node => !previous.has(node)),
        () => overlays().find(node => !previous.has(node)) || null);
      if (scope) ownedOverlays.add(scope);
      return scope;
    }
    function candidates(kind) {
      const items = [];
      if (kind === "join") {
        for (const button of buttons(document).filter(node => labels.join.test(text(node)))) {
          let scope = button.parentElement;
          for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
            const key = identity(scope, kind);
            if (key && buttons(scope).filter(node => labels.join.test(text(node))).length === 1) {
              items.push({button, scope, key}); break;
            }
          }
        }
      } else {
        for (const scope of document.querySelectorAll('[role="article"]')) {
          if (scope.closest?.('[role="dialog"], [role="menu"], [role="complementary"]')) continue;
          const button = findButton(scope, labels[kind]);
          if (!button || (kind === "like" && !unliked(button))) continue;
          const id = identity(scope, kind);
          if (kind !== "like" && !id) continue;
          items.push({button, scope, key: id});
        }
        if (reels && kind === "like" && !items.length) {
          for (const button of buttons(document).filter(unliked)) {
            const scope = button.closest('[role="article"]') || button.parentElement;
            if (scope) items.push({button, scope, key: identity(scope, kind)});
          }
        }
      }
      return items.filter(item => !seenNodes.has(item.button) &&
        (!item.key || !history.has(kind + ":" + item.key)));
    }
    async function comment(item) {
      // Do not replace or submit someone else's draft.
      const selector = '[contenteditable="true"][role="textbox"], textarea';
      if ([...item.scope.querySelectorAll(selector)].some(node => (node.value || node.innerText || "").trim())) return;
      const previous = new Set(overlays());
      await click(item.button, null, null, () => identity(item.scope, "comment") === item.key);
      let scope = item.scope;
      const editor = await waitFor(() => {
        scope = overlays().find(node => !previous.has(node) && !chatScope(node)) || item.scope;
        if (scope !== item.scope) ownedOverlays.add(scope);
        return [...scope.querySelectorAll(selector)].find(visible);
      }, () => scope);
      if (!editor || (editor.value || editor.innerText || "").trim()) return;
      const value = comments[Math.floor(Math.random() * comments.length)];
      const lastInput = ctrl.lastInput;
      if (scope !== item.scope) ownedOverlays.add(scope);
      let inserted = false, submitted = false;
      try {
        check(scope);
        editor.focus();
        await ctrl.sleep(random(1500, 3000));
        check(scope, editor);
        if (typeof document.execCommand !== "function" || !document.execCommand("insertText", false, value)) return false;
        inserted = true;
        await ctrl.sleep(random(1500, 3000));
        check(scope, editor);
        if (draft(editor) !== value) return false;
        const sendWords = /^(Post comment|Send comment|Submit comment|Send|Post|发布评论|发表评论|发送评论|发布|发送|發佈留言|發表留言|送出留言|發佈|發表|傳送|送出)$/i;
        let parent = editor.parentElement, send;
        for (let depth = 0; parent && scope.contains(parent) && depth < 4; depth++, parent = parent.parentElement) {
          send = findButton(parent, sendWords);
          if (send || parent === scope) break;
        }
        if (send) await click(send, scope, editor, () => draft(editor) === value);
        else {
          editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
          editor.dispatchEvent(new KeyboardEvent("keyup", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
        }
        for (let elapsed = 0; elapsed < 4000; elapsed += 300) {
          await ctrl.sleep(300);
          check(scope, editor);
          if (!editor.isConnected || !draft(editor)) { submitted = true; break; }
          if (draft(editor) !== value) break;
        }
        if (!submitted) ctrl.report("评论提交未确认：本次不重发，恢复浏览");
        return submitted;
      } finally {
        // Never erase a user's edit, retry an uncertain submission, or act after Stop.
        if (ctrl.run && !document.hidden && ctrl.lastInput === lastInput) {
          if (inserted && !submitted && editor.isConnected && draft(editor) === value) {
            if (editor.tagName === "TEXTAREA") {
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
              if (setter) setter.call(editor, "");
              else editor.value = "";
              editor.dispatchEvent(new Event("input", {bubbles: true}));
            } else if (document.createRange && window.getSelection && editor.isContentEditable) {
              editor.focus();
              const range = document.createRange(); range.selectNodeContents(editor);
              const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
              document.execCommand("delete", false, null);
              editor.dispatchEvent(new Event("input", {bubbles: true}));
            }
          }
          if (!draft(editor) && document.activeElement === editor) editor.blur();
          safeCleanup();
        }
      }
    }
    async function share(item) {
      const previous = new Set(overlays());
      await click(item.button, null, null, () => identity(item.scope, "share") === item.key);
      const menu = await openedOverlay(previous);
      if (!menu) return;
      const option = findButton(menu, labels.story);
      if (!option) return;
      const beforeStory = new Set(overlays());
      await click(option, menu);
      const composer = await openedOverlay(beforeStory);
      if (!composer) return;
      check(composer);
      const publish = findButton(composer, labels.story) || findButton(composer, labels.publish);
      if (publish) await click(publish, composer);
    }
    async function execute(kind, item) {
      check();
      if (counts[kind] >= limits[kind] || seenNodes.has(item.button) ||
          (item.key && history.has(kind + ":" + item.key))) return false;
      // Reserve attempts before clicking: an uncertain submission must not be repeated.
      seenNodes.add(item.button);
      if (item.key) history.set(kind + ":" + item.key, Date.now());
      counts[kind]++;
      if (kind === "comment") return await comment(item);
      else if (kind === "share") await share(item);
      else {
        if (kind === "like" && !unliked(item.button)) return false;
        await click(item.button, null, null, () =>
          (!item.key || identity(item.scope, kind) === item.key) &&
          (kind !== "like" || unliked(item.button)));
        await ctrl.sleep(1500);
      }
      return true;
    }
    return {
      counts, limits, maintainPage, maybeNotifications,
      async maybeInteract(allowed = ["like", "comment", "share", "join"]) {
        if (Date.now() < nextAttempt || !ctrl.canAct(null, null, true)) return false;
        nextAttempt = Date.now() + random(60000, 100000);
        const options = allowed.filter(kind => counts[kind] < limits[kind])
          .map(kind => ({kind, items: candidates(kind)})).filter(option => option.items.length);
        if (!options.length) return false;
        const choice = options[Math.floor(Math.random() * options.length)];
        const item = choice.items[Math.floor(Math.random() * choice.items.length)];
        try { return await execute(choice.kind, item); }
        catch (error) { if (error.name === "AbortError") throw error; return false; }
        finally { safeCleanup(); }
      }
    };
  };
})();

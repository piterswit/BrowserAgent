(() => {
  const labels = {
    like: /^(Like|赞|讚|点赞|點讚|按赞|按讚)$/i,
    comment: /^(Comment|评论|評論|留言|回覆)$/i,
    share: /^(Share|分享)$/i,
    story: /^(Share to (your )?story|分享至(你的|您的)?(快拍|限时动态|限時動態)|分享到(你的|您的)?(快拍|限时动态|限時動態)|限时动态|限時動態|快拍)(?:\s*[(（](Friends|Public|Only me|好友|朋友|公开|公開|仅自己|僅限本人)[)）])?$/i,
    publish: /^(Share( now)?|Post|分享|立即分享|发布|發佈|發表)$/i,
    join: /^(Join( group)?|加入(小组|小組|社團)?)$/i
  };
  const comments = ["Thanks for sharing!", "Interesting perspective.", "Nice post!", "Great photos!"];
  const random = (min, max) => min + Math.random() * (max - min);
  const text = node => (node.getAttribute("aria-label") || node.innerText || "").replace(/\s+/g, " ").trim();
  const texts = node => [node.getAttribute("aria-label"), node.innerText].filter(Boolean)
    .map(value => value.replace(/\s+/g, " ").trim());
  const matches = (node, pattern) => texts(node).some(value => pattern.test(value));
  const visible = node => {
    if (!node?.isConnected || node.getAttribute("aria-disabled") === "true" || node.disabled) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  };
  const buttons = scope => [...scope.querySelectorAll('[role="button"], button')].filter(visible);
  const closeChatWords = /^(Close chat|Close conversation|Close chat window|Close chat with .+|关闭聊天|关闭聊天窗口|关闭对话|关闭与.+的聊天|關閉聊天|關閉聊天室|關閉聊天視窗|關閉對話|關閉與.+的聊天室)$/i;
  const chatScope = scope => buttons(scope).some(node => closeChatWords.test(text(node)));
  const likedWords = /^(Liked|Unlike|Remove like|已赞|已讚|已点赞|已點讚|取消赞|取消讚|取消点赞|取消點讚|收回赞|收回讚)$/i;
  const liked = node => ["aria-pressed", "aria-checked"].some(name => node.getAttribute(name) === "true") ||
    matches(node, likedWords);
  const hasActionMarker = (node, kind) => ["like", "comment", "share"].includes(kind) &&
    [...node.querySelectorAll(`[data-ad-rendering-role="${kind}_button"]`)]
      .some(marker => marker.closest('[role="button"], button') === node);
  const isAction = (node, kind) => matches(node, labels[kind]) || hasActionMarker(node, kind);
  const actionButtons = (scope, kind) => {
    const found = new Set(buttons(scope).filter(node => isAction(node, kind)));
    if (!["like", "comment", "share"].includes(kind)) return [...found];
    for (const marker of scope.querySelectorAll(`[data-ad-rendering-role="${kind}_button"]`)) {
      if (marker.closest('[role="button"], button')) continue;
      // Some feed layouts use a plain div around a marker and its action label.
      for (let node = marker.parentElement, depth = 0; node && node !== scope && depth < 4; node = node.parentElement, depth++) {
        if (node.closest('[role="article"]') !== scope) break;
        const markers = ["like", "comment", "share"].flatMap(action =>
          [...node.querySelectorAll(`[data-ad-rendering-role="${action}_button"]`)]);
        if (markers.length !== 1) break;
        if (visible(node) && matches(node, labels[kind])) { found.add(node); break; }
      }
    }
    return [...found];
  };
  // An icon/counter alone says nothing about whether the current user already liked it.
  const unliked = node => isAction(node, "like") && !liked(node) &&
    (matches(node, labels.like) || ["aria-pressed", "aria-checked"].some(name => node.getAttribute(name) === "false"));
  const findButton = (scope, pattern) => buttons(scope).find(node => matches(node, pattern));
  const findStoryOption = scope => {
    const enabled = node => {
      if (!visible(node) || !window.__fbActivityRuntime.visible(node)) return false;
      for (let parent = node; parent && scope.contains(parent); parent = parent.parentElement) {
        if (parent.disabled || parent.getAttribute("aria-disabled") === "true") return false;
        if (parent === scope) break;
      }
      return true;
    };
    const controls = [...scope.querySelectorAll('[role="button"], button, [role="menuitem"]')];
    const semantic = controls.find(node => enabled(node) && matches(node, labels.story));
    if (semantic) return semantic;
    const options = [...scope.querySelectorAll("span, div")].filter(node => {
      if (!enabled(node) || !matches(node, labels.story) ||
          !/^(Share to |分享到|分享至)/i.test(text(node))) return false;
      if (node.closest('h1, h2, h3, h4, h5, h6, [role="heading"], a[href], input, textarea, [contenteditable="true"]')) return false;
      return ![...node.children].some(child => matches(child, labels.story));
    });
    // Text-only menus have no semantic click target; use one unambiguous leaf so the click bubbles.
    return options.length === 1 ? options[0] : null;
  };
  const scopeVisible = node => window.__fbActivityRuntime.visible(node);
  const overlays = () => [...document.querySelectorAll('[role="dialog"], [role="menu"]')].filter(scopeVisible);
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
    const home = ctrl.mode === "home";
    const reels = window.__fbActivityRequest?.mode === "reels";
    const limits = {like: reels ? 2 : home ? 5 : 3, comment: 2, share: home ? 1 : 2, join: 1};
    const homePlan = ["like", "comment", "like", "share", "like", "comment", "like", "like"];
    let planIndex = 0;
    const scanIssues = {};
    const recordAttempt = (kind, item) => {
      counts[kind]++;
      if (item.key) history.set(kind + ":" + item.key, Date.now());
      else {
        if (!seenNodes.has(item.button)) seenNodes.set(item.button, new Set());
        seenNodes.get(item.button).add(kind);
      }
      ctrl.recordInteraction(kind);
    };
    const seenNodes = new WeakMap();
    const inFlight = new Set();
    const handled = (item, kind) => item.key ? history.has(kind + ":" + item.key) : seenNodes.get(item.button)?.has(kind);
    const reservation = (item, kind) => item.key ? kind + ":" + item.key : item.button;
    let nextAttempt = Date.now() + (home ? random(20000, 30000) : random(30000, 50000));
    const ownedOverlays = new Set();
    const closeAttempts = new WeakMap();
    function adoptOverlay(scope) {
      if (!window.__fbActivityRuntime.isProtectedOverlay(scope)) {
        ownedOverlays.add(scope); ctrl.interactionScopes.add(scope);
      }
    }
    const pendingDrafts = new Map();
    let pendingNotification = null;
    const draft = node => (node.value || node.innerText || "").trim();
    const editors = scope => [...scope.querySelectorAll('[contenteditable="true"][role="textbox"], textarea')];
    const closeWords = /^(Close(?: (?:dialog|window|popup|post|comments?))?|关闭(?:窗口|弹窗|对话框|帖子|评论)?|關閉(?:視窗|彈窗|對話方塊|貼文|帖子|評論|留言)?)$/i;
    let nextNotifications = Date.now() + random(45000, 90000), notificationVisits = 0;
    function cleanupDrafts() {
      for (const [editor, {scope, value, lastInput}] of pendingDrafts) {
        if (!editor.isConnected || draft(editor) !== value || ctrl.userInputChanged(lastInput)) {
          pendingDrafts.delete(editor); continue;
        }
        ctrl.guard();
        if (!ctrl.canAct(scope, editor, true)) continue;
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
        if (!draft(editor)) {
          if (document.activeElement === editor) editor.blur();
          pendingDrafts.delete(editor);
        }
      }
    }
    function safeCleanup() {
      if (!ctrl.pageAvailable() || ctrl.recentUserInput()) return;
      if (window.__fbActivityRuntime.hasProtectedOverlay()) { ctrl.canAct(); return; }
      cleanupDrafts();
      if (pendingNotification) {
        const {trigger, panel, lastInput} = pendingNotification;
        if (trigger.isConnected && !ctrl.userInputChanged(lastInput) &&
            (trigger.getAttribute("aria-expanded") === "true" || panel && visible(panel))) {
          ctrl.guard();
          trigger.click();
          if (panel) ownedOverlays.add(panel);
        }
        pendingNotification = null;
      }
      for (const scope of ownedOverlays) {
        if (window.__fbActivityRuntime.hasProtectedOverlay()) { ctrl.canAct(); return; }
        if (!scopeVisible(scope)) { ownedOverlays.delete(scope); closeAttempts.delete(scope); continue; }
        if (editors(scope).some(node => draft(node))) continue;
        const attempt = closeAttempts.get(scope) || {count: 0, at: -Infinity};
        if (attempt.count >= 3 || Date.now() - attempt.at < 1500) continue;
        const close = buttons(scope).find(node => matches(node, closeWords) &&
          node.closest('[role="dialog"], [role="menu"]') === scope);
        ctrl.guard();
        closeAttempts.set(scope, {count: attempt.count + 1, at: Date.now()});
        if (close) close.click();
        else if (scope.dispatchEvent) {
          for (const type of ["keydown", "keyup"]) {
            ctrl.guard();
            scope.dispatchEvent(new KeyboardEvent(type, {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true}));
          }
        }
        // A click is not proof that the popup closed; retry only while it remains visible.
        if (!scopeVisible(scope)) { ownedOverlays.delete(scope); closeAttempts.delete(scope); }
      }
    }
    function maintainPage() {
      safeCleanup();
      if (ctrl.mode !== "home" || !ctrl.pageAvailable() || ctrl.recentUserInput()) return;
      if (window.__fbActivityRuntime.hasProtectedOverlay()) { ctrl.canAct(); return; }
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
        if (ctrl.run) pendingNotification = {trigger, panel, lastInput};
        ctrl.interactionScopes.clear();
        safeCleanup();
      }
    }
    const check = (scope, editor) => {
      ctrl.guard();
      if (!ctrl.canAct(scope, editor, true)) throw Object.assign(new Error("Interaction paused"), {name: "InteractionPaused"});
    };
    async function click(node, scope = null, editor = null, validate = () => true, beforeClick = () => {}) {
      await ctrl.sleep(random(800, 1800));
      check(scope, editor);
      if (!visible(node) || !validate()) throw new Error("Target is no longer available");
      beforeClick();
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
      if (scope) adoptOverlay(scope);
      return scope;
    }
    function candidates(kind) {
      const items = [];
      let entries = 0, unknown = 0, processed = 0;
      delete scanIssues[kind];
      if (kind === "join") {
        for (const button of buttons(document).filter(node => matches(node, labels.join))) {
          let scope = button.parentElement;
          for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
            const key = identity(scope, kind);
            if (key && buttons(scope).filter(node => matches(node, labels.join)).length === 1) {
              items.push({button, scope, key}); break;
            }
          }
        }
      } else {
        for (const scope of document.querySelectorAll('[role="article"]')) {
          if (scope.closest?.('[role="dialog"], [role="menu"], [role="complementary"]')) continue;
          const actions = actionButtons(scope, kind);
          entries += actions.length;
          const button = actions.find(node => {
            if (kind === "like" && !unliked(node)) {
              if (liked(node)) processed++; else unknown++;
              return false;
            }
            if (handled({button: node, key: identity(scope, kind)}, kind)) { processed++; return false; }
            return true;
          });
          if (!button || (kind === "like" && !unliked(button))) continue;
          const id = identity(scope, kind);
          if (kind !== "like" && !id) {
            scanIssues[kind] = "找到入口，但缺少可校验的帖子链接"; continue;
          }
          items.push({button, scope, key: id});
        }
        if (reels && kind === "like" && !items.length) {
          for (const button of buttons(document).filter(unliked)) {
            const scope = button.closest('[role="article"]') || button.parentElement;
            if (scope) items.push({button, scope, key: identity(scope, kind)});
          }
        }
      }
      const available = items.filter(item => !handled(item, kind) && !inFlight.has(reservation(item, kind)));
      if (!available.length && ["like", "comment", "share"].includes(kind) && !scanIssues[kind]) {
        const name = {like: "点赞", comment: "评论", share: "分享"}[kind];
        scanIssues[kind] = unknown ? `发现 ${unknown} 个图标点赞入口，但缺少已赞／未赞状态，未点击以免取消已有点赞` :
          processed ? `发现 ${entries} 个可见${name}入口，其中 ${processed} 个已互动或已处理` :
          `未找到可见的${name}入口（帖子容器 ${document.querySelectorAll('[role="article"]').length} 个）`;
      }
      return available;
    }
    async function comment(item) {
      // Do not replace or submit someone else's draft.
      const selector = '[contenteditable="true"][role="textbox"], textarea';
      if ([...item.scope.querySelectorAll(selector)].some(node => (node.value || node.innerText || "").trim())) {
        ctrl.noteInteractionIssue("帖子已有未发送草稿", "comment"); return false;
      }
      const previous = new Set(overlays());
      let scope = item.scope, editor = null;
      const value = comments[Math.floor(Math.random() * comments.length)];
      const lastInput = ctrl.lastInput;
      let inserted = false, submitted = false;
      const base = new URL(location.href);
      const route = home ? {
        busy: true, expires: 0,
        allows(href, path) {
          try {
            const url = new URL(href);
            if (url.origin !== base.origin || url.pathname !== path) return false;
            if (url.pathname === base.pathname) return true;
            const match = url.pathname.match(/\/(posts|videos|permalink)\/([^/]+)/);
            const id = match?.[2] || (url.pathname === "/permalink.php" ? url.searchParams.get("story_fbid") : null);
            return !!id && id === item.key?.slice(item.key.indexOf(":") + 1);
          } catch { return false; }
        }
      } : null;
      try {
        await click(item.button, null, null, () => identity(item.scope, "comment") === item.key, () => {
          if (route) { route.expires = Date.now() + 45000; ctrl.commentNavigation = route; }
        });
        const commentOverlay = node => {
          if (chatScope(node) || window.__fbActivityRuntime.isProtectedOverlay(node)) return false;
          const key = identity(node, "comment");
          if (key) return key === item.key;
          const names = [node.getAttribute("aria-label"),
            ...[...node.querySelectorAll('[role="heading"], h1, h2')].map(text)];
          return names.some(value => /comments?|评论|評論|留言/i.test(value || "")) ||
            editors(node).some(editor => /comments?|评论|評論|留言/i.test(editor.getAttribute("aria-label") || "")) ||
            !!findButton(node, /^(Post comment|Send comment|Submit comment|发表评论|发布评论|發佈留言|發表留言|送出留言)$/i);
        };
        editor = await waitFor(() => {
          scope = overlays().find(node => !previous.has(node) && commentOverlay(node)) || item.scope;
          if (scope !== item.scope) adoptOverlay(scope);
          return [...scope.querySelectorAll(selector)].find(visible);
        }, () => scope);
        if (!editor || (editor.value || editor.innerText || "").trim()) {
          ctrl.noteInteractionIssue(editor ? "评论框已有草稿" : "点击评论后未找到可见的评论框", "comment"); return false;
        }
        if (scope !== item.scope) adoptOverlay(scope);
        check(scope);
        editor.focus();
        await ctrl.sleep(random(1500, 3000));
        check(scope, editor);
        if (typeof document.execCommand !== "function" || !document.execCommand("insertText", false, value)) {
          ctrl.noteInteractionIssue("未能向评论框写入内容", "comment"); return false;
        }
        inserted = true;
        await ctrl.sleep(random(1500, 3000));
        check(scope, editor);
        if (draft(editor) !== value || identity(item.scope, "comment") !== item.key) {
          ctrl.noteInteractionIssue("评论内容或目标帖子发生变化，未提交", "comment"); return false;
        }
        const sendWords = /^(Post comment|Send comment|Submit comment|Send|Post|发布评论|发表评论|发送评论|发布|发送|發佈留言|發表留言|送出留言|發佈|發表|傳送|送出)$/i;
        const locateSend = () => {
          for (let parent = editor.parentElement, depth = 0; parent && scope.contains(parent) && depth < 8; depth++, parent = parent.parentElement) {
            const localEditors = editors(parent).filter(visible);
            if (localEditors.length !== 1 || localEditors[0] !== editor) break;
            const submit = [...parent.querySelectorAll('[id="focused-state-composer-submit"]')];
            const targets = [...new Set([...submit.flatMap(node => [...node.querySelectorAll('[role="button"], button')]),
              ...parent.querySelectorAll('[role="button"], button')])].filter(node => matches(node, sendWords));
            if (targets.length) return {send: targets.find(visible), pending: true};
            if (parent === scope) break;
          }
          return {send: null, pending: false};
        };
        let send, pending;
        for (let elapsed = 0; elapsed <= 3000; elapsed += 300) {
          check(scope, editor);
          if (draft(editor) !== value || identity(item.scope, "comment") !== item.key) {
            ctrl.noteInteractionIssue("等待发送时评论内容或目标帖子发生变化，未提交", "comment"); return false;
          }
          ({send, pending} = locateSend());
          if (send || elapsed === 3000) break;
          await ctrl.sleep(300);
        }
        if (!send && pending) {
          ctrl.noteInteractionIssue("已填写评论，但发送按钮仍不可用，未提交", "comment"); return false;
        }
        if (send) await click(send, scope, editor, () => draft(editor) === value && identity(item.scope, "comment") === item.key, () => recordAttempt("comment", item));
        else {
          recordAttempt("comment", item);
          editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
          editor.dispatchEvent(new KeyboardEvent("keyup", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
        }
        for (let elapsed = 0; elapsed < 4000; elapsed += 300) {
          await ctrl.sleep(300);
          check(scope, editor);
          if (!editor.isConnected) break;
          if (!draft(editor)) { submitted = true; ctrl.recordInteraction("comment", true); break; }
          if (draft(editor) !== value) break;
        }
        if (!submitted) {
          ctrl.noteInteractionIssue(send ? "已点击发送，但评论未确认，本次不重发" : "未找到发送按钮，Enter 提交未确认，本次不重发", "comment");
          ctrl.report("评论提交未确认：本次不重发，恢复浏览");
        }
        return submitted;
      } finally {
        if (route) route.busy = false;
        // Never erase a user's edit, retry an uncertain submission, or act after Stop.
        if (ctrl.run && inserted && !submitted && editor.isConnected && draft(editor) === value) {
          pendingDrafts.set(editor, {scope, value, lastInput});
        }
        if (ctrl.pageAvailable() && !ctrl.userInputChanged(lastInput)) {
          cleanupDrafts();
          if (editor && !draft(editor) && document.activeElement === editor) editor.blur();
          safeCleanup();
        }
      }
    }
    async function share(item) {
      const previous = new Set(overlays());
      await click(item.button, null, null, () => identity(item.scope, "share") === item.key);
      const menu = await openedOverlay(previous);
      if (!menu) { ctrl.noteInteractionIssue("点击分享后未识别分享菜单", "share"); return; }
      const option = findStoryOption(menu);
      if (!option) { ctrl.noteInteractionIssue("分享菜单没有可见的快拍入口", "share"); return; }
      const previousMessages = new Map([...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => [node, text(node)]));
      const successNotice = () => [...document.querySelectorAll('[role="alert"], [role="status"]')].filter(visible)
        .some(node => previousMessages.get(node) !== text(node) && /story.*(shared|added|published)|shared.*story|(?:快拍|限时动态|限時動態).*(已分享|已发布|已發佈|已發表|成功)|(?:已分享|已发布|已發佈|已發表).*(?:快拍|限时动态|限時動態)/i.test(text(node)));
      const beforeStory = new Set(overlays());
      const beforeText = texts(menu).join("\n");
      // Selecting this entry may publish immediately; never submit it twice to find out.
      await click(option, menu, null, () => identity(item.scope, "share") === item.key && findStoryOption(menu) === option,
        () => recordAttempt("share", item));
      let composer;
      const next = await waitFor(() => {
        if (successNotice()) return "confirmed";
        composer = overlays().find(node => !beforeStory.has(node)) ||
          (scopeVisible(menu) && texts(menu).join("\n") !== beforeText && findButton(menu, labels.publish) ? menu : null);
        return composer;
      }, () => composer || overlays().find(node => !beforeStory.has(node)) || menu);
      if (next === "confirmed") { ctrl.recordInteraction("share", true); return; }
      if (!composer) { ctrl.noteInteractionIssue("已选择快拍入口，未收到成功提示或确认窗口，不重发", "share"); return; }
      adoptOverlay(composer);
      check(composer);
      const publish = findButton(composer, labels.story) || findButton(composer, labels.publish);
      if (publish) {
        await click(publish, composer, null, () => identity(item.scope, "share") === item.key);
        await ctrl.sleep(1500);
        ctrl.guard();
        if (successNotice()) ctrl.recordInteraction("share", true);
      } else ctrl.noteInteractionIssue("快拍确认窗口没有可见的发布按钮", "share");
    }
    async function perform(kind, item) {
      check();
      if (kind === "comment") return await comment(item);
      else if (kind === "share") await share(item);
      else {
        if (kind === "like" && !unliked(item.button)) return false;
        let canReacquire = false;
        await click(item.button, null, null, () =>
          (!item.key || identity(item.scope, kind) === item.key) &&
          (kind !== "like" || unliked(item.button)), () => {
            canReacquire = kind === "like" && buttons(item.scope)
              .filter(node => isAction(node, "like") || matches(node, likedWords)).length === 1;
            recordAttempt(kind, item);
          });
        if (kind === "like") {
          // React may replace the button; only follow an unambiguous action on the same post.
          for (let elapsed = 0; elapsed < 3000; elapsed += 300) {
            await ctrl.sleep(300);
            check();
            let scope = item.scope;
            if (!scope.isConnected && item.key && canReacquire) {
              const samePost = [...document.querySelectorAll('[role="article"]')]
                .filter(node => node.isConnected && identity(node, "like") === item.key &&
                  !node.closest?.('[role="dialog"], [role="menu"], [role="complementary"]'));
              scope = samePost.length === 1 ? samePost[0] : null;
            }
            if (!scope?.isConnected || item.key && identity(scope, "like") !== item.key) break;
            let button = item.button.isConnected && scope.contains(item.button) ? item.button : null;
            if (!button && canReacquire) {
              const actions = buttons(scope).filter(node => isAction(node, "like") || matches(node, likedWords));
              if (actions.length === 1) button = actions[0];
            }
            if (button && visible(button) && liked(button)) {
              ctrl.recordInteraction("like", true);
              break;
            }
          }
        } else {
          await ctrl.sleep(1500);
        }
      }
      return true;
    }
    async function execute(kind, item) {
      const token = reservation(item, kind);
      if (counts[kind] >= limits[kind] || handled(item, kind) || inFlight.has(token)) return false;
      // Preparation is reversible; persist deduplication only at a possible-submit boundary.
      inFlight.add(token);
      try { return await perform(kind, item); }
      finally { inFlight.delete(token); }
    }
    return {
      counts, limits, maintainPage, maybeNotifications,
      async maybeInteract(allowed = ["like", "comment", "share", "join"]) {
        if (Date.now() < nextAttempt || !ctrl.canAct(null, null, true)) return false;
        const options = allowed.filter(kind => counts[kind] < limits[kind])
          .map(kind => {
            const items = candidates(kind);
            if (!items.length && ["like", "comment", "share"].includes(kind) && !ctrl.stats.issues?.[kind]) {
              ctrl.noteInteractionIssue(scanIssues[kind] || "没有可用目标：入口不可见、帖子已处理或未识别", kind);
            }
            return {kind, items};
          }).filter(option => option.items.length);
        if (!options.length) {
          nextAttempt = Date.now() + random(5000, 10000);
          const articles = [...document.querySelectorAll('[role="article"]')];
          const unknownLike = allowed.includes("like") && articles.some(scope => actionButtons(scope, "like")
            .some(node => !liked(node) && !unliked(node)));
          const reason = !articles.length && !reels ? "未识别到帖子容器，页面布局可能不兼容" :
            unknownLike ? "图标点赞按钮缺少已赞／未赞状态，需核对外层按钮 HTML" :
            !articles.some(scope => buttons(scope).some(node => allowed.some(kind => isAction(node, kind)))) && !reels ?
              "未找到可见的互动按钮，请核对页面按钮文字或位置" : "没有符合条件的互动目标：可能已互动、缺少帖子标识或达到限额";
          ctrl.noteInteractionIssue(reason);
          return false;
        }
        nextAttempt = Date.now() + (home ? random(25000, 35000) : random(60000, 100000));
        let choice;
        if (home) {
          for (let offset = 0; offset < homePlan.length; offset++) {
            const index = (planIndex + offset) % homePlan.length;
            choice = options.find(option => option.kind === homePlan[index]);
            if (choice) { planIndex = (index + 1) % homePlan.length; break; }
          }
        }
        choice ||= options[Math.floor(Math.random() * options.length)];
        const item = choice.items[Math.floor(Math.random() * choice.items.length)];
        try {
          const before = ctrl.stats.attempted[choice.kind];
          const confirmedBefore = ctrl.stats.confirmed[choice.kind];
          const result = await execute(choice.kind, item);
          if (choice.kind !== "join" && ctrl.stats.attempted[choice.kind] === before) {
            if (!ctrl.stats.issues?.[choice.kind]) ctrl.noteInteractionIssue("互动未提交：编辑器、分享入口或页面状态不符合条件", choice.kind);
          } else if (["comment", "share"].includes(choice.kind) && ctrl.stats.confirmed[choice.kind] === confirmedBefore && !ctrl.stats.issues?.[choice.kind]) {
            ctrl.noteInteractionIssue("提交未确认，本次不重发", choice.kind);
          }
          return result;
        }
        catch (error) { if (error.name === "AbortError") throw error;
          ctrl.noteInteractionIssue(error.name === "InteractionPaused" ? ctrl.detail : "互动中断：" + error.message, choice.kind); return false; }
        finally { ctrl.interactionScopes.clear(); safeCleanup(); }
      }
    };
  };
})();

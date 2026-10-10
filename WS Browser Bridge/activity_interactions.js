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
    const limits = {like: 2, comment: 1, share: 1, join: 1};
    const seenNodes = new WeakSet();
    const reels = window.__fbActivityRequest?.mode === "reels";
    let nextAttempt = Date.now() + random(45000, 75000);
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
      return waitFor(() => overlays().find(node => !previous.has(node)),
        () => overlays().find(node => !previous.has(node)) || null);
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
        scope = overlays().find(node => !previous.has(node)) || item.scope;
        return [...scope.querySelectorAll(selector)].find(visible);
      }, () => scope);
      if (!editor || (editor.value || editor.innerText || "").trim()) return;
      check(scope);
      editor.focus();
      await ctrl.sleep(random(1500, 3000));
      check(scope, editor);
      const value = comments[Math.floor(Math.random() * comments.length)];
      if (typeof document.execCommand !== "function" || !document.execCommand("insertText", false, value)) return;
      await ctrl.sleep(random(1500, 3000));
      check(scope, editor);
      if ((editor.value || editor.innerText || "").trim() !== value) return;
      editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
      editor.dispatchEvent(new KeyboardEvent("keyup", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true}));
      // A failed submission leaves its draft in place; never retry Enter blindly.
      await ctrl.sleep(2000);
      if (!(editor.value || editor.innerText || "").trim()) {
        check(scope, editor);
        if (document.activeElement === editor) editor.blur();
        if (scope !== item.scope) {
          const close = findButton(scope, /^(Close|关闭|關閉)$/i);
          if (close) await click(close, scope);
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
      if (kind === "comment") await comment(item);
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
      counts, limits,
      async maybeInteract(allowed = ["like", "comment", "share", "join"]) {
        if (Date.now() < nextAttempt || !ctrl.canAct(null, null, true)) return false;
        nextAttempt = Date.now() + random(90000, 150000);
        const options = allowed.filter(kind => counts[kind] < limits[kind])
          .map(kind => ({kind, items: candidates(kind)})).filter(option => option.items.length);
        if (!options.length) return false;
        const choice = options[Math.floor(Math.random() * options.length)];
        const item = choice.items[Math.floor(Math.random() * choice.items.length)];
        try { return await execute(choice.kind, item); }
        catch (error) { if (error.name === "AbortError") throw error; return false; }
      }
    };
  };
})();

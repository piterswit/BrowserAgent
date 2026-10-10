(() => {
  const version = 6;
  if (window.__fbActivityRuntime?.version === version) return;
  const request = window.__fbActivityRequest;
  window.__fbActivityRuntime?.stop();
  window.__fbActivityRequest = request;
  const abort = () => Object.assign(new Error("Activity stopped"), {name: "AbortError"});
  const visible = node => {
    if (!node || node.isConnected === false) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (parent.hidden || parent.inert || parent.getAttribute?.("aria-hidden") === "true") return false;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
            (style.opacity !== undefined && style.opacity !== "" && Number(style.opacity) === 0)) return false;
      }
    }
    if (!node.getBoundingClientRect) return true;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
      (rect.right === undefined || (rect.right > 0 && rect.left < innerWidth));
  };
  const runtime = {
    version, visible,
    stop() {
      window.__fbActivityRequest = null;
      window.__fbActivityCtrl?.stop();
    },
    create(mode) {
      const request = window.__fbActivityRequest;
      if (!request || request.mode !== mode) return null;
      if (window.__fbActivityCtrl?.runId === request.runId) return null;
      window.__fbActivityCtrl?.stop();
      const pending = new Map();
      const listeners = [];
      const dismissals = new WeakMap();
      const path = location.pathname;
      const ctrl = {
        run: true, started: false, runId: request.runId, mode, lastInput: 0, state: "启动中", detail: "",
        stats: JSON.parse(JSON.stringify(request.stats || {attempted: {like: 0, comment: 0, share: 0}, confirmed: {like: 0, comment: 0, share: 0}})),
        snapshotStats() { return JSON.parse(JSON.stringify(this.stats)); },
        noteInteractionIssue(reason) {
          if (!this.run || this.stats.issue === reason) return;
          this.stats.issue = reason;
          try {
            chrome.runtime.sendMessage({cmd: "fb_bridge_activity_stats", runId: this.runId, stats: this.snapshotStats()})?.catch(() => {});
          } catch {}
        },
        recordInteraction(kind, confirmed = false) {
          if (!this.run || !["like", "comment", "share"].includes(kind)) return;
          const values = this.stats[confirmed ? "confirmed" : "attempted"];
          values[kind]++;
          this.stats.issue = "";
          try {
            chrome.runtime.sendMessage({cmd: "fb_bridge_activity_stats", runId: this.runId, stats: this.snapshotStats()})?.catch(() => {});
          } catch {}
        },
        guard() { if (!this.run) throw abort(); },
        report(detail, error = false) {
          if (this.detail === detail) return;
          this.detail = detail;
          this.state = error ? "执行失败" : detail.startsWith("暂停") ? "暂停" : "运行中";
          if (error) window.__fbActivityLastError = detail;
          try {
            chrome.runtime.sendMessage({cmd: "fb_bridge_activity_detail", runId: this.runId, detail, error})?.catch(() => {});
          } catch {}
        },
        sleep(ms) {
          this.guard();
          return new Promise((resolve, reject) => {
            const id = setTimeout(() => { pending.delete(id); resolve(); }, ms);
            pending.set(id, reject);
          });
        },
        dismissOverlays(scope = null) {
          const popupSelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"], dialog[open]';
          const label = node => [node.getAttribute?.("aria-label"), node.innerText].filter(Boolean)
            .map(value => value.replace(/\s+/g, " ").trim());
          const closeWords = /^(Close|Close (dialog|window|popup|menu)|Dismiss|Cancel|Not now|Maybe later|Close chat|Close conversation|Close chat window|Close chat with .+|关闭|关闭(窗口|弹窗|对话框|聊天|聊天窗口|对话)|关闭与.+的聊天|取消|暂不|稍后再说|以后再说|關閉|關閉(視窗|視窗對話方塊|對話方塊|彈窗|聊天室|聊天視窗|對話)|關閉與.+的聊天室|暫不|稍後再說|稍後再試|以後再說)$/i;
          const securityWords = /log\s?in|sign\s?in|security check|captcha|verification code|two.factor|confirm your identity|checkpoint|登录|登入|验证码|驗證碼|身份验证|身分驗證|安全检查|安全檢查/i;
          let blocked = "", closing = false;
          for (const popup of new Set(document.querySelectorAll(popupSelector))) {
            if (!visible(popup)) { dismissals.delete(popup); continue; }
            if (popup === this.playerScope || popup === scope || scope?.contains(popup) || popup.contains?.(scope)) continue;
            if (popup.getAttribute?.("role") === "menu" && typeof getComputedStyle === "function") {
              let floating = false;
              for (let parent = popup; parent && parent !== document.body; parent = parent.parentElement) {
                if (/absolute|fixed/.test(getComputedStyle(parent).position)) { floating = true; break; }
              }
              if (!floating) continue;
            }
            const fields = [...(popup.querySelectorAll?.('input, textarea, [contenteditable="true"]') || [])];
            if (fields.some(node => node.type === "password") || label(popup).some(value => securityWords.test(value))) {
              blocked = "暂停：登录或安全验证弹框需要人工处理"; continue;
            }
            if (fields.some(node => node.files?.length || !["hidden", "button", "submit", "checkbox", "radio"].includes(node.type) &&
                (node.value || node.innerText || "").trim())) {
              blocked = "暂停：弹框有未提交内容，请人工处理"; continue;
            }
            const attempt = dismissals.get(popup) || {count: 0, at: -Infinity};
            if (attempt.count >= 3) { blocked = "暂停：弹框自动关闭失败，请人工关闭"; continue; }
            if (Date.now() - attempt.at < 1500) { closing = true; continue; }
            const close = [...(popup.querySelectorAll?.('[role="button"], button, [role="menuitem"]') || [])]
              .find(node => visible(node) && !node.disabled && node.getAttribute?.("aria-disabled") !== "true" &&
                label(node).some(value => closeWords.test(value)) &&
                (!node.closest || node.closest(popupSelector) === popup));
            if (!close && (!popup.dispatchEvent || typeof KeyboardEvent !== "function")) {
              blocked = "暂停：可见弹窗没有可识别的关闭入口"; continue;
            }
            dismissals.set(popup, {count: attempt.count + 1, at: Date.now()});
            try {
              this.guard();
              if (close) close.click();
              else {
                // Escape dismisses a popup without choosing a business action in it.
                const target = popup.contains?.(document.activeElement) ? document.activeElement : popup;
                for (const type of ["keydown", "keyup"]) {
                  this.guard();
                  target.dispatchEvent(new KeyboardEvent(type, {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true}));
                }
              }
            } catch (error) { if (error.name === "AbortError") throw error; }
            if (visible(popup)) closing = true;
            else { dismissals.delete(popup); this.report("已关闭页面弹框，继续浏览"); }
          }
          return {blocked, closing};
        },
        canAct(scope = null, editor = null, interacting = false) {
          if (!this.run) return false;
          const sameViewer = mode === "reels" && /^\/reels?(\/|$)/.test(location.pathname);
          if (location.pathname !== path && !sameViewer) { this.stop(true); return false; }
          const focused = document.activeElement;
          let reason = "";
          if (document.hidden) reason = "暂停：目标标签页不在前台";
          else if (Date.now() - this.lastInput < 10000) reason = "暂停：等待用户操作结束";
          else {
            const result = this.dismissOverlays(scope);
            if (result.blocked) reason = result.blocked;
            else if (result.closing) { this.report("正在关闭页面弹框，随后继续浏览"); return false; }
            else if (focused?.matches('input, textarea, [contenteditable="true"]') && focused !== editor && visible(focused) &&
              (interacting || focused.isContentEditable || (focused.value || focused.innerText || "").trim())) reason = "暂停：用户正在输入";
          }
          if (reason) { this.report(reason); this.noteInteractionIssue(reason); }
          else if (this.state === "暂停") this.report("正在浏览");
          return !reason;
        },
        scrollTarget() {
          const scrolling = node => node && node.scrollHeight > node.clientHeight + 24 &&
            /auto|scroll|overlay/.test(getComputedStyle(node).overflowY);
          if (typeof getComputedStyle !== "function") return window;
          const main = document.querySelector('[role="main"], main');
          const excluded = node => node?.closest?.('[role="dialog"], [role="menu"], [role="complementary"]');
          for (const x of [0.5, 0.7]) {
            let node = document.elementFromPoint(innerWidth * x, innerHeight * 0.6);
            if (excluded(node) || main && !main.contains(node)) continue;
            while (node && node !== document.body && node !== document.documentElement) {
              if (scrolling(node)) return node;
              node = node.parentElement;
            }
          }
          const root = document.scrollingElement;
          if (root && root.scrollHeight > root.clientHeight + 24 &&
              !/hidden|clip/.test(getComputedStyle(root).overflowY) &&
              !/hidden|clip/.test(getComputedStyle(document.body).overflowY)) return window;
          if (scrolling(main)) return main;
          for (const node of main?.querySelectorAll("*") || []) if (!excluded(node) && visible(node) && scrolling(node)) return node;
          return window;
        },
        async scroll(element, amount, axis = "y", steps = 20) {
          if (element === window && axis === "y") element = this.scrollTarget();
          this.report("正在浏览");
          const position = () => element === window ? (axis === "x" ? window.scrollX : window.scrollY) :
            (axis === "x" ? element.scrollLeft : element.scrollTop);
          const start = position();
          const frameDelay = Math.floor(20 + Math.random() * 20);
          let previous = 0;
          for (let i = 0; i < steps; i++) {
            this.guard();
            if (!this.canAct()) return;
            const progress = (i + 1) / steps;
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
            element.scrollBy({[axis === "x" ? "left" : "top"]: amount * (eased - previous), behavior: "instant"});
            previous = eased;
            await this.sleep(frameDelay);
          }
          if (Number.isFinite(start) && Math.abs(position() - start) < 1) {
            this.report("等待页面加载更多内容：滚动位置未变化");
          }
        },
        stop(notify = false) {
          if (!this.run) return;
          window.__fbActivityLastSnapshot = {runId: this.runId, stats: this.snapshotStats()};
          this.run = false;
          for (const [id, reject] of pending) { clearTimeout(id); reject(abort()); }
          pending.clear();
          clearTimeout(this.expiration);
          for (const [name, listener] of listeners) window.removeEventListener(name, listener, true);
          if (window.__fbActivityCtrl === this) {
            window.__fbActivityCtrl = null;
            if (window.__fbActivityRequest?.runId === this.runId) window.__fbActivityRequest = null;
            window.__hsCtrl = null;
            window.__reelCtrl = null;
          }
          if (notify) {
            try {
              chrome.runtime.sendMessage({cmd: "fb_bridge_active_stopped", runId: this.runId,
                stats: this.snapshotStats(),
                error: this.state === "执行失败" ? this.detail : null})?.catch(() => {});
            } catch {}
          }
        }
      };
      for (const name of ["pointerdown", "wheel", "keydown", "touchstart"]) {
        const listener = event => { if (event.isTrusted) ctrl.lastInput = Date.now(); };
        window.addEventListener(name, listener, {capture: true, passive: true});
        listeners.push([name, listener]);
      }
      if (mode !== "reels") ctrl.expiration = setTimeout(() => ctrl.stop(true), 5 * 60 * 1000);
      window.__fbActivityCtrl = ctrl;
      window[mode === "reels" ? "__reelCtrl" : "__hsCtrl"] = ctrl;
      // Reels must identify its player dialog before generic popup handling starts.
      if (mode !== "reels") ctrl.canAct();
      return ctrl;
    }
  };
  window.__fbActivityRuntime = runtime;
})();

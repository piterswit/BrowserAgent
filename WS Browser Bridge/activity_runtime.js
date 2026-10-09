(() => {
  const version = 3;
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
      const path = location.pathname;
      const ctrl = {
        run: true, started: false, runId: request.runId, mode, lastInput: 0, state: "启动中", detail: "",
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
        canAct(scope = null, editor = null, interacting = false) {
          if (!this.run) return false;
          const sameViewer = mode === "reels" && /^\/reels?(\/|$)/.test(location.pathname);
          if (location.pathname !== path && !sameViewer) { this.stop(true); return false; }
          const focused = document.activeElement;
          let reason = "";
          if (document.hidden) reason = "暂停：目标标签页不在前台";
          else if (Date.now() - this.lastInput < 10000) reason = "暂停：等待用户操作结束";
          else if (focused?.matches('input, textarea, [contenteditable="true"]') && focused !== editor && visible(focused) &&
            (interacting || focused.isContentEditable || (focused.value || focused.innerText || "").trim())) reason = "暂停：用户正在输入";
          else if ([...document.querySelectorAll('[role="dialog"], [role="menu"]')]
            .some(node => {
              if (!visible(node) || node === this.playerScope || node === scope || scope?.contains(node)) return false;
              // A permanent navigation list can also use role=menu; it is not a popup.
              if (node.getAttribute?.("role") === "menu" && typeof getComputedStyle === "function") {
                for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
                  if (/absolute|fixed/.test(getComputedStyle(parent).position)) return true;
                }
                return false;
              }
              return true;
            })) reason = "暂停：页面存在可见弹窗或菜单";
          if (reason) this.report(reason);
          else if (this.state === "暂停") this.report("正在浏览");
          return !reason;
        },
        scrollTarget() {
          const scrolling = node => node && node.scrollHeight > node.clientHeight + 24 &&
            /auto|scroll|overlay/.test(getComputedStyle(node).overflowY);
          if (typeof getComputedStyle !== "function") return window;
          for (const x of [0.5, 0.7]) {
            let node = document.elementFromPoint(innerWidth * x, innerHeight * 0.6);
            while (node && node !== document.body && node !== document.documentElement) {
              if (scrolling(node)) return node;
              node = node.parentElement;
            }
          }
          const root = document.scrollingElement;
          if (root && root.scrollHeight > root.clientHeight + 24 &&
              !/hidden|clip/.test(getComputedStyle(root).overflowY) &&
              !/hidden|clip/.test(getComputedStyle(document.body).overflowY)) return window;
          const main = document.querySelector('[role="main"]');
          if (scrolling(main)) return main;
          for (const node of main?.querySelectorAll("*") || []) if (visible(node) && scrolling(node)) return node;
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
      ctrl.canAct();
      return ctrl;
    }
  };
  window.__fbActivityRuntime = runtime;
})();

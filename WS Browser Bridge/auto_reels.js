(() => {
  const ctrl = window.__fbActivityRuntime?.create("reels");
  if (!ctrl) return;
  const random = (min, max) => min + Math.random() * (max - min);
  let lastBackwards = false;
  const labels = {
    next: /^(Next( reel| video)?|Go to next (reel|video)|下一(个|個|部|段|条|條|則|则)?(短视频|短影片|视频|影片|Reel|Reels)?|下一个视频|下一個影片)$/i,
    previous: /^(Previous( reel| video)?|Go to previous (reel|video)|上一(个|個|部|段|条|條|則|则)?(短视频|短影片|视频|影片|Reel|Reels)?|上一个视频|上一個影片)$/i
  };
  const visible = node => {
    if (!node?.isConnected || node.disabled || node.getAttribute("aria-disabled") === "true") return false;
    if (!window.__fbActivityRuntime.visible(node)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight &&
      rect.right > 0 && rect.left < innerWidth;
  };
  function viewer() {
    const videos = [...document.querySelectorAll("video")].filter(visible);
    videos.sort((a, b) => {
      const area = node => { const r = node.getBoundingClientRect();
        return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
          Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); };
      return area(b) - area(a);
    });
    const video = videos[0];
    const root = video?.closest('[role="dialog"], [role="main"]') || document.querySelector('[role="main"]') || document;
    const controls = [...root.querySelectorAll('[role="button"], button')].filter(visible);
    const find = direction => controls.find(node => labels[direction].test(
      (node.getAttribute("aria-label") || node.getAttribute("title") || node.innerText || "").replace(/\s+/g, " ").trim()));
    const next = find("next"), previous = find("previous");
    ctrl.playerScope = root.getAttribute?.("role") === "dialog" && video ? root : null;
    return {video, next, previous};
  }
  async function turn() {
    const current = viewer();
    if (!ctrl.canAct()) return;
    const backwards = !lastBackwards && Math.random() < 0.06;
    lastBackwards = backwards;
    const button = backwards ? current.previous || current.next : current.next;
    if (button) {
      await ctrl.sleep(random(200, 500));
      ctrl.guard();
      if (ctrl.canAct() && visible(button)) {
        button.click();
        ctrl.report("正在浏览 Reels");
      }
      return;
    }
    let element = current.video || document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (element) {
      const style = getComputedStyle(element);
      const horizontal = element.scrollWidth > element.clientWidth + 100 && /auto|scroll/.test(style.overflowX);
      const vertical = element.scrollHeight > element.clientHeight + 100 && /auto|scroll/.test(style.overflowY);
      if (horizontal || vertical) {
        const axis = horizontal ? "x" : "y";
        const size = horizontal ? element.clientWidth : element.clientHeight;
        const rtl = horizontal && style.direction === "rtl" ? -1 : 1;
        // One full viewport also works with mandatory CSS scroll snapping.
        await ctrl.scroll(element, size * (backwards ? -1 : 1) * rtl, axis, 1);
        return;
      }
      element = element.parentElement;
    }
    await ctrl.scroll(window, innerHeight * 0.9 * (backwards ? -1 : 1));
  }
  function watchingDelay() {
    const video = viewer().video;
    const kind = Math.random();
    if (kind < 0.2) return random(1500, 3000);
    if (kind > 0.97) return random(8000, 12000);
    const remaining = video && Number.isFinite(video.duration) && Number.isFinite(video.currentTime) ?
      Math.max(0, video.duration - video.currentTime) : 0;
    return remaining > 0 ? Math.max(3000, Math.min(8000, remaining * random(0.12, 0.25) * 1000)) : random(3000, 6000);
  }
  (async () => {
    const interactions = window.__fbActivityInteractions(ctrl);
    ctrl.started = true;
    let first = true;
    while (ctrl.run) {
      await ctrl.sleep(first ? random(1000, 2000) : watchingDelay());
      first = false;
      ctrl.guard();
      viewer();
      if (!ctrl.canAct()) continue;
      try { await interactions.maybeInteract(["like"]); }
      catch (error) { if (error.name === "AbortError") throw error; }
      ctrl.guard();
      if (!ctrl.canAct()) continue;
      await turn();
    }
  })().catch(error => {
    if (error.name !== "AbortError") {
      ctrl.report("Reels 翻页失败：" + error.message, true);
      ctrl.stop(true);
    }
  });
})();

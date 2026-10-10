(() => {
  const mode = window.__fbActivityRequest?.mode;
  if (!["home", "group", "custom"].includes(mode)) return;
  const ctrl = window.__fbActivityRuntime?.create(mode);
  if (!ctrl) return;
  const random = (min, max) => min + Math.random() * (max - min);
  function readingDelay() {
    const article = [...document.querySelectorAll('[role="article"]')]
      .find(window.__fbActivityRuntime.visible);
    const text = (article?.innerText || "").slice(0, 3000);
    const characters = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const words = text.replace(/[\u3400-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
    const reading = Math.min(2500, (characters / 30 + words / 10) * 1000);
    const kind = Math.random();
    if (kind < 0.2) return random(800, 1600);
    return Math.min(9000, random(1500, 3500) + reading + (kind > 0.95 ? random(3000, 5000) : 0));
  }
  function scrollPlan() {
    const target = ctrl.scrollTarget();
    const height = target === window ? innerHeight : target.clientHeight || innerHeight;
    const position = target === window ? window.scrollY : target.scrollTop;
    const total = target === window ? document.scrollingElement?.scrollHeight : target.scrollHeight;
    const atEnd = Number.isFinite(position) && total > height && position + height >= total - 8;
    const kind = Math.random();
    let distance = height * (kind < 0.2 ? random(0.15, 0.35) : kind > 0.85 ? random(0.75, 0.95) : random(0.4, 0.75));
    if (position > 0 && (atEnd || kind > 0.93)) distance = -height * random(0.12, 0.25);
    return {target, distance, steps: Math.floor(random(10, 20))};
  }
  (async () => {
    const interactions = window.__fbActivityInteractions(ctrl);
    ctrl.started = true;
    let first = true;
    while (ctrl.run) {
      await ctrl.sleep(first ? 1200 : readingDelay());
      first = false;
      ctrl.guard();
      interactions.maintainPage();
      if (!ctrl.canAct()) continue;
      if (await interactions.maybeNotifications()) continue;
      try { await interactions.maybeInteract(); }
      catch (error) { if (error.name === "AbortError") throw error; }
      ctrl.guard();
      if (!ctrl.canAct()) continue;
      const plan = scrollPlan();
      await ctrl.scroll(plan.target, plan.distance, "y", plan.steps);
    }
  })().catch(error => {
    if (error.name !== "AbortError") {
      ctrl.report("滚动失败：" + error.message, true);
      ctrl.stop(true);
    }
  });
})();

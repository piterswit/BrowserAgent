// ===== 通用工具 =====
var sleep = ms => new Promise(r=>setTimeout(r,ms));
var rand = (a, b) => Math.random() * (b - a) + a;

var isVisible = el=>{
  const r = el.getBoundingClientRect();
  return r.width>0 &&
         r.height>0 &&
         r.bottom>0 &&
         r.top < window.innerHeight*0.85;
};

// ===== 模拟按键输入，带随机延时 =====
async function pressKeyRandomPause(el,key,min=80,max=280){
  const keyCodeMap={
    Escape:27,
    Enter:13,
    Tab:9,
    ArrowUp:38,
    ArrowDown:40,
    ArrowLeft:37,
    ArrowRight:39
  };

  const kc=keyCodeMap[key]||0;

  el.dispatchEvent(new KeyboardEvent("keydown",{
    key,
    code:key,
    keyCode:kc,
    which:kc,
    bubbles:true
  }));

  await sleep(rand(min,max));

  el.dispatchEvent(new KeyboardEvent("keyup",{
    key,
    code:key,
    keyCode:kc,
    which:kc,
    bubbles:true
  }));
}

// ===== 模拟人类点击 =====
function humanClick(el){
  el.click();
  // const r = el.getBoundingClientRect();
  // const x = r.left + r.width/2;
  // const y = r.top + r.height/2;

  // const opts = {
  //   view: window,
  //   bubbles: true,
  //   cancelable: true,
  //   clientX: x,
  //   clientY: y
  // };

  // el.dispatchEvent(new PointerEvent("pointerdown", opts));
  // el.dispatchEvent(new MouseEvent("mousedown", opts));
  // el.dispatchEvent(new PointerEvent("pointerup", opts));
  // el.dispatchEvent(new MouseEvent("mouseup", opts));
  // el.dispatchEvent(new MouseEvent("click", opts));
}


async function waitFor(sel,timeout=4000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    const n=document.querySelectorAll(sel);
    if(n.length) return n;
    await sleep(250);
  }
  return null;
}

// ===== 分享到快拍（无语言依赖）=====
async function shareToStory(){
  console.log('准备分享至即时动态...');
  // 找分享按钮
  const shareBtns = [...document.querySelectorAll('[data-ad-rendering-role="share_button"]')]
    .map(n => n.closest('[role="button"]'))
    .filter(b => b && isVisible(b));

  if(!shareBtns.length) return false;

  const btn = shareBtns[0];

  await sleep(rand(600,1400));
  humanClick(btn);
  await sleep(rand(1600,3200));

  // 找菜单里所有 role="button" 的 div
  const buttons = document.querySelectorAll('[role="button"]');

  const keywords = ['限時動態','快拍','Share to your story'];

  for (let btn of buttons) {
    const text = btn.innerText.trim();
    if (keywords.some(kw => text.includes(kw))) {
      await sleep(rand(200,400));
      humanClick(btn);
      console.log('已点击即时动态按钮:', text);
      return true;
    }
  }

  console.log('未找到即时动态按钮');
  return false;
}

// ===== 点击“感兴趣”按钮（无语言依赖）=====
async function clickInterestedCard(){
  console.log("点击感兴趣卡片...");
  // 多语言支持
  const keywords = ['兴趣', '興趣', 'Interested'];

  // 找所有 role="button" 元素
  const buttons = [...document.querySelectorAll('[role="button"]')].filter(isVisible);

  for (const btn of buttons) {
    // 1️⃣ aria-label
    const label = btn.getAttribute('aria-label') || '';
    if (keywords.some(kw => label.includes(kw))) {
      humanClick(btn);
      console.log('点击了有兴趣按钮 (aria-label)');
      return true;
    }

    // 2️⃣ 内部文本
    const text = (btn.innerText || '').trim();
    if (keywords.some(kw => text.includes(kw))) {
      humanClick(btn);
      console.log('点击了有兴趣按钮 (text)');
      return true;
    }
  }

  console.log('未找到有兴趣按钮');
  return false;
}

// ===== 点赞 =====
async function doLike(){
  console.log("准备点赞...");
    const nodes=[
    ...document.querySelectorAll(
      '[data-ad-rendering-role="like_button"]'
    )
  ];

  const visible=nodes
    .map(n=>n.closest('[role="button"]'))
    .filter(b=>b && isVisible(b));

  if(!visible.length) return;

  const btn=
    visible[Math.floor(Math.random()*visible.length)];

  await sleep(rand(800,2000));
  humanClick(btn);
  console.log("已点赞");
}

// ===== 评论 =====
async function doComment(){
  console.log("准备评论...");
  const btns = [
    ...document.querySelectorAll('[data-ad-rendering-role="comment_button"]')
  ]
  .map(n=>n.closest('[role="button"]'))
  .filter(b=>b && isVisible(b));

  if(!btns.length) return false;

  const btn = btns[Math.floor(Math.random()*btns.length)];

  await sleep(rand(800,2200));
  humanClick(btn);
  await sleep(rand(1200,2500));

  // 找输入框
  const box = await waitFor('div[contenteditable="true"][role="textbox"]', 5000);
  if(!box || !box.length) return false;
  const input = box[0];

  // 聚焦
  input.focus();

  // 插入文本（FB推荐方式）
  const text = comments[Math.floor(Math.random()*comments.length)];
  document.execCommand(
    "insertText",
    false,
    text
  );

  await sleep(rand(1300,2600));

  // 模拟发送
  await pressKeyRandomPause(input,"Enter");
  console.log("已评论:", text);
  await sleep(rand(1300,2600));

  // 关闭评论框（找 X 号按钮）
  const btns2=[
    ...document.querySelectorAll('div[role="button"]')
  ];

  for(const b of btns2){
    if(!isVisible(b)) continue;

    // 找带 X 图标的按钮
    if(b.querySelector('svg path[d^="M19.884"]')){
      humanClick(b);
      return true;
    }
  }

  // 找不到关闭按钮就按 Esc 吧
  await pressKeyRandomPause(input,"Escape");
  return false;
}

// ===== Notifications =====
async function openNotificationsAndScroll() {
    console.log("打开通知窗口...");
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (min, max) =>
        Math.floor(Math.random() * (max - min + 1)) + min;

    function isVisible(el) {
        if (!el) return false;

        const r = el.getBoundingClientRect();

        return (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.right > 0 &&
            r.top < window.innerHeight &&
            r.left < window.innerWidth
        );
    }

    function findNotificationButton() {
        const keywords = [
            '通知',
            'Notifications',
            'Notification'
        ];

        // 优先 aria-label
        const byLabel = [...document.querySelectorAll('[role="button"]')]
            .find(el => {
                const label = el.getAttribute('aria-label') || '';
                return keywords.some(k => label.startsWith(k));
            });

        if (byLabel && isVisible(byLabel)) {
            return byLabel;
        }

        // 备用：铃铛 SVG
        const buttons = document.querySelectorAll(
            'div[role="button"][aria-haspopup="dialog"]'
        );

        for (const btn of buttons) {
            if (!isVisible(btn)) continue;

            const path = btn.querySelector('svg path');
            if (!path) continue;

            const d = path.getAttribute('d') || '';

            if (
                d.includes('M3 9.5a9 9') &&
                d.includes('18 0') &&
                d.includes('4.5')
            ) {
                return btn;
            }
        }

        return null;
    }

    function findScrollableContainer() {
        const dialogs = [
            ...document.querySelectorAll('[role="dialog"][aria-label]')
        ].filter(el => {
            const label = el.getAttribute('aria-label') || '';
            return /notification/i.test(label) || label.includes('通知');
        });

        for (const dialog of dialogs) {
            const nodes = dialog.querySelectorAll('*');

            for (const el of nodes) {
                const style = getComputedStyle(el);

                if (
                    el.scrollHeight > el.clientHeight + 100 &&
                    style.overflowY !== 'hidden' &&
                    (style.overflowY === 'auto' || style.overflowY === 'scroll')
                ) {
                    return el;
                }
            }
        }

        return null;
    }

    // 点击通知按钮
    const btn = findNotificationButton();

    if (!btn) {
        console.log('未找到通知按钮');
        return false;
    }

    btn.click();

    await sleep(rand(3500, 5500));

    // 找通知面板滚动区域
    const container = findScrollableContainer();

    if (!container) {
        console.log('未找到通知滚动区域');
        return true;
    }

    // 随机滑动 2~6 次
    const count = rand(2, 6);

    for (let i = 0; i < count; i++) {

        const distance = rand(250, 600);

        container.scrollBy({
            top: distance,
            behavior: 'smooth'
        });

        await sleep(rand(1000, 2500));

        // 10%概率往回滑一点
        if (Math.random() < 0.1) {
            container.scrollBy({
                top: -rand(100, 400),
                behavior: 'smooth'
            });

            await sleep(rand(800, 1800));
        }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    console.log(`通知面板已浏览 ${count} 次`);
    return true;
}

// ===== 加入小组 =====
async function clickJoinButton() {
  console.log("点击加入小组...");
  const keywords = ["加入", "Join"];

  const buttons = [...document.querySelectorAll('[role="button"]')];

  for (const btn of buttons) {
    if (!isVisible(btn)) continue;

    const text =
      (btn.innerText || "").trim() ||
      (btn.getAttribute("aria-label") || "").trim();

    if (keywords.some(k => text.includes(k))) {
      humanClick(btn);
      console.log("已点击加入按钮:", text);
      return true;
    }
  }

  console.log("未找到加入按钮");
  return false;
}

// ===== 清理界面上的弹窗 =====
async function doClear(){
  const keywords = ["离开页面","離開頁面","退出頁面","Leave", "關閉", "关闭",
    "關閉聊天室",
    "关闭聊天",
    "關閉聊天",
    "Close chat",
    "Close"
  ];
  const btns = [...document.querySelectorAll('[role="button"]')];

  for(const b of btns){
    if(!isVisible(b)) continue;

    const label = b.getAttribute("aria-label") || "";
    const text  = (b.innerText||"").trim();

    if(keywords.some(k=>label.includes(k)||text.includes(k))){
      humanClick(b);
      await sleep(rand(800,1600));
    }
  }
}

// ===== 随机互动 =====
async function randomInteract(){
  await doClear();  //清理弹窗

  if(Math.random()>0.618)
    return;

  if(Math.random()<0.1) {
    await clickInterestedCard(); // 点击感兴趣卡片
    await clickJoinButton(); // 点击加入小组按钮
  }
  if(Math.random()<0.05) {
    await openNotificationsAndScroll();  // 点开通知窗口
  }
  if(Math.random()<0.05) {
    await doLike();
    await sleep(rand(2500, 8000)); // 点赞后停顿
  }
  if(Math.random()<0.05) {
    await shareToStory();
    await sleep(rand(2500, 8000)); // 分享后停顿
  }
  if(Math.random()<0.05) {
    await doComment();
    await sleep(rand(2500, 8000)); // 评论后停顿
  }
}


function humanLikeScroll() {

  // 强制停止旧实例
  if (window.__hsCtrl) {
    window.__hsCtrl.run = false;
    if (window.__hsCtrl.timer) {
      clearTimeout(window.__hsCtrl.timer);
    }
  }

  const ctrl = {
    run: true,
    timer: null,
    start_time: Date.now(),
    scroll_count: 0,
    stop_count: rand(30, 100),
    stop() {
      this.run = false;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      delete window.__hsCtrl;
    }
  };

  window.__hsCtrl = ctrl;

  // 5-15分钟后停止活跃
  const stopAfter = rand(
    5 * 60 * 1000,
    15 * 60 * 1000
  );
  setTimeout(() => {
    chrome.runtime.sendMessage({
      cmd: "fb_bridge_active_stopped"
    });
    location.reload();
  }, stopAfter);

  function smooth(dy, done) {
    const startY = window.scrollY;
    const target = startY + dy;
    const dur = rand(200, 1400);
    const t0 = performance.now();

    function f(t) {
      if (!ctrl.run) return;

      const p = Math.min((t - t0) / dur, 1);
      const e = p < 0.5
        ? 2 * p * p
        : 1 - Math.pow(-2 * p + 2, 2) / 2;

      window.scrollTo(0, startY + (target - startY) * e);

      if (p < 1 && ctrl.run) {
        requestAnimationFrame(f);
      } else if (ctrl.run) {
        done && done();
      }
    }

    requestAnimationFrame(f);
  }
  async function maybeInteract(){
    if (Math.random() < 0.16) {
      await randomInteract();
    }
  }

  function loop() {
    if (!ctrl.run) return;
    if (document.hidden) {
      ctrl.timer = setTimeout(loop, 4000);
      return;
    }

    const h = document.documentElement.scrollHeight;
    const y = window.scrollY + window.innerHeight;
    const atBottom = y >= h - 5;

    let dy = rand(80, 800);

    if (Math.random() < 0.05) dy *= -1;
    if (atBottom) dy = -rand(300, 900);

    smooth(dy, async () => {
      if (!ctrl.run) return;

      await sleep(rand(800, 1400));
      await maybeInteract();

      const delay = Math.random() < 0.1 ? rand(3000, 10000) : rand(300, 2500);

      ctrl.scroll_count += 1;
      if (ctrl.scroll_count >= ctrl.stop_count) {
        // 每滚动几十次，长停一下
        await sleep(rand(5000, 25000));
        ctrl.scroll_count = 0;
        ctrl.stop_count = rand(30, 100);
      }
      ctrl.timer = setTimeout(loop, delay);
    });
  }

  loop();
  return ctrl;
}

var comments = [
  "Nice 🙂", "👍", "Great post!", "Love this", "Awesome", "🔥", "So cool",
  "Well said", "Interesting!", "Agree 👍", "Great shot!", "Looks good!", "Well done!",
  "Love it 😍", "Cool 😎", "Amazing work", "Nicely done", "Good vibes ✨", "Really nice",
  "Smart point", "True!", "Makes sense", "Good one 👍", "Haha nice", "Beautiful",
  "Solid post", "Respect ✌️", "Brilliant", "Not bad 🙂", "Very cool", "Impressive",
  "Clean 👌", "Quality content", "This is great", "Big fan of this", "On point 🎯",
  "Exactly!", "Couldn’t agree more", "Love the idea", "Creative!", "Nice share",
  "Appreciate this", "Good energy", "Super nice", "Fresh take", "Cool post",
  "That’s cool", "Great vibe", "Love the vibe", "Neat 👍"
];


async function run(){
  // await doLike()
  // await doComment();
  // await shareToStory();
  // await clickInterestedCard();
  await doClear();
  console.log("done");
}

// run();

humanLikeScroll()

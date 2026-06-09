// ===== 基础工具 =====
function rand(a,b){return Math.floor(Math.random()*(b-a+1))+a;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function isVisible(el){
  if(!el) return false;
  const r = el.getBoundingClientRect();
  return r.width>0 && r.height>0 && r.bottom>0 && r.top < innerHeight;
}

function humanClick(el){
  const r = el.getBoundingClientRect();
  const x = r.left + r.width/2;
  const y = r.top + r.height/2;
  const o = {bubbles:true,cancelable:true,clientX:x,clientY:y,view:window};

  el.dispatchEvent(new PointerEvent("pointerdown",o));
  el.dispatchEvent(new MouseEvent("mousedown",o));
  el.dispatchEvent(new PointerEvent("pointerup",o));
  el.dispatchEvent(new MouseEvent("mouseup",o));
  el.dispatchEvent(new MouseEvent("click",o));
}

function keyNav(key){
  document.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true}));
  document.dispatchEvent(new KeyboardEvent("keyup",{key,bubbles:true}));
}


// ===== 点击取消静音按钮 =====
function clickIfUnmute() {
  const keywords = [
    "取消静音",   // 简体
    "取消靜音",   // 繁体
    "unmute"      // 英文
  ];

  const buttons = document.querySelectorAll('[role="button"]');

  for (const btn of buttons) {
    const text = (
      btn.getAttribute("aria-label") ||
      btn.innerText ||
      ""
    ).trim().toLowerCase();

    if (
      keywords.some(k =>
        text.includes(k.toLowerCase())
      )
    ) {
      btn.click();
      console.log("已点击:", text);
      return true;
    }
  }

  console.log("未找到匹配按钮");
  return false;
}


// ===== reels 导航 =====
// 找到真正可滚动容器
let __scroller = null;

function getScroller(){
  if(__scroller && __scroller.isConnected) return __scroller;

  const root = document.scrollingElement || document.documentElement;
  if(root.scrollHeight > root.clientHeight){
    __scroller = root;
    return __scroller;
  }

  let el = document.elementFromPoint(innerWidth/2, innerHeight/2);
  while(el && el !== document.body){
    const s = getComputedStyle(el);
    if((s.overflowY === "auto" || s.overflowY === "scroll") &&
       el.scrollHeight > el.clientHeight){
      __scroller = el;
      return __scroller;
    }
    el = el.parentElement;
  }

  __scroller = root;
  return __scroller;
}

function smoothScroll(dy){
  getScroller().scrollBy({top:dy,behavior:"smooth"});
}

function nextReel(){
  const k = 0.7 + Math.random()*0.6; // 0.7 ~ 1.3
  smoothScroll(innerHeight * k);
}

function prevReel(){
  const k = 0.7 + Math.random()*0.6;
  smoothScroll(-innerHeight * k);
}


// ===== 随机交互 =====
function doLike(){
  console.log('尝试点赞当前 Reels...');
  const btn = [...document.querySelectorAll('[role="button"]')]
    .find(el=>{
      const t = (el.getAttribute("aria-label")||"").toLowerCase();
      return /(讚好|赞好|赞|讚|like)/.test(t);
    });

  if(btn){
    btn.click();
    return true;
  }
  return false;
}


// ===== 主循环 =====
async function autoReels(){
  if(window.__reelCtrl){
    window.__reelCtrl.run=false;
  }

  const ctrl={run:true};
  window.__reelCtrl=ctrl;

  // 等待加载，并点击取消静音
  await sleep(rand(3000,6180));
  clickIfUnmute();

  console.log('开始自动浏览 Reels...');
  while(ctrl.run){
    if(document.hidden){
      await sleep(2000);
      continue;
    }

    if(Math.random()<0.618)
        await sleep(rand(2000,6180));
    else
        await sleep(rand(2000,15000));
    // await maybeLike();

    if(Math.random()<0.03){
      location.reload();
      return;
    }

    if(Math.random()<0.04){
      prevReel();
    }else{
      nextReel();
    }

    if(Math.random()<0.04)
      await doLike();
    if(Math.random()<0.04)
      await sleep(rand(8000,45000));
  }
}

autoReels();
// clickLike();

// bg.js

let ws=null;
const clientId = crypto.randomUUID();

const PORTS=[
  8765,8766,8767,8768,8769
];

let avatarBusy = false;

function avatarResult(success, error = "") {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({type: "avatar_result", client_id: clientId, success, error}));
  }
}

async function avatarStep(tabId, step) {
  const results = await chrome.scripting.executeScript({
    target: {tabId},
    func: async name => {
      try {
        if (!window.__fbAvatar) throw new Error("头像脚本未加载");
        return {value: await window.__fbAvatar[name]()};
      } catch (error) {
        return {error: error.message};
      }
    },
    args: [step]
  });
  const result = results[0]?.result;
  if (!result || result.error) throw new Error(result?.error || "头像页面已关闭或跳转");
  return result.value;
}

async function navigateAvatarTab(tabId) {
  let listener;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      listener = (id, info) => {
        if (id === tabId && info.status === "complete") resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
      timer = setTimeout(() => reject(new Error("个人主页加载超时")), 45000);
      chrome.tabs.update(tabId, {url: "https://www.facebook.com/me", active: true}).catch(reject);
    });
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    if (url.hostname !== "www.facebook.com" || /\/login|\/checkpoint/.test(url.pathname)) {
      throw new Error("请先登录 Facebook 并完成账号验证");
    }
  } finally {
    clearTimeout(timer);
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
  }
}

async function runAvatarChange(filePath) {
  if (avatarBusy) return;
  avatarBusy = true;
  let target;
  let attached = false;
  let chooserListener;
  let chooserTimer;
  try {
    if (typeof filePath !== "string" || !/^(?:[a-z]:[\\/]|\\\\)/i.test(filePath) || !/\.(jpg|jpeg|png|webp)$/i.test(filePath)) {
      throw new Error("头像图片路径无效");
    }
    const tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    let tab = tabs.find(t => /^https:\/\/(?:[^/]+\.)?facebook\.com\//i.test(t.url || ""));
    if (!tab) {
      const facebookTabs = await chrome.tabs.query({url: "https://*.facebook.com/*"});
      tab = facebookTabs[0];
    }
    if (!tab) throw new Error("请先打开已登录的 Facebook 页面");
    target = {tabId: tab.id};
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({type: "status", status: "change_avatar", client_id: clientId}));
    }
    await navigateAvatarTab(tab.id);
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.scripting.executeScript({target, files: ["change_avatar.js"]});
    const mode = await avatarStep(tab.id, "prepare");
    if (mode === "input") {
      const {root} = await chrome.debugger.sendCommand(target, "DOM.getDocument", {depth: -1, pierce: true});
      const {nodeId} = await chrome.debugger.sendCommand(target, "DOM.querySelector", {nodeId: root.nodeId, selector: 'input[data-fb-avatar-upload="true"]'});
      if (!nodeId) throw new Error("头像上传控件已失效");
      await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {nodeId, files: [filePath]});
    } else {
      await chrome.debugger.sendCommand(target, "Page.enable");
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", {enabled: true});
      const point = await avatarStep(tab.id, "upload");
      const chooser = new Promise((resolve, reject) => {
        chooserListener = (source, method, params) => {
          if (source.tabId === tab.id && method === "Page.fileChooserOpened") resolve(params);
        };
        chrome.debugger.onEvent.addListener(chooserListener);
        chooserTimer = setTimeout(() => reject(new Error("等待头像文件选择器超时")), 30000);
      });
      const click = async () => {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {type: "mousePressed", ...point, button: "left", clickCount: 1});
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {type: "mouseReleased", ...point, button: "left", clickCount: 1});
      };
      // Observe both promises immediately so click failures cannot leak rejections.
      const [params] = await Promise.all([chooser, click()]);
      if (!params.backendNodeId) throw new Error("无法获取头像上传控件");
      await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {backendNodeId: params.backendNodeId, files: [filePath]});
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", {enabled: false});
    }
    await avatarStep(tab.id, "save");
    avatarResult(true);
  } catch (error) {
    avatarResult(false, error.message || String(error));
  } finally {
    clearTimeout(chooserTimer);
    if (chooserListener) chrome.debugger.onEvent.removeListener(chooserListener);
    if (attached) {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", {enabled: false}).catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
    avatarBusy = false;
  }
}

async function open_url(url) {
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});

  await chrome.tabs.update(tab.id, {
    url: url,
    active: true
  });
  return tab;
}

function openAndInject(url, file){
  chrome.tabs.query({active:true,currentWindow:true}, ([tab])=>{
    if(!tab) return;

    chrome.tabs.update(tab.id,{url}, (updatedTab)=>{
      const listener = (tabId, info)=>{
        if(tabId === updatedTab.id && info.status === "complete"){
          chrome.tabs.onUpdated.removeListener(listener);

          chrome.scripting.executeScript({
            target:{tabId:updatedTab.id},
            files:[file]
          });
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function openAndGetFBName() {
  const tab = await open_url("https://www.facebook.com/");

  // 等页面加载
  await new Promise(resolve => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // 等FB动态渲染
  await new Promise(r => setTimeout(r, 3000));

  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {

      // ✅ 方案1：从个人主页链接拿（最稳、跨语言）
      const profileLink = document.querySelector(
        'a[aria-label][href*="facebook.com"]'
      );

      if (profileLink) {
        const label = profileLink.getAttribute("aria-label");

        if (label) {
          return label
            .split("'s")[0]
            .split("的")[0]
            .split("の")[0]
            .split("님의")[0]
            .trim();
        }
      }

      // ✅ 方案2：meta标签
      const meta = document.querySelector(
        'meta[property="og:title"]'
      );

      if (meta && meta.content) {
        return meta.content
          .replace(/\s*\|\s*Facebook.*/i, "")
          .trim();
      }

      // ✅ 方案3：h1
      const h1 = document.querySelector("h1");
      if (h1) return h1.innerText.trim();

      return null;
    }
  });

  return res?.[0]?.result || null;
}

function connect(i=0){
  if(ws && ws.readyState===WebSocket.OPEN){
    return;
  }
  if(ws){
    if(ws.readyState === WebSocket.CONNECTING){
      return;
    }
    try{ ws.close(); }catch{}
    ws = null;
  }

  if(i>=PORTS.length){
    return;
  }

  try {
    ws=new WebSocket(`ws://127.0.0.1:${PORTS[i]}`);
  } catch(e){
    setTimeout(()=>connect(i+1),1000);
    return;
  }

  ws.onopen=()=>{
    openAndGetFBName().then(name=>{
      ws.send(JSON.stringify({
        type: "init",
        client_id:clientId,
        fb_name: name
      }));
    }).catch(()=>{});
  };

  ws.onmessage=e=>{
    const msg=JSON.parse(e.data);

    if(msg.action==="open"){
      chrome.tabs.create({url:msg.url});
    }

    if(msg.action==="scroll"){
      chrome.tabs.query({active:true,currentWindow:true},tabs=>{
        if(!tabs.length) return;
        chrome.scripting.executeScript({
          target:{tabId:tabs[0].id},
          func:dy=>window.scrollBy({top:dy,behavior:"smooth"}),
          args:[msg.dy]
        });
      });
    }
    if (msg.action === "scroll30") {
      ws.send(JSON.stringify({type:"status", status:"auto_main_page", client_id:clientId}));
      chrome.tabs.query({active:true,currentWindow:true},tabs=>{
        if(!tabs.length) return;
        chrome.scripting.executeScript({
          target:{tabId:tabs[0].id},
          files:["tools.js"]
        });
      });
    }
    if (msg.action === "auto_reels") {
      ws.send(JSON.stringify({type:"status", status:"auto_reels", client_id:clientId}));
      openAndInject("https://www.facebook.com/reel/", "auto_reels.js");
    }
    if (msg.action === "auto_group") {
      ws.send(JSON.stringify({type:"status", status:"auto_group", client_id:clientId}));
      openAndInject("https://www.facebook.com/groups/feed/", "tools.js");
    }
    if (msg.action === "cancel_friend_requests") {
      ws.send(JSON.stringify({type:"status", status:"cancel_friend_requests", client_id:clientId}));
      openAndInject("https://www.facebook.com/friends/requests", "cancel_friend_requests.js");
    }

    if (msg.action === "stop_scroll") {
      ws.send(JSON.stringify({type:"status", status:"stop", client_id:clientId}));
      chrome.tabs.query({active:true,currentWindow:true},tabs=>{
        if(!tabs.length) return;
        chrome.scripting.executeScript({
          target:{tabId:tabs[0].id},
          func: (url)=>{
            window.location.href = url;
          },
          args:["https://www.facebook.com/"]
        });
      });
    }

    if (msg.action === "change_avatar") {
      runAvatarChange(msg.file_path);
    }

  };

  ws.onclose=()=>{
    // 停止页面滚动
    chrome.tabs.query({},tabs=>{
      for(const t of tabs){
        chrome.scripting.executeScript({
          target:{tabId:t.id},
          func:()=>{
            if(window.__hsCtrl){
              window.__hsCtrl.stop();
            }
          }
        }).catch(()=>{});
      }
    });

    // 清理连接
    ws=null;
  };

  ws.onerror=()=>{
    try{ws.close()}catch{}
    ws=null;
  };
}

connect();

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.cmd==="connect_py"){
    connect();
  }
  else if(msg.cmd==="auto_active"){
    chrome.tabs.query({active:true,currentWindow:true},tabs=>{
      if(!tabs.length) return;

      chrome.scripting.executeScript({
        target:{tabId:tabs[0].id},
        files:["tools.js"]
      });
    });
  }
  else if(msg.cmd==="auto_reels"){
    openAndInject("https://www.facebook.com/reel/", "auto_reels.js");
  }
  else if(msg.cmd==="auto_group"){
    openAndInject("https://www.facebook.com/groups/feed/", "tools.js");
  }
  else if(msg.cmd==="fb_bridge_active_stopped"){
    if(ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify({type:"status", status:"stop", client_id:clientId}));
    }
  }
  else if(msg.cmd==="cancel_friend_requests"){
    openAndInject("https://www.facebook.com/friends/requests", "cancel_friend_requests.js");
  }
});


// 监听URL参数自动触发
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;

  try {
    const url = new URL(tab.url);
    //只要带参数 fb_bridge_auto_extension，就执行，https://example.com/?fb_bridge_auto_extension
    if (url.searchParams.has("fb_bridge_auto_extension")) {
      // 自动滚动
      setTimeout(() => {
        chrome.scripting.executeScript({
          target: { tabId },
          files: ["tools.js"]
        });
      }, 3000);
    }
    //https://www.facebook.com/?fb_bridge_connect_extension
    if (tab.url.includes("facebook.com") && url.searchParams.has("fb_bridge_connect_extension")) {
      connect();
    }
    if (tab.url.includes("facebook.com")) {
      // 每次访问facebook都尝试连接一次（如果未连接）
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
      }
    }
  } catch(e){}
});


// 连接心跳
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "heartbeat",
      client_id: clientId
    }));
  }
}, 15000);


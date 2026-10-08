// bg.js

let ws=null;
const clientId = crypto.randomUUID();

const PORTS=[
  8765,8766,8767,8768,8769
];

let avatarBusy = false;
const taskTabs = new Set();

async function createProfileTab(path = "/me") {
  const windows = await chrome.windows.getAll({windowTypes: ["normal"]});
  const window = windows.find(item => item.focused) || windows[0];
  if (!window) throw new Error("浏览器窗口已关闭");
  const tab = await chrome.tabs.create({url: "about:blank", active: false, windowId: window.id});
  taskTabs.add(tab.id);
  try {
    await navigateAvatarTab(tab.id, path);
    return tab;
  } catch (error) {
    await closeTaskTab(tab.id);
    throw error;
  }
}

async function closeTaskTab(tabId) {
  if (taskTabs.delete(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
}

async function readProfileIdentity(tabId) {
  const injection = {
    target: {tabId},
    world: "MAIN",
    func: async () => {
      const deadline = Date.now() + 15000;
      let partial = null;
      const cleanName = text => (typeof text === "string" ? text : "").replace(/^\(\d+\)\s*/, "")
        .replace(/\s*[|\-]\s*Facebook.*$/i, "").trim();
      const validName = text => text && !/^(notifications?|facebook|home|menu|settings|your profile|通知|通知消息|首頁|首页|菜单|選單|设置|設定|个人主页|個人檔案)$/i.test(text);
      const normalizeUser = user => {
        if (!user || typeof user !== "object") return null;
        const id = String(user.USER_ID || user.ACCOUNT_ID || "");
        const name = cleanName(user.NAME);
        return /^[1-9]\d+$/.test(id) || validName(name) ? {id: /^[1-9]\d+$/.test(id) ? id : null, name: validName(name) ? name : null, picture: user.PROFILE_PICTURE_URI || null} : null;
      };
      const currentUser = () => {
        try {
          if (typeof window.require === "function") {
            const user = normalizeUser(window.require("CurrentUserInitialData"));
            if (user) return user;
          }
        } catch {}
        // Facebook also serializes account modules inside structured script data.
        for (const script of document.querySelectorAll('script[type="application/json"], script[data-sjs]')) {
          if (!script.textContent || script.textContent.length > 2000000) continue;
          try {
            const pending = [JSON.parse(script.textContent)];
            for (let visited = 0; pending.length && visited < 20000; visited++) {
              const value = pending.pop();
              if (!value || typeof value !== "object") continue;
              if (Array.isArray(value) && value[0] === "CurrentUserInitialData") {
                const user = normalizeUser(value[2]);
                if (user) return user;
              }
              for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
            }
          } catch {}
        }
        return null;
      };
      while (Date.now() < deadline) {
        const current = new URL(location.href);
        if (!/(^|\.)facebook\.com$/.test(current.hostname) || /\/(login|checkpoint)(\/|\.php|$)/.test(current.pathname)) {
          return {error: "请先登录 Facebook 并完成账号验证"};
        }
        const user = currentUser();
        const canonical = document.querySelector('link[rel="canonical"]')?.href;
        const profile = new URL(canonical || current.href, current.href);
        const home = /^\/(me)?\/?$/.test(current.pathname);
        const excluded = /^(me|profile\.php|login(?:\.php)?|checkpoint|notifications|friends|groups|reel|reels|watch|marketplace|settings|bookmarks|gaming|help)$/i;
        const ownLink = home ? [...document.querySelectorAll('a[aria-label][href]')].find(link => {
          const navigation = link.closest('[role="navigation"], [role="banner"]');
          if (!navigation && (link.closest('[role="main"], main, [role="dialog"]') || !link.querySelector('img, svg image'))) return false;
          try {
            const url = new URL(link.href, current.href);
            const part = url.pathname.replace(/^\/|\/$/g, "");
            const label = cleanName(link.getAttribute("aria-label"));
            return /(^|\.)facebook\.com$/.test(url.hostname) &&
              (url.pathname === "/profile.php" && /^[1-9]\d+$/.test(url.searchParams.get("id") || "") || part && !part.includes("/") && !excluded.test(part)) &&
              (validName(label) || user?.id && url.searchParams.get("id") === user.id || /^(your profile|你的个人主页|你的個人檔案)$/i.test(label));
          } catch { return false; }
        }) : null;
        const linked = ownLink ? new URL(ownLink.href, current.href) : null;
        const numeric = profile.searchParams.get("id") || (/^\/\d+\/?$/.test(profile.pathname) ? profile.pathname.replace(/\//g, "") : null);
        const deepLink = [...document.querySelectorAll('meta[property="al:ios:url"], meta[property="al:android:url"]')]
          .map(meta => meta.content.match(/^fb:\/\/profile\/(\d+)/)?.[1]).find(Boolean);
        const viewedId = /^[1-9]\d+$/.test(numeric || "") ? numeric : deepLink;
        if (user?.id && viewedId && user.id !== viewedId) return {error: "个人主页与当前登录账号不一致，请重新连接"};
        const fbId = /^[1-9]\d+$/.test(numeric || "") ? numeric : deepLink || user?.id || linked?.searchParams.get("id") || null;
        const usernameURL = linked || profile;
        const slug = usernameURL.pathname.replace(/^\/|\/$/g, "");
        const username = slug && !slug.includes("/") && !excluded.test(slug) && !/^\d+$/.test(slug) ? decodeURIComponent(slug) : null;
        const headings = [...document.querySelectorAll('[role="main"] h1, main h1, h1')]
          .filter(el => !el.closest('[role="navigation"], [role="banner"], [role="dialog"]'))
          .sort((a, b) => Number(!!b.closest('[role="main"], main')) - Number(!!a.closest('[role="main"], main')))
          .map(el => cleanName(el.innerText));
        const linkedName = cleanName(ownLink?.getAttribute("aria-label")).replace(/(?:'s|’s)\s+profile.*$/i, "").replace(/的(?:个人主页|個人檔案|头像|大頭貼).*$/, "");
        const name = [user?.name, cleanName(document.querySelector('meta[property="og:title"]')?.content), linkedName, ...headings, cleanName(document.title)]
          .find(validName);
        if ((name || fbId || username) && /(^|\.)facebook\.com$/.test(profile.hostname)) {
          const profileUrl = fbId ? `https://www.facebook.com/profile.php?id=${fbId}` : username ? `https://www.facebook.com/${encodeURIComponent(username)}` : null;
          const pictures = [...document.querySelectorAll('[role="main"] img, main img, [role="main"] svg image, main svg image')]
            .filter(el => {
              if (el.closest('[role="dialog"]')) return false;
              const parent = el.closest('a, [role="button"]');
              const description = [el.getAttribute("alt"), el.getAttribute("aria-label"), parent?.getAttribute("aria-label")].filter(Boolean).join(" ");
              const rect = el.getBoundingClientRect();
              return rect.width >= 64 && rect.height >= 64 &&
                (name && description.toLowerCase().includes(name.toLowerCase()) || /profile picture|头像|大頭貼/i.test(description));
            }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          const picture = pictures[0];
          const linkPicture = ownLink?.querySelector('img, svg image');
          const accountMenu = document.querySelector('[aria-label="Your profile"], [aria-label="你的个人主页"], [aria-label="你的头像"], [aria-label="您的个人主页"], [aria-label="你的個人檔案"], [aria-label="你的大頭貼"]');
          const menuPicture = accountMenu?.querySelector('img, svg image');
          const avatarUrl = user?.picture || picture?.currentSrc || picture?.src || picture?.getAttribute("href") || picture?.getAttribute("xlink:href") || linkPicture?.currentSrc || linkPicture?.src || linkPicture?.getAttribute("href") || linkPicture?.getAttribute("xlink:href") || menuPicture?.currentSrc || menuPicture?.src || menuPicture?.getAttribute("href") || menuPicture?.getAttribute("xlink:href") || document.querySelector('meta[property="og:image"]')?.content || null;
          partial = {fb_name: name || null, fb_id: fbId, fb_username: username, profile_url: profileUrl, avatar_url: avatarUrl};
          if (name && (fbId || username)) return partial;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (partial) return {...partial, identity_error: partial.fb_name ? "已识别名字，未读取到主页 ID" : "已识别 ID，未读取到账号名字"};
      return {error: `未能识别账号，页面路径: ${location.pathname || new URL(location.href).pathname}；标题: ${document.title || "无"}`};
    }
  };
  let results;
  try {
    results = await chrome.scripting.executeScript(injection);
  } catch {
    results = await chrome.scripting.executeScript({...injection, world: "ISOLATED"});
  }
  const identity = results[0]?.result;
  if (!identity || identity.error) throw new Error(identity?.error || "识别页面已关闭");
  return identity;
}

async function loadAvatarThumbnail(url) {
  if (!url) return null;
  let bitmap;
  try {
    const source = new URL(url);
    if (source.protocol !== "https:" || !/(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(source.hostname)) return null;
    const response = await fetch(source.href, {credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(8000)});
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 5 * 1024 * 1024) return null;
    bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(36, 36);
    const context = canvas.getContext("2d");
    context.beginPath();
    context.arc(18, 18, 18, 0, Math.PI * 2);
    context.clip();
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 36, 36);
    const thumbnail = await canvas.convertToBlob({type: "image/png"});
    const bytes = new Uint8Array(await thumbnail.arrayBuffer());
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function getFBIdentity() {
  const tab = await createProfileTab("/");
  try {
    let identity;
    let profileError;
    try {
      identity = await readProfileIdentity(tab.id);
    } catch (error) {
      profileError = error;
    }
    if (!identity || !identity.fb_name || !identity.profile_url || !identity.avatar_url) {
      try {
        await navigateAvatarTab(tab.id, "/me");
        const home = await readProfileIdentity(tab.id);
        if (identity?.fb_id && home.fb_id && identity.fb_id !== home.fb_id) throw new Error("识别过程中登录账号发生变化，请重新连接");
        identity = {
          ...home,
          ...identity,
          fb_name: identity?.fb_name || home.fb_name,
          fb_id: identity?.fb_id || home.fb_id,
          fb_username: identity?.fb_username || home.fb_username,
          profile_url: identity?.profile_url || home.profile_url,
          avatar_url: identity?.avatar_url || home.avatar_url
        };
        if (identity.fb_name && identity.profile_url) delete identity.identity_error;
      } catch (error) {
        if (!identity) throw new Error(`首页识别失败: ${profileError?.message || "无信息"}；个人主页识别失败: ${error.message}`);
        if (identity.identity_error) identity.identity_error += `；个人主页补充读取失败: ${error.message}`;
      }
    }
    identity.avatar_data = await loadAvatarThumbnail(identity.avatar_url);
    return identity;
  } finally {
    await closeTaskTab(tab.id);
  }
}

async function verifyAvatarAccount(tabId, expectedProfile) {
  const identity = await readProfileIdentity(tabId);
  if (identity.profile_url !== expectedProfile) throw new Error("当前登录账号或任务页面已变化，请重新连接账号");
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

async function navigateAvatarTab(tabId, path = "/me") {
  let listener;
  let removedListener;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      listener = (id, info, tab) => {
        if (id === tabId && info.status === "complete" && /^https:\/\/(?:[a-z0-9-]+\.)?facebook\.com\//i.test(tab?.url || "")) resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
      removedListener = id => {
        if (id === tabId) reject(new Error("任务标签页已被关闭"));
      };
      chrome.tabs.onRemoved.addListener(removedListener);
      timer = setTimeout(() => reject(new Error("个人主页加载超时")), 45000);
      chrome.tabs.update(tabId, {url: `https://www.facebook.com${path}`, active: false}).catch(reject);
    });
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url);
    if (!/(^|\.)facebook\.com$/.test(url.hostname) || /\/login|\/checkpoint/.test(url.pathname)) {
      throw new Error("请先登录 Facebook 并完成账号验证");
    }
  } finally {
    clearTimeout(timer);
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    if (removedListener) chrome.tabs.onRemoved.removeListener(removedListener);
  }
}

async function runAvatarChange(filePath, expectedProfile) {
  if (avatarBusy) return;
  avatarBusy = true;
  let target;
  let attached = false;
  let chooserListener;
  let chooserTimer;
  const operationSocket = ws;
  const report = (success, error = "", confirmed = true, avatarData = null) => {
    if (operationSocket?.readyState === WebSocket.OPEN) {
      operationSocket.send(JSON.stringify({type: "avatar_result", client_id: clientId, success, error, confirmed, avatar_data: avatarData}));
    }
  };
  try {
    if (typeof filePath !== "string" || !/^(?:[a-z]:[\\/]|\\\\)/i.test(filePath) || !/\.(jpg|jpeg|png|webp)$/i.test(filePath)) {
      throw new Error("头像图片路径无效");
    }
    if (!expectedProfile || !/^https:\/\/www\.facebook\.com\//.test(expectedProfile)) throw new Error("账号尚未识别，请重新连接插件");
    const tab = await createProfileTab();
    target = {tabId: tab.id};
    const checkAccount = async () => {
      if (ws !== operationSocket || operationSocket?.readyState !== WebSocket.OPEN) throw new Error("本地连接已断开，请检查头像后重试");
      await verifyAvatarAccount(tab.id, expectedProfile);
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({type: "status", status: "change_avatar", client_id: clientId}));
    }
    await checkAccount();
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.scripting.executeScript({target, files: ["change_avatar.js"]});
    const mode = await avatarStep(tab.id, "prepare");
    await checkAccount();
    if (mode === "input") {
      const {root} = await chrome.debugger.sendCommand(target, "DOM.getDocument", {depth: 1, pierce: true});
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
    await checkAccount();
    const saved = await avatarStep(tab.id, "save");
    let avatarData = null;
    if (saved?.confirmed === true) {
      try {
        const identity = await readProfileIdentity(tab.id);
        avatarData = await loadAvatarThumbnail(identity.avatar_url);
      } catch {}
    }
    report(true, "", saved?.confirmed === true, avatarData);
  } catch (error) {
    report(false, error.message || String(error));
  } finally {
    clearTimeout(chooserTimer);
    if (chooserListener) chrome.debugger.onEvent.removeListener(chooserListener);
    if (attached) {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", {enabled: false}).catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
    }
    if (target) await closeTaskTab(target.tabId);
    avatarBusy = false;
  }
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

let identityPromise = null;
async function initializeAccount(socket) {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    try {
      const identity = await getFBIdentity();
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({type: "init", client_id: clientId, ...identity}));
      }
    } catch (error) {
      console.warn("FB account identification failed:", error.message);
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({type: "init", client_id: clientId, fb_name: "未识别账号", identity_error: error.message}));
      }
    } finally {
      identityPromise = null;
    }
  })();
  return identityPromise;
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

  const socket = ws;
  let opened = false;
  socket.onopen=()=>{
    opened = true;
    initializeAccount(socket);
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
      runAvatarChange(msg.file_path, msg.profile_url);
    }

  };

  ws.onclose=()=>{
    if (ws !== socket) return;
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
    if (!opened) setTimeout(() => connect(i + 1), 1000);
  };

  ws.onerror=()=>{
    try{socket.close()}catch{}
  };
}

connect();

chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll({windowTypes: ["normal"]});
  if (!windows.length && ws) {
    const socket = ws;
    socket.close(1000, "All browser windows closed");
  }
});

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.cmd==="connect_py"){
    if (ws?.readyState === WebSocket.OPEN && !avatarBusy) initializeAccount(ws);
    else connect();
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
  if (taskTabs.has(tabId)) return;

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


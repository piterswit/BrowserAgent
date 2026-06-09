// bg.js

let ws=null;
const clientId = crypto.randomUUID();

const PORTS=[
  8765,8766,8767,8768,8769
];

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


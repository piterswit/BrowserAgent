async function refreshConnectionStatus() {
  try {
    const state = await chrome.runtime.sendMessage({cmd: "connection_status"});
    document.getElementById("connection-status").textContent = state?.connected ? "已连接" : "未连接：请检查软件是否运行";
  } catch { document.getElementById("connection-status").textContent = "扩展需重新加载"; }
}
refreshConnectionStatus();
setInterval(refreshConnectionStatus, 1000);
document.getElementById("btn").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"connect_py"}).catch(()=>{});
};
document.getElementById("btn2").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_active"}).catch(()=>{});
};
document.getElementById("btn3").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_reels"}).catch(()=>{});
};

document.getElementById("btn4").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_group"}).catch(()=>{});
};

document.getElementById("btn5").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"cancel_friend_requests"}).catch(()=>{});
};
document.getElementById("btn6").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_custom"}).catch(()=>{});
};

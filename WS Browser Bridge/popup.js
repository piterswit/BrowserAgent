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

document.getElementById("btn").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"connect_py"});
};
document.getElementById("btn2").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_active"});
};
document.getElementById("btn3").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_reels"});
};

document.getElementById("btn4").onclick=()=>{
  chrome.runtime.sendMessage({cmd:"auto_group"});
};

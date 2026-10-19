(() => {
window.__fbCancelRequestsCtrl?.stop();
const pending = new Map();
const notices = new Set();
const taskPath = location.pathname;
const abort = () => Object.assign(new Error("取消好友请求任务已停止"), {name: "AbortError"});
const ctrl = {
    run: true,
    stop() {
        if (!this.run) return;
        this.run = false;
        for (const [id, reject] of pending) { clearTimeout(id); reject(abort()); }
        pending.clear();
        for (const node of notices) node.remove();
        notices.clear();
        if (window.__fbCancelRequestsCtrl === this) window.__fbCancelRequestsCtrl = null;
    }
};
window.__fbCancelRequestsCtrl = ctrl;
function guard() {
    if (location.pathname !== taskPath) ctrl.stop();
    if (!ctrl.run) throw abort();
}
const requestLabels = {
    cancel: /^(Cancel request|取消请求|取消好友请求|取消邀请|取消邀請|取消邀约|取消邀約|取消交友邀請|取消好友邀請)$/i,
    sent: /^(View sent requests|Sent requests|查看已发送请求|查看已发送的请求|查看发出的请求|已发送的请求|发出的请求|查看已傳送邀請|查看送出的邀請|查看已送出邀請|查看已送出的邀請|查看已發送的邀請|查看已發送的交友邀請|已傳送邀請|送出的邀請|已送出的邀請|已發送的邀請|已發送的交友邀請)$/i,
    blocked: /could(?:n['’]t| not) process|unable to process|please try again|try again later|temporarily blocked|无法处理|無法處理|请重试|请稍后再试|請重試|請再試一次|請稍後再試|暂时被封锁|暫時遭到封鎖|暫時被封鎖/i
};
const requestText = el => (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();

// ===== 基础工具 =====
function rand(a, b) {
    return Math.floor(Math.random() * (b - a + 1)) + a;
}

function sleep(ms) {
    guard();
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => { pending.delete(id); resolve(); }, ms);
        pending.set(id, reject);
    }).then(() => guard());
}

function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < window.innerHeight;
}

// 等待元素
async function waitFor(fn, timeout = 15000) {
    const t = Date.now();

    while (Date.now() - t < timeout) {
        guard();
        const ret = fn();
        if (ret) return ret;
        await sleep(300);
    }

    return null;
}

async function main() {
    let progressBox = null;
    function showProgress(text){
        if(!progressBox){
            progressBox = document.createElement("div");
            progressBox.style.cssText = `
                position:fixed;
                top:20px;
                left:50%;
                transform:translateX(-50%);
                z-index:999999;
                background:#1877f2;
                color:#fff;
                padding:10px 20px;
                border-radius:8px;
                font-size:14px;
                font-weight:bold;
                box-shadow:0 4px 12px rgba(0,0,0,.3);
            `;
            document.body.appendChild(progressBox);
            notices.add(progressBox);
        }

        progressBox.innerText = text;
    }
    function hideProgress(){
        if(progressBox){
            progressBox.remove();
            progressBox = null;
        }
    }

    // 漂亮的、不阻塞代码的动态通知气泡
    function showToast(message, bgColor = '#1877f2') {
        const toast = document.createElement('div');
        toast.innerText = message;
        toast.style.position = 'fixed';
        toast.style.top = '30px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.backgroundColor = bgColor;
        toast.style.color = 'white';
        toast.style.padding = '14px 28px';
        toast.style.borderRadius = '8px';
        toast.style.zIndex = '999999';
        toast.style.boxShadow = '0 6px 20px rgba(0,0,0,0.2)';
        toast.style.fontSize = '15px';
        toast.style.fontWeight = 'bold';
        toast.style.fontFamily = 'Segoe UI, Helvetica, Arial, sans-serif';
        toast.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        document.body.appendChild(toast);
        notices.add(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(-10px)';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    // 辅助函数：深度检测当前页面有没有弹出FB风控警告
    function checkFBBlockPopup() {
        return [...document.querySelectorAll('[role="dialog"], [role="alert"]')]
            .some(el => isVisible(el) && requestLabels.blocked.test(el.innerText || ""));
    }

    // 1. 获取页面上所有的弹窗
    let dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);

    // 【终极全语言定位逻辑】
    let modalContainer = dialogs.find(dialog => {
        return [...dialog.querySelectorAll('[role="heading"], h1, h2, [role="button"], button')]
            .some(el => requestLabels.sent.test(requestText(el)) || requestLabels.cancel.test(requestText(el)));
    });

    if (!modalContainer) {
        alert("❌ 未能找到好友请求弹窗！\n请确保弹窗已经点开并显示在屏幕中央，然后再点插件。");
        return;
    }

    if (checkFBBlockPopup()) return;

    // 精准抓取真正拥有滚动条的核心 DOM 元素
    let scrollElement = Array.from(modalContainer.querySelectorAll('div')).find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    }) || modalContainer;

    showToast("🚀 简繁体全通吃雷达版已启动！\n正在一路滚到底，期间会严密监控FB警告弹窗...", "#1877f2");
    console.log("%c========= 🚀 第一阶段：简繁体兼容·纯滚动长征 =========", "color: cyan; font-weight: bold;");

    let scrollCount = 0;
    let noChangeCount = 0;
    let lastScrollHeight = scrollElement.scrollHeight;

    // 纯滚动阶段
    const totalScroll = rand(20, 30);
    console.log(`开始 ${totalScroll} 次滚动`);
    for (let scrollCount = 1; scrollCount <= totalScroll; scrollCount++) {
        guard();
        scrollElement.scrollTop = scrollElement.scrollHeight;

        await sleep(3500);

        scrollElement.scrollTop -= 30;
        await sleep(150);
        scrollElement.scrollTop += 30;

        // 滚动期间也顺便检测一下有没有突发风控
        if (checkFBBlockPopup()) {
            showToast("🚨 滚动期间遭遇FB拦截，脚本紧急终止！", "#dc2626");
            alert("🚨 滚动加载失败！检测到页面已弹出FB官方限制警告。\n为了不加重处罚，脚本已自动断电停机！");
            return;
        }

        let currentHeight = scrollElement.scrollHeight;
        console.log(`[第 ${scrollCount} 次全力向下滚] 历史高度: ${lastScrollHeight} -> 最新高度: ${currentHeight}`);

        if (currentHeight === lastScrollHeight) {
            noChangeCount++;
            if (noChangeCount >= 5) {
                console.log("%c🎉 纯滚动长征结束！全员列表已全部拉取到浏览器内存中！", "color: green; font-weight: bold;");
                break;
            }
        } else {
            noChangeCount = 0;
            lastScrollHeight = currentHeight;
        }
    }
    console.log(`🎉 已完成 ${totalScroll} 次滚动！`);

    console.log("%c========= 🎯 第二阶段：终极收割批量取消 =========", "color: magenta; font-weight: bold;");

    let buttons = Array.from(modalContainer.querySelectorAll('div[role="button"], button')).filter(btn => {
        return isVisible(btn) && requestLabels.cancel.test(requestText(btn));
    });

    console.log(`%c统计：总共在页面上成功憋出了 ${buttons.length} 个可见的取消按钮！`, "color: #00ff00; font-weight: bold;");

    if (buttons.length === 0) {
        showToast("提示：未能在页面上找到任何有效的取消按钮。", "#eab308");
        return;
    }

    // 3. 开始排队执行点击
    let consecutiveFailures = 0;
    let successCount = 0;

    for (let i = buttons.length - 1; i >= 0; i--) {
        guard();
        let isSuccess = false;
        showProgress(`取消好友请求 ${buttons.length - i}/${buttons.length}`);
        try {
            buttons[i].click();
            console.log(`[总清缴进度: ${i + 1}/${buttons.length}] 已发送点击指令...`);

            // 给网页 UI 1.2秒的初步反应时间，用来渲染潜在的风控警告弹窗
            await sleep(1200);

            // 【天眼核心防御】：优先检查有没有冒出FB风控拦截弹窗
            if (checkFBBlockPopup()) {
                showToast("🚨 捕获到FB官方风控弹窗！紧急熔断！", "#dc2626");
                alert(`🚨 抓到你了！页面已弹出含有“无法处理/重试”的FB拦截警告。\n说明频率已经撞枪口了，脚本已瞬间为你断电熔断！\n本次运行安全取消了 ${successCount} 个请求。`);
                return; // 彻底退出脚本
            }

            // 若没有风控弹窗，再走常规的DOM变化检测
            const isStillInPage = document.body.contains(buttons[i]);
            const textAfterClick = isStillInPage ? requestText(buttons[i]) : "";

            if (isStillInPage && requestLabels.cancel.test(textAfterClick)) {
                console.warn(`⚠️ 第 ${i + 1} 个按钮点击后依然完好存在且文字未变。`);
                isSuccess = false;
            } else {
                isSuccess = true;
            }
        } catch (err) {
            if (err.name === "AbortError") throw err;
            console.error(`第 ${i + 1} 个按钮点击遭遇故障:`, err);
            isSuccess = false;
        }

        // 常规连续 2 次无响应熔断（作为后备屏障）
        if (isSuccess) {
            consecutiveFailures = 0;
            successCount++;
        } else {
            consecutiveFailures++;
            console.error(`❌ 警告：遭遇连续第 ${consecutiveFailures} 次状态未改变！`);
            if (consecutiveFailures >= 2) {
                showToast("🚨 连续2次无响应，安全熔断！", "#dc2626");
                alert(`🚨 紧急停止！检测到连续 2 次取消无响应。\n即使没跳弹窗，可能接口也已被静默限制。\n为了稳妥，脚本已自动执行熔断保护！\n本次运行成功取消了 ${successCount} 个请求。`);
                return;
            }
        }

        // 安全防封延迟：稳定在随机 2 ~ 3.5 秒
        const clickDelay = Math.floor(Math.random() * 1500) + 2000;
        await new Promise(resolve => setTimeout(resolve, clickDelay));
    }

    hideProgress();
    alert(`🏁 战役胜利！\n本次一口气自动帮你取消了 ${successCount} 个好友请求！`);

}

// ===== 主循环 =====
async function auto() {
    guard();

    // 进入好友请求页
    if (!location.pathname.startsWith("/friends/requests")) {
        location.href = "https://www.facebook.com/friends/requests";
        return;
    }

    // 等页面稳定
    await sleep(5000);

    // 找"查看已发送请求"
    const btn = await waitFor(() => {

        return [...document.querySelectorAll('[role="button"], button, a[href]')]
            .find(el => isVisible(el) && requestLabels.sent.test(requestText(el)));

    });

    if (!btn) {
        console.log("没找到按钮");
        return;
    }

    btn.click();

    console.log("打开弹框");

    await sleep(rand(3000,5000));

    await main();
}

return auto().catch(error => {
    if (error.name !== "AbortError") console.error("取消好友请求失败", error);
}).finally(() => ctrl.stop());
})();

# BrowserAgent

一个用于浏览器自动化操作的 Chrome 插件，主要用于模拟正常用户浏览行为，提高 Facebook 账号活跃度，包括首页动态浏览与 Reels 自动观看等功能。

---

# 功能特点

- 自动浏览 Facebook 首页动态
- 自动观看 Facebook Reels
- 模拟真人浏览行为
- 随机停留与滚动
- WebSocket 本地通信支持
- 后台自动运行
- 轻量化设计

---

# 支持功能

## Facebook 首页

- 自动滚动首页
- 随机浏览动态
- 模拟阅读停留
- 随机间隔操作
- 降低机械行为特征
- 随机点赞、转发快拍

---

## Facebook Reels

- 自动切换 Reels
- 随机观看时长
- 模拟真人观看
- 自动连续播放
- 随机停顿行为

---

# 项目结构

```text
BrowserAgent/
├── server.py
├── WS Browser Bridge/
│   ├── manifest.json
│   ├── bg.js
│   ├── popup.js
│   ├── popup.html
│   ├── offscreen.js
│   ├── offscreen.html
│   ├── auto_reels.js
│   └── tools.js
```

---

# 安装方法

## 1. 克隆仓库

```bash
git clone https://github.com/secure-artifacts/BrowserAgent.git
```

---

## 2. 加载插件

打开 Chrome 浏览器：

```text
chrome://extensions/
```

然后：

- 开启「开发者模式」
- 点击「加载已解压的扩展程序」
- 选择：

```text
浏览器插件
```

目录即可。

---

# 运行方法

## 批量更换头像

运行更新后的 `server.py`，在“头像目录”输入框填写本机目录，或点击“选择目录”。
在账号列表中选中一个或多个已连接账号，点击“换头像”。每个账号独立随机选择目录直接包含的一张 JPG、JPEG、PNG 或 WebP 图片，上传后自动保存；不同账号可能选到同一张图片，原文件不会被删除。

浏览器与本地软件需要运行在同一台电脑。更新扩展后需在 `chrome://extensions/` 重新加载；换头像时扩展会打开当前登录账号的个人主页并临时使用 `debugger`，请关闭该标签页的开发者工具。账号列表显示完成结果或失败原因。当前支持简体中文、繁体中文和英文按钮；Facebook 页面布局变化时可能需要调整 `change_avatar.js`。

现有 `server.exe` 不会随源码更新，需要重新打包才能包含此功能。

启动本地服务（批量控制）：

```
server.exe
```

浏览器链接：

```
连接本地服务：
https://www.facebook.com/?fb_bridge_connect_extension

自动活跃：
https://www.facebook.com/?fb_bridge_auto_extension
```





# 注意事项

- 本项目仅用于学习与研究浏览器自动化技术
- 请遵守相关平台规则
- 不建议高频率自动化操作
- 请合理控制运行频率

---

# License

MIT License



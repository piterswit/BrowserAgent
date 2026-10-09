# BrowserAgent

BrowserAgent 由 Windows 本地控制软件和 Chrome 扩展 **FB Browser Bridge** 组成。软件通过本机 WebSocket 连接浏览器，可对选中的 Facebook 账号执行首页浏览、Reels 浏览、小组浏览、取消已发送的好友请求和随机更换头像。

![插件图标](WS%20Browser%20Bridge/icon/bridge-128.png)

## 功能

| 功能 | 本地软件 | 扩展弹窗 | 执行行为 |
| --- | --- | --- | --- |
| 账号连接与识别 | 显示账号头像、名称、FB ID 或用户名、状态和结果 | 连接 | 新建临时后台个人主页，读取后关闭 |
| 首页活跃 | 首页活跃 | 自动活跃 | 在当前页面随机滚动、停留，并可能点赞、评论、分享快拍、查看通知或加入小组 |
| Reels 活跃 | Reels活跃 | 活跃 Reels | 打开 Reels，随机切换、停留，偶尔点赞 |
| 小组活跃 | 小组活跃 | 活跃小组 | 打开小组动态并运行浏览、互动脚本 |
| 停止活跃 | 停止活跃 | 无 | 将当前活动标签页导航到 Facebook 首页，结束该页面脚本 |
| 取消好友请求 | 取消好友请求 | 取消好友请求 | 打开已发送请求列表，逐个取消；遇到限制提示或连续失败停止 |
| 批量换头像 | 选择目录、换头像 | 无 | 每个账号随机选图，在独立后台页面上传并保存 |

首页和小组脚本约 5–10 分钟后刷新页面并结束。本项目的“活跃”包含实际互动，不只是浏览。首页、Reels 和小组脚本在页面隐藏时暂停浏览循环。

## 环境与安装

- 本地软件使用 Windows、Python 3.10 或以上版本；浏览器和软件运行在同一台电脑。
- 扩展要求 Chrome 118 或以上版本。其他 Chromium 浏览器需支持相同扩展 API。
- 多账号使用独立浏览器用户配置，每个配置加载扩展并登录对应账号。一个配置内的多个标签页共享登录状态，不能当作多个独立账号。

安装依赖并启动本地软件：

```powershell
python -m pip install -r requirements.txt
python server.py
```

浏览器打开 `chrome://extensions/`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择仓库中的 **WS Browser Bridge** 目录。

## 连接账号

1. 先启动本地软件，再在对应浏览器配置中登录 Facebook。
2. 点击扩展图标，再点击“连接”。也可以访问 `https://www.facebook.com/?fb_bridge_connect_extension`。
3. 扩展在新建的后台标签页打开 Facebook 首页，读取账号名称和个人主页标识；信息不完整时再访问 `/me` 补充，完成后关闭该标签页。不会导航用户原来的页面，也不会强行切回之前的标签页。
4. 本地列表显示已连接账号。识别失败时会显示原因；完成登录或验证后，再点击扩展的“连接”重新识别。

FB 数字 ID 优先从个人主页 URL 和公开页面元数据读取；页面没有提供数字 ID 时显示个人主页用户名。用户名与插件连接 ID 都不是 FB 数字 ID。列表按连接 ID 管理，账号同名不会覆盖。

账号优先从首页已登录账号模块、结构化数据和个人链接读取，再补充个人主页元数据与主体标题，排除 Notifications、通知等界面标题。首页缺少信息时，在同一个临时页尝试个人主页；已识别的 ID、名字和头像分别保留，缺少一个字段不会清空其他字段。读取失败的具体原因显示在执行结果列和本地日志中。

头像由扩展读取后缩小成 36px PNG，通过本机连接传给软件；读取失败时显示默认头像。账号列表行高为 48px，超出缩略图尺寸的图片会缩小。确认更换头像成功后会尝试刷新列表头像。本地界面使用与插件相同的图标，启动时居中显示。

本地软件监听 `127.0.0.1:8765–8769`。扩展按顺序尝试端口，每 15 秒发送心跳。连接关闭后软件立即清理账号；扩展关闭最后一个普通浏览器窗口时也会主动断开，以处理浏览器后台继续运行的情况。软件每 3 秒检查已关闭连接和心跳，心跳超过 60 秒时移除异常失联账号。本地软件重启后，可点击扩展“连接”重新连接。

## 批量操作

在账号列表中用 Ctrl 或 Shift 选择多个账号，再点击操作按钮。每个独立浏览器配置分别执行收到的命令。

首页、小组、Reels 和取消好友请求操作沿用当前活动标签页，可能改变该页内容。账号识别和换头像使用各自的临时后台页面。运行浏览互动时，应保留目标 Facebook 页面为活动页面。

访问 `https://www.facebook.com/?fb_bridge_auto_extension` 可直接启动首页活跃。

## 随机更换头像

1. 将图片放在同一个本机目录中，在“头像目录”输入路径或点击“选择目录”。
2. 选择一个或多个已连接、已识别账号，点击“换头像”。
3. 软件为每个账号独立随机选择一张非空 JPG、JPEG、PNG 或 WebP 文件，发送绝对路径和已识别的个人主页地址。
4. 扩展新建后台任务页打开 `/me`，确认登录账号与列表记录一致。
5. 找到“编辑头像”和“上传照片”，临时附加 Chrome `debugger`。优先定位头像编辑窗口内的文件控件；否则拦截上传按钮的文件选择器，通过 `DOM.setFileInputFiles` 填入图片路径。
6. 等待上传和裁剪窗口可保存，再检查任务页账号，点击“保存”。默认使用 Facebook 当前的裁剪设置，不自动调整构图。
7. 保存窗口关闭后，检查成功提示或个人主页头像图片变化；回传结果，释放调试器，只关闭本次创建的任务页。

只读取所选目录直接包含的文件，不递归子目录。不同账号可能选中同一张图片；不会删除或移动原文件。同一浏览器配置不会同时启动两次换头像。

| 结果 | 含义 |
| --- | --- |
| 头像已更新 | 已提交保存，并检测到页面成功提示或头像图片变化 |
| 待确认 | 已点击保存且窗口关闭，但没有取得充分的页面确认，请自行检查个人主页 |
| 执行失败 | 账号变化、登录验证、文件控件缺失、上传/保存超时、任务页被关闭或其他异常；详情显示在“执行结果”列 |

用户切换其他标签页不会改变换头像目标。不要操作任务页里的头像编辑窗口；关闭、导航任务页或切换 Facebook 登录账号可能使任务失败。网络中断发生在提交保存之后时，头像可能已经更新，应核对后再重试。

当前匹配简体中文、繁体中文和英文按钮。Facebook 的页面布局、按钮文字、裁剪流程或上传限制发生变化时，可能需要调整 `change_avatar.js`。扩展没有绕过账号验证，也没有通过 Facebook 服务端接口核实最终持久化结果。

## 扩展权限

| 权限 | 用途 |
| --- | --- |
| `tabs`、`scripting` | 管理任务页、读取账号信息并执行页面脚本 |
| `debugger` | 将本机图片路径交给头像上传控件，并触发上传按钮点击 |
| Facebook 主机权限 | 在 Facebook 页面运行自动化脚本 |
| `fbcdn.net`、`fbsbx.com` 主机权限 | 读取 Facebook 头像图片并生成列表缩略图 |
| 本机主机权限 | 与本地控制软件通信 |
| `storage`、`unlimitedStorage`、`alarms` | 现有扩展保留的权限，当前主要流程不依赖这些权限 |

换头像期间浏览器可能显示调试提示。不要在任务页打开开发者工具或取消调试，否则自动上传可能中断。

## 更新与打包

修改源码后，在扩展管理页面点击“重新加载”，并重启本地软件。已有的 `dist/server.exe` 不会自动包含新的 Python 源码。

```powershell
python -m PyInstaller --noconfirm --onefile --windowed --name server --specpath build --icon "WS Browser Bridge/icon/bridge.ico" --add-data "WS Browser Bridge/icon;WS Browser Bridge/icon" server.py
```

上述 Windows 命令包含软件窗口图标和扩展图标资源，输出为 `dist/server.exe`。本机已有的 `server.spec` 也已配置图标，可使用 `python -m PyInstaller --noconfirm server.spec`；仓库目前将该本机配置、`build`、`dist` 和 `release` 设为忽略文件。

## 代码结构与验证

```text
server.py                        本地界面、账号管理和 WebSocket 服务
server.spec                      本地打包配置
WS Browser Bridge/
  manifest.json                  扩展入口和权限
  bg.js                          连接、账号识别、标签页及上传调度
  popup.html / popup.js          扩展操作面板
  tools.js                       首页、小组浏览和互动
  auto_reels.js                  Reels 浏览
  cancel_friend_requests.js      取消已发送好友请求
  change_avatar.js               头像编辑、上传控件和保存状态识别
  icon/bridge-*                  插件及本地软件图标
tools/create_icons.py            图标生成工具，需要 Pillow
tests/                          通信和账号识别回归测试
```

`offscreen.html` 和 `offscreen.js` 是历史实现，当前 manifest 未启用。

```powershell
node --test tests/avatar_bridge.test.cjs tests/avatar_page.test.cjs
python -m unittest discover -s tests -p test_avatar_server.py
python tools/check_ui.py
```

测试模拟 Chrome API，验证任务页隔离、账号变化、上传、保存结果及异常清理。测试不登录真实 Facebook，也不能证明所有账号页面布局都适用。

## License

MIT

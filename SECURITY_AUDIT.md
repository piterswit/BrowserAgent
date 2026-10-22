# BrowserAgent 安全审核报告

审核日期：2026-10-22（Asia/Tokyo）。目标目录：`D:\ML\Duty\BrowserAgent`。修复版本：**0.8.1**。

审核结论：**通过（本次范围内；保留已确认的依赖维护及条件性风险）**。保留现有 WebSocket 及业务流程，新增可信凭据引导、DPAPI 存储、双向认证及逐消息签名，不再采用“接受无认证连接”的处理方式。不承诺抵御同一 Windows 用户环境已被控制的情形。

## 1. 项目概况与范围

- Python 桌面程序：Tkinter / ttkbootstrap，回环 WebSocket 服务；PyInstaller 打包 Windows EXE。
- Chrome Manifest V3 扩展：原生 JavaScript、service worker、隔离世界注入、Chrome debugger 文件上传。
- 包管理器：pip。原来只有 3 个固定版本的直接依赖，无锁文件；修复后 4 个显式依赖、6 个间接依赖，共 10 个锁定包。Pillow 从间接依赖提升为显式安全约束。
- JavaScript 没有 package.json 或 npm 锁文件；运行时代码不依赖 npm 包。浏览器检查脚本另需 Playwright，本次使用已安装的 Python Playwright 所带 Node 驱动，没有升级全局环境。
- 覆盖当前桌面源码、全部扩展入口和页面脚本、测试、工具、README、GitHub Actions，以及本次生成的 0.8.1 修复包。
- 按开发者最新确认，既往发布和仓库历史不纳入本次报告，本报告不重新评价既往发布。其他机器、外部分发渠道及 GitHub Release 资产也不在本轮范围内。
- 已读取目录及配置实际 ACL；新增真实浏览器认证验证使用临时扩展副本、全新浏览器配置及系统分配的回环端口，避开既有监听者。未操作真实账号。

报告位置均指修复后的源码；漏洞影响描述说明修改前行为。组件公告的严重度不等于已证明本项目存在同等级可利用路径。

## 2. 问题汇总

| 编号      | 类别  | 严重级别     | 位置                                                                                                                                          | 状态                                                |
| ------- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| SEC-01  | 代码  | High     | [server.py:386](D:/ML/Duty/BrowserAgent/server.py:386)、[bg.js:738](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:738>)                   | 已修复：Native Messaging 自动引导、双向认证、消息签名及来源限制                |
| SEC-02  | 代码  | Medium   | [server.py:415](D:/ML/Duty/BrowserAgent/server.py:415)                                                                                      | 已修复：连接身份绑定及重复 ID 拒绝                               |
| DEP-01  | 依赖  | High     | [requirements.txt:3](D:/ML/Duty/BrowserAgent/requirements.txt:3)                                                                            | 已修复：PyInstaller 6.6.0 → 6.22.3                    |
| DEP-02  | 依赖  | Critical | [requirements.txt:4](D:/ML/Duty/BrowserAgent/requirements.txt:4)                                                                            | 已修复：锁定 Pillow 13.0.0；组件级，当前危险调用未发现                |
| DEP-03  | 依赖  | Medium   | [requirements.lock:1](D:/ML/Duty/BrowserAgent/requirements.lock:1)、[工作流:37](D:/ML/Duty/BrowserAgent/.github/workflows/build_release.yml:37) | 已修复：完整版本及 SHA256 锁定                               |
| EXT-01  | 代码  | Low      | [bg.js:857](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:857>)                                                                          | 已修复：消息调用方和顶层 frame 校验；防御性加固                       |
| EXT-02  | 代码  | Low      | [bg.js:223](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:223>)、[bg.js:692](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:692>)       | 已修复：目的地址、滚动参数、头像重定向限制                             |
| EXT-03  | 代码  | Low      | [manifest.json:12](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/manifest.json:12>)                                                            | 已修复：删除闲置 unlimitedStorage                         |
| CI-01   | 代码  | Medium   | [工作流:23](D:/ML/Duty/BrowserAgent/.github/workflows/build_release.yml:23)                                                                    | 已修复：Action 固定提交 SHA、禁用 Git 凭据持久化                  |
| RISK-02 | 依赖  | Medium   | [requirements.txt:1](D:/ML/Duty/BrowserAgent/requirements.txt:1)                                                                            | 建议关注：开发者选择本轮保留 websockets 12.0                    |
| DEP-04  | 依赖  | Medium   | [requirements.lock:93](D:/ML/Duty/BrowserAgent/requirements.lock:93)                                                                        | 建议关注：开发者已接受条件性未修复风险，保留 13.0.0                     |

其中 EXT-01/02/03 属于权限和输入面的加固，未把缺少校验本身夸大为可从任意网站直接利用的独立漏洞。

## 3. 依赖版本、公告与适用性

审核开始时项目没有锁文件。下表分别记录修改前的依赖声明、审核开始时宿主实际版本，以及最终隔离安装/构建版本，避免混为一谈。

| 包                         | 原声明 / 关系                | 宿主实际版本   | 最终锁定版本    | 核查结果                                                |
| ------------------------- | ----------------------- | -------- | --------- | --------------------------------------------------- |
| websockets                | 直接，12.0                 | 16.0     | 12.0      | 未查到适用已知公告；12.0 不在官方最新版本安全维护范围                       |
| ttkbootstrap              | 直接，1.10.1               | 1.12.0   | 1.10.1    | 本次未查到该版本适用公告；旧固定版本落后于仍在维护的上游                        |
| pyinstaller               | 直接，6.6.0                | 6.13.0   | 6.22.3    | 官方高危公告影响旧声明和宿主版本，修复 EXE 须重新构建                       |
| pillow                    | ttkbootstrap 间接，>=8.2.0 | 11.2.1   | 13.0.0    | 旧环境有多项 Critical/High；13.0.0 仍有一项特定条件下的未修复 Medium    |
| altgraph                  | PyInstaller 间接，未锁定      | 0.17.4   | 0.17.5    | Web 检索、最终 OSV/PyPI 审计未发现适用公告                        |
| packaging                 | PyInstaller 间接，>=22.0   | 25.0     | 26.3      | 同上                                                  |
| pefile                    | Windows 打包间接，未锁定        | 2023.2.7 | 2024.8.26 | 同上；版本发布时间较久，建议持续关注                                  |
| pyinstaller-hooks-contrib | 打包间接，旧下限 2024.3         | 2025.4   | 2026.9    | 未发现适用公告；是 PyInstaller 官方社区 hooks 项目                 |
| pywin32-ctypes            | Windows 打包间接，>=0.2.1    | 0.2.3    | 0.2.3     | 未发现适用公告；发布较久，不能据此认定停维                               |
| setuptools                | 打包间接，>=42.0.0           | 80.3.1   | 84.2.1    | 宿主 OSV 命中 macOS sdist 排除规则问题；当前 Windows EXE 构建不满足条件 |

以上 10 个包逐个检索了 GitHub Advisory / 官方项目安全信息，并对最终锁定清单分别运行 pip-audit 的 OSV 和 PyPI 数据源。没有发现疑似仿冒包的证据；这不构成对软件供应链身份的绝对保证。没有核实到这些项目整体已停止维护。[websockets 官方仅维护最新版安全更新](https://github.com/python-websockets/websockets/security)；ttkbootstrap 上游仍有 [新版本发布](https://github.com/israel-dryer/ttkbootstrap/releases)。

### DEP-01：PyInstaller 构建器

官方 [GHSA-9fxf-4qw3-ghmr](https://github.com/pyinstaller/pyinstaller/security/advisories/GHSA-9fxf-4qw3-ghmr) 影响 `<6.22.1`，修复版本为 `6.22.1`；本次选择同一主版本中的 `6.22.3`。利用要求本机低权限攻击者能以操纵过的环境启动一个高权限 PyInstaller EXE。本项目使用 onefile，但未配置 `--uac-admin`；普通权限运行不满足提权条件。

本次更新构建器并重建了 EXE。另一条 [可选模块导入提权公告](https://github.com/pyinstaller/pyinstaller/security/advisories/GHSA-p2xp-xx3r-mffc) 影响 `<6.0.0`，不适用于这里声明的 6.6.0，未误报为待修漏洞。

### DEP-02：Pillow Critical/High 及调用路径

官方公告包括 [多帧加载器原生内存失效，Critical](https://github.com/python-pillow/Pillow/security/advisories/GHSA-v9pv-5gc8-w2m6) 和 [FPX JPEG 解码堆溢出，Critical](https://github.com/python-pillow/Pillow/security/advisories/GHSA-5x8w-8jj5-q52h)，均覆盖旧版本并在 `13.0.0` 修复。另有 ImageCms、坐标溢出、PSD/TIFF、字体和压缩炸弹等 High 公告。

当前程序使用 Tk 原生 PhotoImage 读取已限制尺寸的 PNG 缩略图，头像上传由浏览器处理；`tools/create_icons.py` 和主题依赖采用固定资源与固定绘图参数。未发现把用户头像传给 Pillow 多帧/FPX/TIFF/PSD/DDS/Arrow 解码或导出的调用，也未发现攻击者可控的绘图坐标。**不能据组件公告直接宣称本项目已有可利用 RCE。** 未来新增图片功能和依赖内部间接路径仍需复核。

已按开发者批准将 Pillow 13.0.0 显式固定，Python 要求同步提高到 3.11。没有改动共享宿主环境中的 11.2.1；请用锁文件安装后运行。官方 61 条公告、版本范围、各项 High/Critical 适用性说明与源链接见 [逐项附表](D:/ML/Duty/BrowserAgent/security-audit/dependency-advisories.md)。

### DEP-04：Pillow 13.0.0 尚未修复的条件性问题

[GHSA-654x-cwwv-5j9c](https://github.com/python-pillow/Pillow/security/advisories/GHSA-654x-cwwv-5j9c) 官方标记 Medium、影响 11.2.1–13.0.0、没有修复版本。条件是 `PILLOW_ALIGNMENT > 1` 且导出 Arrow，可能输出未初始化堆内存。源码未发现启用此设置或 Arrow 导出；故当前路径未发现可达，不能标记为“升级已修复”。开发者于 2026-10-22 明确接受此条件性未修复风险，选择保留已验证的 13.0.0，并记录适用条件、跟踪上游公告。未来启用特殊内存对齐或新增 Arrow 导出前，须重新评估可达性。

setuptools 的 [GHSA-h35f-9h28-mq5c](https://github.com/pypa/setuptools/security/advisories/GHSA-h35f-9h28-mq5c) 涉及 macOS Unicode 文件名与 sdist 排除规则。OSV 给出修复版本 83.0.0，而上游公告的 patched 字段未填，存在数据差异；不把 83.0.0 当作已由两源确认的修复结论。最终锁定 84.2.1，且本项目是 Windows wheel 安装和 EXE 构建，不走该受影响路径。

### 扫描器与公告的差异

原声明清单的 pip-audit 返回未命中，但官方 PyInstaller 公告明确适用；不能据扫描器零命中忽略上游公告。宿主相关包的 OSV 输出为 **66 条原始记录**，按主 ID 去重为 **Pillow 45 条、setuptools 1 条**，不是 66 个独立问题。上游还有尚未完整同步的公告。

最终 10 包锁文件在 OSV/PyPI 两源审计均为零命中，但这**不覆盖**上述官方未修复 Arrow 公告。证据见 [宿主审计](D:/ML/Duty/BrowserAgent/security-audit/host-dependencies-osv.json)、[最终 OSV](D:/ML/Duty/BrowserAgent/security-audit/dependencies-after-osv.json)、[最终 PyPI](D:/ML/Duty/BrowserAgent/security-audit/dependencies-after-pypi.json)。

## 4. 已修复的代码问题及改动理由

**SEC-01：无需输入的自动认证。** 软件启动时在当前用户 HKCU 自动注册 Native Messaging host，allowed_origins 仅允许 manifest 公钥对应的固定扩展 ID。随机密钥使用当前用户 DPAPI 加密后原子写入 `%LOCALAPPDATA%/BrowserAgent/NativeBridge/credential.dpapi`；互斥量同步多实例创建，损坏凭据拒绝继续，不静默轮换。发布包将独立通信组件放在 conf/FB_bridge_host.exe，由浏览器后台调用，根目录只保留桌面 EXE；源码启动静默编译并缓存同一无界面组件，所有注册路径均为 EXE，不再注册 cmd/Python 启动器。移动软件后重启会更新注册路径。

扩展通过 Native Messaging 获取凭据，仅在内存中使用；没有配对码界面或扩展持久存储。双方随机 nonce 和角色区分的 HMAC-SHA256 完成双向认证，成功前不读取账号资料、不执行控制；逐消息签名绑定会话、方向、递增序号及消息体，拒绝篡改、反射和重放。15 秒握手超时、128 KiB 消息上限、8 条接收队列并关闭压缩，保留 Origin 校验。组件或认证失败时提示错误并重试，不退回无认证连接。长动作异步处理，Stop 不等待其结束。

依据：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[固定扩展 ID](https://developer.chrome.com/docs/extensions/reference/manifest/key)、[Microsoft DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)。Native Messaging、argv 来源检查及 DPAPI 均不能隔离同一 Windows 用户的恶意代码。

**SEC-02：客户端 ID 可覆盖或切换。** 原连接能反复以任意 client_id 初始化，覆盖其他连接，或在断开后留下旧 ID 映射。现在验证 ID 类型、长度和字符；一条连接绑定一个 ID，拒绝抢占其他活动连接，状态更新必须来自当前登记的连接。断线仍只清理该连接自己的记录。利用原本要求能访问服务；此隔离与双向认证同时保留。

**EXT-01：消息来源防御性加固。** 验证自身扩展 ID；控制操作只接受本扩展 popup 的精确 URL；页面回调只接受 HTTPS Facebook 顶层 frame，再校验既有任务 ID。原 manifest 没有 externally_connectable，未发现任意网站能直接调用 onMessage 的证据，因此此项定为 Low 加固。

**EXT-02：输入和目的地址限制。** `open` 只允许 HTTPS Facebook 地址，拒绝 file/javascript/外站 URL；滚动参数只接受有限范围的有限数值；Facebook 判断同时验证协议。头像请求保留 HTTPS 主机白名单及 credentials:omit，新增禁止自动重定向，避免原始地址通过验证后转向其他目标。未确认真实头像源存在可利用跳转链，按 Low 加固处理。

**EXT-03 / CI-01 / DEP-03。** 删除无用途的 unlimitedStorage。5 个 Action 的同主版本标签经各自官方 GitHub API 解析为完整提交 SHA，关闭 checkout 的 Git 凭据持久化。新增 10 包 wheel SHA256 锁文件；CI 和安装说明改用 `--require-hashes --only-binary=:all:`。原来的无锁构建允许沿用宿主旧 Pillow；新隔离 EXE 包含来源校验模块且没有 NumPy DLL。减少连接日志中的账号姓名及异常内容输出。

**其余审核结果。** 未发现 SQL/NoSQL 执行、shell=True、生产 eval/exec、远程脚本下载执行、不可信 pickle/yaml 反序列化、关闭 TLS 校验、自造加密、nodeIntegration 或 Electron IPC。测试中的 exec 仅编译本地 AST 测试夹具，innerHTML 使用本地固定测试内容；未当作生产注入漏洞。不存在 Web HTTP 业务接口/CORS 配置；回环 WebSocket 校验已纳入 SEC-01 修复。release 检查读取 ZIP 不解压，没有 Zip Slip 写入点。CI 仅受版本 tag push 触发，没有 pull_request_target；tag 作为环境变量传递并先校验与版本一致，未发现直接拼入脚本的表达式注入。

## 5. 凭据与敏感配置

在当前源码、配置及本次 0.8.1 修复包检查中，没有发现可确认的真实 API Key、Token、私钥、数据库密码、云 AccessKey 或 Webhook 泄露。模式扫描和人工复核不构成对任意编码或隐写内容均无泄露的取证证明。

`.env` 原先未在忽略规则中；已补充 `.env`、`.env.*`（允许 `.env.example`）及私钥扩展名。`conf/` 原已忽略，检查未被 Git 跟踪；没有发现被跟踪的 .env/私钥文件。本次未发现需要迁移为环境变量的硬编码凭据，故没有创建含虚构变量的 .env.example。自动凭据使用当前用户 DPAPI 加密，不写入 conf、扩展存储或发行包。旧手动配对字段不再参与连接。

**如果随后确认某个凭据曾提交或对外泄露，必须在对应平台作废并重新生成；仅删除代码、加入 gitignore 或清理当前提交不够。** 本次没有发现需要实际轮换的外部平台密钥，也没有擅自轮换任何现有凭据。

## 6. 开发者决定与剩余风险

| 事项                   | 可选方案                            | 建议 / 已确认决定                                   |
| -------------------- | ------------------------------- | -------------------------------------------- |
| websockets 12.0 维护状态 | 保留；或迁移 16.x API 并重新验证           | 开发者选择本轮保留，后续单独迁移；这是维护风险，未宣称已有适用 CVE          |
| Pillow 无修复 Arrow 问题  | 保留 13.0.0 并在新增相关路径前重新评估；或暂缓依赖定版 | 开发者已明确选择保留 13.0.0，接受条件性未修复风险并跟踪上游；当前未发现受影响路径 |

回环连接已提供双向认证及消息签名，但不加密消息。DPAPI 绑定当前用户，无法防御同一 Windows 用户已能执行任意代码、修改注册表或读取进程内存的情形。注册使用 HKCU，不请求管理员权限；组织策略禁止该功能时需由部署方允许该 host，不绕过策略。首次引入 manifest 公钥可能改变原开发版扩展身份，需重新加载并停用重复旧扩展，不修改 Facebook 登录数据。

`debugger`、tabs、Facebook 主机权限是现有功能所需，保留；建议将高权限上传能力逐步改为按需授权。当前 offscreen 文件未被 manifest 启用，不能作为活动入口；启用前需重新审查其独立连接入口。CI 的写权限仍在整个发布 job 范围内，后续可将只读构建与带写权限发布拆分。Playwright 测试依赖未纳入 Node 开发依赖清单，建议另做可复现测试环境。

头像下载目前在完成 blob 下载后检查 5 MiB 上限，极大响应或解码负载的资源消耗仍建议加流式上限；未证明有可控的生产利用路径。经开发者确认，本轮不包括其他部署机器、外部分发渠道或 GitHub Release 资产；不再把这些排除范围作为覆盖缺口。源码与 0.8.1 包的动态验证以隔离测试和启动检查为准，不代表生产账号或所有浏览器环境验证。

### 后续运行体验修复

- `conf/FB_bridge_host.exe` 进一步替换为独立 C# Windows GUI 组件（文件版本 0.8.1.1，7.5 KiB），不使用 PyInstaller、Python、脚本或子进程，也不引用 UI 框架。直接使用继承的 Win32 管道并以当前用户 DPAPI 解密现有凭据；协议和扩展不变。源码模式在后台以 CREATE_NO_WINDOW 编译相同组件，不再注册 host.cmd。发布检查同时验证 GUI 子系统和 CLR 标头，拒绝将旧 Python 启动器或控制台组件误打包。组件依赖 Windows 系统 .NET Framework 4.x，无新增 NuGet 包；Python 锁文件仍为 10 包。
- 新增 `single_instance.py`：按当前 Windows 用户及登录会话使用命名互斥量保持单实例，重复启动只发送激活事件；原窗口在 Tk 主线程恢复并置前。前台授权仅授予已有实例的进程，不开放命令执行接口。退出后释放句柄，可重新启动。已对编译 EXE 进行真实重复启动、最小化恢复、正常关闭检查。

## 7. 验证与交付

验证环境：Windows、Python 3.12.10、Node 22.20.0，项目隔离依赖按锁文件安装。Pillow 13.0.0 要求 Python >=3.11；现有 CI 配置为 3.11，未声称已在本机跑过 CI 服务器。

| 验证                            | 结果                                       |
| ----------------------------- | ---------------------------------------- |
| JavaScript 现有与新增安全回归          | 300 / 300 通过                             |
| Python 现有与新增安全回归              | 64 / 64 通过                               |
| check_ui.py                   | 布局、居中、图标、头像及主题切换通过                       |
| check_activity_browser.cjs    | 滚动、不可见等待、停止及 Reels 翻页通过                  |
| check_activity_ui_browser.cjs | 三语言模拟交互、草稿和安全弹框保护通过                      |
| check_avatar_browser.cjs      | 独立模拟页面上传、激活和保存确认通过                       |
| 扩展弹窗隔离检查                      | 操作按钮在 600px 内可见、无配对控件、连接状态提示通过           |
| Python ↔ JavaScript 真实回环互通    | 真实 Chromium 扩展 → Native host EXE / 源码模式静默编译的 EXE → DPAPI → 双向认证及签名 Stop 确认通过；账号资料模拟，网页外网请求阻断 |
| 哈希锁安装、pip check               | 通过，无依赖冲突                                 |
| 最终 OSV / PyPI 双源审计            | 工具均零命中；不覆盖官方未修复 Arrow 公告                 |
| PyInstaller 6.22.3 单文件构建      | 桌面及 Native host 均构建通过，认证/注册模块和 GUI 资源已打包                   |
| check_release.py，tag v0.8.1   | EXE 版本、资源及实际 ZIP 内容检查通过，确认 conf 仅含通信组件，无用户配置     |
| 打包 EXE 启动冒烟检查                 | 在独立临时目录隐藏启动成功，随附组件可读取 DPAPI 凭据并拒绝错误来源，随后关闭本次测试进程           |
| Native Messaging 真实浏览器集成 | 发布组件和源码模式静默编译组件均通过：固定扩展 ID、DPAPI、双向认证及签名停止确认；不使用真实账号 |
| 后台组件无黑窗 | PE GUI 子系统验证通过，误双击直接退出，浏览器管道认证通过 |
| 编译主程序单实例 | 重复启动自动退出、仅一个主窗口、最小化恢复、正常关闭及锁释放通过 |
| git diff --check              | 通过                                       |

真实浏览器集成证据见 [发布组件](D:/ML/Duty/BrowserAgent/security-audit/native-browser-integration.txt) 和 [源码模式](D:/ML/Duty/BrowserAgent/security-audit/native-browser-source.txt)。

审核证据与测试日志保存在 [security-audit](D:/ML/Duty/BrowserAgent/security-audit)。本地构建包为 [FB_Auto_Active_v0.8.1_silent_host.zip](D:/ML/Duty/BrowserAgent/release/security-audit/FB_Auto_Active_v0.8.1_silent_host.zip)。无需输入的自动认证说明已写入 README；桌面、manifest 和 popup 版本统一为 0.8.1，软件和扩展须同步更新。没有创建提交、推送 tag 或发布远程 Release。

本次修改文件对应关系：桌面自动注册、认证入口及身份隔离在 server.py；认证签名及来源校验在 bridge_security.py；扩展通信、来源/地址校验在 bg.js；弹窗交互在 popup.html/popup.js；权限与版本在 manifest.json；依赖约束在 requirements.txt/requirements.lock；CI 固定版本和安装方式在工作流；忽略规则在 .gitignore；连接说明在 README。测试覆盖自动引导、认证签名、来源隔离、身份抢占及长任务中的 Stop。新增 native_bridge.py 实现自动注册、DPAPI 及原生消息协议；CI 和发布包校验强制包含通信组件。

本轮体验修复证据：[单实例验证](D:/ML/Duty/BrowserAgent/security-audit/single-instance.txt)、[无控制台验证](D:/ML/Duty/BrowserAgent/security-audit/native-no-console.json)。

### 闪窗反馈复核（独立组件本机验证通过）

开发者反馈旧实现实际使用仍有短暂窗口，其具体窗口来源未在本机复现，不能认定已定位为某一进程。为消除项目自身的 Python/脚本启动链，本轮改为独立无界面组件，并在可见的真实 Chromium 中完成认证和停止命令验证；Windows 窗口显示事件监测记录为 0 个相关可见窗口。证据见 [新组件窗口监测](D:/ML/Duty/BrowserAgent/security-audit/native-window-trace-managed.json)。结论限于新实现和本次测试环境，开发者实际部署仍需更新完整包后确认。单实例窗口恢复和主程序功能保持通过。

发布 CI 复核发现英文 Windows 的 cp1252 控制台无法输出中文连接日志；已改为不包含远端原始文本的 ASCII 诊断日志，避免异常中断断线清理。新增严格 cp1252 回归；Windows 短路径测试统一比较 resolve 后的文件路径，并为 CI 设置 UTF-8。

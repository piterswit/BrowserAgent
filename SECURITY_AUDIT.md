# BrowserAgent 安全审核报告

审核日期：2026-10-22（Asia/Tokyo）。目标目录：`D:\ML\Duty\BrowserAgent`。修复版本：**0.8.1**。

审核结论：**在开发者已接受风险和约定范围内通过**。本次完成源码、依赖、扩展信任边界、CI 和凭据排查，并实施来源校验、身份隔离、依赖升级等修复与加固。按开发者最新要求移除配对及消息签名，采用可信本机环境前提；该结论不表示连接经过身份认证或项目不存在安全问题。

## 1. 项目概况与范围

- Python 桌面程序：Tkinter / ttkbootstrap，回环 WebSocket 服务；PyInstaller 打包 Windows EXE。
- Chrome Manifest V3 扩展：原生 JavaScript、service worker、隔离世界注入、Chrome debugger 文件上传。
- 包管理器：pip。原来只有 3 个固定版本的直接依赖，无锁文件；修复后 4 个显式依赖、6 个间接依赖，共 10 个锁定包。Pillow 从间接依赖提升为显式安全约束。
- JavaScript 没有 package.json 或 npm 锁文件；运行时代码不依赖 npm 包。浏览器检查脚本另需 Playwright，本次使用已安装的 Python Playwright 所带 Node 驱动，没有升级全局环境。
- 覆盖当前桌面源码、全部扩展入口和页面脚本、测试、工具、README、GitHub Actions，以及本次生成的 0.8.1 修复包。
- 按开发者最新确认，既往发布和仓库历史不纳入本次报告，本报告不重新评价既往发布。其他机器、外部分发渠道及 GitHub Release 资产也不在本轮范围内。
- 本机当前无项目运行进程或桥接端口监听；已读取目录及配置实际 ACL。未操作真实账号。

报告位置均指修复后的源码；漏洞影响描述说明修改前行为。组件公告的严重度不等于已证明本项目存在同等级可利用路径。

## 2. 问题汇总

| 编号      | 类别  | 严重级别     | 位置                                                                                                                                          | 状态                                                |
| ------- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| SEC-01  | 代码  | High     | [server.py:378](D:/ML/Duty/BrowserAgent/server.py:378)、[bg.js:700](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:700>)                   | 已修复：浏览器来源校验和消息资源限制；本机身份认证由开发者选择不实施                |
| SEC-02  | 代码  | Medium   | [server.py:396](D:/ML/Duty/BrowserAgent/server.py:396)                                                                                      | 已修复：连接身份绑定及重复 ID 拒绝                               |
| DEP-01  | 依赖  | High     | [requirements.txt:3](D:/ML/Duty/BrowserAgent/requirements.txt:3)                                                                            | 已修复：PyInstaller 6.6.0 → 6.22.3                    |
| DEP-02  | 依赖  | Critical | [requirements.txt:4](D:/ML/Duty/BrowserAgent/requirements.txt:4)                                                                            | 已修复：锁定 Pillow 13.0.0；组件级，当前危险调用未发现                |
| DEP-03  | 依赖  | Medium   | [requirements.lock:1](D:/ML/Duty/BrowserAgent/requirements.lock:1)、[工作流:37](D:/ML/Duty/BrowserAgent/.github/workflows/build_release.yml:37) | 已修复：完整版本及 SHA256 锁定                               |
| EXT-01  | 代码  | Low      | [bg.js:778](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:778>)                                                                          | 已修复：消息调用方和顶层 frame 校验；防御性加固                       |
| EXT-02  | 代码  | Low      | [bg.js:186](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:186>)、[bg.js:654](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/bg.js:654>)       | 已修复：目的地址、滚动参数、头像重定向限制                             |
| EXT-03  | 代码  | Low      | [manifest.json:12](<D:/ML/Duty/BrowserAgent/WS Browser Bridge/manifest.json:12>)                                                            | 已修复：删除闲置 unlimitedStorage                         |
| CI-01   | 代码  | Medium   | [工作流:23](D:/ML/Duty/BrowserAgent/.github/workflows/build_release.yml:23)                                                                    | 已修复：Action 固定提交 SHA、禁用 Git 凭据持久化                  |
| RISK-01 | 代码  | Medium   | 回环 WebSocket 两端                                                                                                                             | 建议关注：开发者接受本机进程连接端；未修复 |
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

**SEC-01：浏览器来源及消息资源限制。** 服务仅监听 127.0.0.1，握手 Origin 仅接受完整的 Chrome 扩展源；限制 128 KiB 消息、8 条接收队列并关闭压缩，扩展拒绝过大的文本消息。此措施限制普通网页连接与资源消耗，但 Origin 可被本机程序伪造，不能作为身份认证。

**RISK-01：无需配对的本机连接（开发者接受）。** 按开发者明确要求，移除桌面和扩展配对 UI、凭据读取、双向挑战及逐消息签名，连接后直接交换账号资料和控制命令。恶意本机进程仍可冒充客户端，或抢占约定端口冒充控制端；后者可请求扩展执行账号操作及满足现有检查条件的图片上传。利用要求攻击者能在本机运行程序，并满足相关浏览器、账号及文件检查条件；不是已证明的任意文件读取。开发者选择以可信本机环境为前提接受该风险，不能标记为技术上已修复。业务命令异步处理，Stop 不等待长任务完成。

**SEC-02：客户端 ID 可覆盖或切换。** 原连接能反复以任意 client_id 初始化，覆盖其他连接，或在断开后留下旧 ID 映射。现在验证 ID 类型、长度和字符；一条连接绑定一个 ID，拒绝抢占其他活动连接，状态更新必须来自当前登记的连接。断线仍只清理该连接自己的记录。利用原本要求能访问服务；此隔离保留，但不认证连接端身份。

**EXT-01：消息来源防御性加固。** 验证自身扩展 ID；控制操作只接受本扩展 popup 的精确 URL；页面回调只接受 HTTPS Facebook 顶层 frame，再校验既有任务 ID。原 manifest 没有 externally_connectable，未发现任意网站能直接调用 onMessage 的证据，因此此项定为 Low 加固。

**EXT-02：输入和目的地址限制。** `open` 只允许 HTTPS Facebook 地址，拒绝 file/javascript/外站 URL；滚动参数只接受有限范围的有限数值；Facebook 判断同时验证协议。头像请求保留 HTTPS 主机白名单及 credentials:omit，新增禁止自动重定向，避免原始地址通过验证后转向其他目标。未确认真实头像源存在可利用跳转链，按 Low 加固处理。

**EXT-03 / CI-01 / DEP-03。** 删除无用途的 unlimitedStorage。5 个 Action 的同主版本标签经各自官方 GitHub API 解析为完整提交 SHA，关闭 checkout 的 Git 凭据持久化。新增 10 包 wheel SHA256 锁文件；CI 和安装说明改用 `--require-hashes --only-binary=:all:`。原来的无锁构建允许沿用宿主旧 Pillow；新隔离 EXE 包含来源校验模块且没有 NumPy DLL。减少连接日志中的账号姓名及异常内容输出。

**其余审核结果。** 未发现 SQL/NoSQL 执行、shell=True、生产 eval/exec、远程脚本下载执行、不可信 pickle/yaml 反序列化、关闭 TLS 校验、自造加密、nodeIntegration 或 Electron IPC。测试中的 exec 仅编译本地 AST 测试夹具，innerHTML 使用本地固定测试内容；未当作生产注入漏洞。不存在 Web HTTP 业务接口/CORS 配置；回环 WebSocket 校验已纳入 SEC-01 修复。release 检查读取 ZIP 不解压，没有 Zip Slip 写入点。CI 仅受版本 tag push 触发，没有 pull_request_target；tag 作为环境变量传递并先校验与版本一致，未发现直接拼入脚本的表达式注入。

## 5. 凭据与敏感配置

在当前源码、配置及本次 0.8.1 修复包检查中，没有发现可确认的真实 API Key、Token、私钥、数据库密码、云 AccessKey 或 Webhook 泄露。模式扫描和人工复核不构成对任意编码或隐写内容均无泄露的取证证明。

`.env` 原先未在忽略规则中；已补充 `.env`、`.env.*`（允许 `.env.example`）及私钥扩展名。`conf/` 原已忽略，检查未被 Git 跟踪；没有发现被跟踪的 .env/私钥文件。本次未发现需要迁移为环境变量的硬编码凭据，故没有创建含虚构变量的 .env.example。已移除配对凭据的生成、读取及使用；既有配置或浏览器存储中的旧字段不再参与连接。

**如果随后确认某个凭据曾提交或对外泄露，必须在对应平台作废并重新生成；仅删除代码、加入 gitignore 或清理当前提交不够。** 本次没有发现需要实际轮换的外部平台密钥，也没有擅自轮换任何现有凭据。

## 6. 开发者决定与剩余风险

| 事项                   | 可选方案                            | 建议 / 已确认决定                                   |
| -------------------- | ------------------------------- | -------------------------------------------- |
| 本机连接身份认证             | 无需配对；或恢复双向配对认证                  | 开发者明确要求无需配对并接受其他本机连接风险；从安全角度建议保留认证，现按已确认决定移除 |
| websockets 12.0 维护状态 | 保留；或迁移 16.x API 并重新验证           | 开发者选择本轮保留，后续单独迁移；这是维护风险，未宣称已有适用 CVE          |
| Pillow 无修复 Arrow 问题  | 保留 13.0.0 并在新增相关路径前重新评估；或暂缓依赖定版 | 开发者已明确选择保留 13.0.0，接受条件性未修复风险并跟踪上游；当前未发现受影响路径 |

本机连接不提供身份认证、消息签名或加密，不防御恶意本机进程或本机流量观察。开发者已明确选择可信本机环境部署并移除配对；如使用前提改变，应重新评估并恢复认证。本机目录和 conf 的实际 ACL 已核对，未见 Everyone / Authenticated Users / BUILTIN Users 的通用 Allow；没有修改系统权限。

`debugger`、tabs、Facebook 主机权限是现有功能所需，保留；建议将高权限上传能力逐步改为按需授权。当前 offscreen 文件未被 manifest 启用，不能作为活动入口；启用前需重新审查其独立连接入口。CI 的写权限仍在整个发布 job 范围内，后续可将只读构建与带写权限发布拆分。Playwright 测试依赖未纳入 Node 开发依赖清单，建议另做可复现测试环境。

头像下载目前在完成 blob 下载后检查 5 MiB 上限，极大响应或解码负载的资源消耗仍建议加流式上限；未证明有可控的生产利用路径。经开发者确认，本轮不包括其他部署机器、外部分发渠道或 GitHub Release 资产；不再把这些排除范围作为覆盖缺口。本机无正在运行的项目实例，源码与 0.8.1 包的动态验证仍以隔离测试和启动检查为准，不代表生产账号或所有浏览器环境验证。

## 7. 验证与交付

验证环境：Windows、Python 3.12.10、Node 22.20.0，项目隔离依赖按锁文件安装。Pillow 13.0.0 要求 Python >=3.11；现有 CI 配置为 3.11，未声称已在本机跑过 CI 服务器。

| 验证                            | 结果                                       |
| ----------------------------- | ---------------------------------------- |
| JavaScript 现有与新增安全回归          | 298 / 298 通过                             |
| Python 现有与新增安全回归              | 47 / 47 通过                               |
| check_ui.py                   | 布局、居中、图标、头像及主题切换通过                       |
| check_activity_browser.cjs    | 滚动、不可见等待、停止及 Reels 翻页通过                  |
| check_activity_ui_browser.cjs | 三语言模拟交互、草稿和安全弹框保护通过                      |
| check_avatar_browser.cjs      | 独立模拟页面上传、激活和保存确认通过                       |
| 扩展弹窗隔离检查                      | 操作按钮在 600px 内可见、无配对控件、连接状态提示通过           |
| Python ↔ JavaScript 真实回环互通    | 无需配对交换 Unicode 账号资料及控制命令通过；Chrome API 模拟 |
| 哈希锁安装、pip check               | 通过，无依赖冲突                                 |
| 最终 OSV / PyPI 双源审计            | 工具均零命中；不覆盖官方未修复 Arrow 公告                 |
| PyInstaller 6.22.3 单文件构建      | 通过，确认来源校验模块和 GUI 资源已打包                   |
| check_release.py，tag v0.8.1   | EXE 版本、资源及实际 ZIP 内容检查通过，确认未包含用户 conf     |
| 打包 EXE 启动冒烟检查                 | 在独立临时目录隐藏启动成功，能创建配置，随后关闭本次测试进程           |
| git diff --check              | 通过                                       |

审核证据与测试日志保存在 [security-audit](D:/ML/Duty/BrowserAgent/security-audit)。本地构建包为 [FB_Auto_Active_v0.8.1.zip](D:/ML/Duty/BrowserAgent/release/security-audit/FB_Auto_Active_v0.8.1.zip)。无需配对的连接说明已写入 README；桌面、manifest 和 popup 版本统一为 0.8.1，软件和扩展须同步更新。没有创建提交、推送 tag 或发布远程 Release。

本次修改文件对应关系：桌面连接及身份隔离在 server.py；来源校验在 bridge_security.py；扩展通信、来源/地址校验在 bg.js；弹窗交互在 popup.html/popup.js；权限与版本在 manifest.json；依赖约束在 requirements.txt/requirements.lock；CI 固定版本和安装方式在工作流；忽略规则在 .gitignore；连接说明在 README。测试使用正常的无需配对协议，验证实际连接、来源隔离、身份抢占及长任务中的 Stop。

# macOS arm64 / x64 测试包

两种架构分别在 macOS 原生构建，不使用 Windows 交叉编译，也不将 Intel 与 Apple Silicon 组件混在同一包中。版本沿用软件显示版本，包含最新插件修复。

## 安装与使用

- Apple Silicon（M1、M2、M3、M4 等）选择 `macOS_arm64.dmg`。
- Intel Mac 选择 `macOS_x64.dmg`。
- 打开镜像，把 `BrowserAgent.app` 复制到“应用程序”后运行，避免直接在只读镜像内长期使用。
- 在 Chrome/Edge 扩展页加载包内 `Browser_Extension`，更新后重新加载插件并刷新 Facebook。
- 配置保存到 `~/Library/Application Support/BrowserAgent/conf/config.json`，不写入应用包。
- 支持触控板辅助点按、Control 点按，以及设置窗口的 Command+Return 保存。
- 通信组件随应用包内置，不需要另外安装 Python，也不要单独移动应用包内文件。

测试包使用本地临时签名，没有 Apple Developer ID 签名与公证。正式公开分发前应使用自己的开发者证书签名、公证；若系统阻止打开，请先核实来源和校验值并按设备管理要求处理。

## 在 Mac 本机构建

在与目标架构一致的 Python 3.11 虚拟环境中运行：

```bash
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes --only-binary=:all: -r requirements.lock
python -m unittest discover -s tests -p 'test_*.py'
python tools/check_posix_ui.py
```

Apple Silicon：

```bash
python tools/build_posix_release.py --arch arm64
```

Intel：

```bash
python tools/build_posix_release.py --arch x64
```

脚本会拒绝 Python 架构不匹配，构建独立的通信组件和原生 `.app`，验证二者架构、应用签名、组件认证和应用启动，再生成 `.dmg`、保留文件权限的 `.tar.gz`、SHA-256 校验文件。`BUILD_INFO.json` 记录版本、架构和源码提交。已有同名发布目录不会被覆盖。

## 云端构建

在 GitHub Actions 中运行 **Build macOS arm64 and x64**，同一源码提交会生成 `BrowserAgent-macOS-arm64` 和 `BrowserAgent-macOS-x64` 两份构建产物。下载后解压外层 artifact ZIP，使用里面对应架构的 DMG。

原有 **Cross-platform compatibility** 也会分别在 `macos-15`（arm64）和 `macos-15-intel`（x64）执行测试与打包。两个任务都成功后，才能认为双架构原生构建已通过。只在 Windows 上通过单元测试不等于已完成 macOS 编译或实机验收；较旧 macOS 与真实 Facebook 账号仍需单独测试。

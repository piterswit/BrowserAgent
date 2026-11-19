"""Build on the destination OS; PyInstaller does not cross-compile."""
import argparse
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag")
    args = parser.parse_args()
    if sys.platform not in {"darwin", "linux"}:
        parser.error("Run this builder on macOS or Linux")
    args.tag = args.tag or "v" + json.loads((ROOT / "WS Browser Bridge/manifest.json").read_text())["version"]
    subprocess.run([sys.executable, str(ROOT / "tools/check_release.py"), "--tag", args.tag], check=True)
    target = ROOT / "release" / ("FB_Auto_Active_" + args.tag + "_" + sys.platform + "_" + platform.machine())
    if target.exists():
        parser.error("Release directory already exists; use a clean workspace")
    work = ROOT / "build" / ("posix-" + sys.platform)
    common = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--specpath", str(work)]
    subprocess.run([*common, "--name", "FB_bridge_host", "--distpath", str(work / "host"),
                    str(ROOT / "native_host_posix.py")], check=True, cwd=ROOT)
    host = work / "host/FB_bridge_host"
    denied = subprocess.run([str(host), "chrome-extension://unauthorized/"], input=b"", capture_output=True, timeout=15)
    if denied.returncode != 1 or denied.stdout:
        raise RuntimeError("Packaged Native Messaging host did not reject an unauthorized origin")
    desktop_name = "BrowserAgent" if sys.platform == "darwin" else "FB_server"
    command = [*common, "--name", desktop_name, "--distpath", str(work / "desktop"),
               "--add-data", str(ROOT / "WS Browser Bridge/icon") + ":WS Browser Bridge/icon"]
    if sys.platform == "darwin":
        command += ["--windowed", "--osx-bundle-identifier", "com.browseragent.desktop", "--add-data", str(host) + ":conf"]
    subprocess.run([*command, str(ROOT / "server.py")], check=True, cwd=ROOT)
    target.mkdir(parents=True)
    if sys.platform == "darwin":
        shutil.copytree(work / "desktop/BrowserAgent.app", target / "BrowserAgent.app", symlinks=True)
    else:
        shutil.copy2(work / "desktop/FB_server", target / "FB_server")
        (target / "conf").mkdir()
        shutil.copy2(host, target / "conf/FB_bridge_host")
    shutil.copytree(ROOT / "WS Browser Bridge", target / "Browser_Extension")
    shutil.copy2(ROOT / "README.md", target / "README.md")
    # tar preserves execute permissions and app-bundle symlinks.
    archive = shutil.make_archive(str(target), "gztar", root_dir=target.parent, base_dir=target.name)
    print(archive)


if __name__ == "__main__":
    main()

"""Build native Linux packages or separate arm64/x64 macOS apps and disk images."""
import argparse
import hashlib
import json
import os
import platform
import plistlib
from pathlib import Path
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from check_release import ROOT, EXTENSION, check_versions, release_version


def native_architecture(machine, requested="auto"):
    aliases = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64", "amd64": "x86_64", "x64": "x86_64"}
    actual = aliases.get(machine.lower())
    target = actual if requested == "auto" else aliases.get(requested.lower())
    if not actual or not target or actual != target:
        raise ValueError("Use a native Python interpreter and build runner matching the requested architecture")
    return target


def macos_spec(root, work, host, architecture, manifest):
    display = release_version(manifest)
    version = manifest["version"]
    info = {"CFBundleDisplayName": "BrowserAgent", "CFBundleShortVersionString": version,
            "CFBundleVersion": version, "CFBundleGetInfoString": display,
            "NSHighResolutionCapable": True, "NSRequiresAquaSystemAppearance": False,
            "LSMinimumSystemVersion": "11.0"}
    data = [(str(root / "WS Browser Bridge/icon"), "WS Browser Bridge/icon"), (str(host), "conf")]
    return f'''# Generated native macOS onedir app; no cross-architecture emulation.
a = Analysis([{str(root / "server.py")!r}], pathex=[{str(root)!r}], binaries=[], datas={data!r},
             hiddenimports=[], hookspath=[], runtime_hooks=[], excludes=[])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='BrowserAgent', console=False,
          debug=False, strip=False, upx=False, argv_emulation=False,
          target_arch={architecture!r}, codesign_identity='-')
collection = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='BrowserAgent')
app = BUNDLE(collection, name='BrowserAgent.app', icon={str(work / "BrowserAgent.icns")!r},
             bundle_identifier='com.browseragent.desktop', version={version!r}, info_plist={info!r})
'''


def verify_macos_bundle(bundle, architecture, manifest):
    info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.browseragent.desktop" or \
            info.get("CFBundleShortVersionString") != manifest["version"] or \
            info.get("CFBundleGetInfoString") != release_version(manifest):
        raise RuntimeError("Mac app bundle metadata does not match the release")
    for binary in (bundle / "Contents/MacOS/BrowserAgent", bundle / "Contents/Resources/conf/FB_bridge_host"):
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError("Mac package is missing an executable: " + str(binary))
        slices = subprocess.check_output(["/usr/bin/lipo", "-archs", str(binary)], text=True).split()
        if slices != [architecture]:
            raise RuntimeError(f"Wrong architecture in {binary.name}: {slices}; expected {architecture}")
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)


def verify_native_host(host, system):
    denied = subprocess.run([str(host), "chrome-extension://unauthorized/"], input=b"", capture_output=True, timeout=15)
    if denied.returncode != 1 or denied.stdout:
        raise RuntimeError("Packaged Native Messaging host did not reject an unauthorized origin")
    sys.path.insert(0, str(ROOT))
    from native_bridge import EXTENSION_ORIGIN
    from platform_support import user_data_directory
    from posix_native import ensure_secret
    # Test the compiled host with a disposable home, not the developer's credentials.
    with tempfile.TemporaryDirectory(prefix="BrowserAgent host test ") as directory:
        env = dict(os.environ, HOME=directory, XDG_CONFIG_HOME=str(Path(directory) / ".config"))
        folder = user_data_directory(system, Path(directory), env) / "NativeBridge"
        key = ensure_secret(folder)
        message = json.dumps({"cmd": "get_bridge_credentials"}).encode()
        completed = subprocess.run([str(host), EXTENSION_ORIGIN], input=struct.pack("<I", len(message)) + message,
                                   capture_output=True, timeout=20, env=env)
        if completed.returncode or len(completed.stdout) < 4:
            raise RuntimeError("Packaged Native Messaging host failed the credential roundtrip")
        size = struct.unpack("<I", completed.stdout[:4])[0]
        response = json.loads(completed.stdout[4:])
        if size != len(completed.stdout) - 4 or response.get("protocol") != 1 or response.get("key") != key:
            raise RuntimeError("Packaged Native Messaging host returned invalid credentials")


def smoke_macos_app(bundle):
    with tempfile.TemporaryDirectory(prefix="BrowserAgent GUI test ") as directory:
        process = subprocess.Popen([str(bundle / "Contents/MacOS/BrowserAgent")],
                                   env=dict(os.environ, HOME=directory), start_new_session=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(4)
            if process.poll() is not None:
                _, error = process.communicate()
                raise RuntimeError("Packaged Mac app exited during startup: " + error.decode(errors="replace")[-500:])
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag")
    parser.add_argument("--arch", choices=("auto", "arm64", "x64", "x86_64"), default="auto")
    args = parser.parse_args()
    if sys.platform not in {"darwin", "linux"}:
        parser.error("Run this builder on macOS or Linux")
    if sys.platform != "darwin" and args.arch != "auto":
        parser.error("--arch is only supported for macOS")
    architecture = native_architecture(platform.machine()) if sys.platform == "linux" else native_architecture(platform.machine(), args.arch)
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    args.tag = args.tag or "v" + release_version(manifest)
    check_versions(args.tag)
    label = "macOS_" + ("x64" if architecture == "x86_64" else "arm64") if sys.platform == "darwin" else "linux_" + architecture
    target = ROOT / "release" / ("FB_Auto_Active_" + args.tag + "_" + label)
    if target.exists():
        parser.error("Release directory already exists; use a clean workspace")
    work = ROOT / "build" / ("posix-" + args.tag + "-" + label)
    work.mkdir(parents=True, exist_ok=True)
    common = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--workpath", str(work / "work")]
    native = ["--target-arch", architecture, "--codesign-identity", "-"] if sys.platform == "darwin" else []
    subprocess.run([*common, "--onefile", "--specpath", str(work), *native, "--name", "FB_bridge_host", "--distpath", str(work / "host"),
                    str(ROOT / "native_host_posix.py")], check=True, cwd=ROOT)
    host = work / "host/FB_bridge_host"
    verify_native_host(host, sys.platform)
    if sys.platform == "darwin":
        from PIL import Image
        with Image.open(EXTENSION / "icon/icon.png") as image:
            image.convert("RGBA").resize((1024, 1024), Image.Resampling.LANCZOS).save(work / "BrowserAgent.icns", format="ICNS")
        spec = work / "BrowserAgent.spec"
        spec.write_text(macos_spec(ROOT, work, host, architecture, manifest), encoding="utf-8")
        subprocess.run([*common, "--distpath", str(work / "desktop"), str(spec)], check=True, cwd=ROOT)
        bundle = work / "desktop/BrowserAgent.app"
        verify_macos_bundle(bundle, architecture, manifest)
        smoke_macos_app(bundle)
    else:
        subprocess.run([*common, "--onefile", "--specpath", str(work), "--name", "FB_server", "--distpath", str(work / "desktop"),
                        "--add-data", str(EXTENSION / "icon") + ":WS Browser Bridge/icon", str(ROOT / "server.py")], check=True, cwd=ROOT)
    target.mkdir(parents=True)
    if sys.platform == "darwin":
        shutil.copytree(work / "desktop/BrowserAgent.app", target / "BrowserAgent.app", symlinks=True)
    else:
        shutil.copy2(work / "desktop/FB_server", target / "FB_server")
        (target / "conf").mkdir()
        shutil.copy2(host, target / "conf/FB_bridge_host")
    shutil.copytree(EXTENSION, target / "Browser_Extension")
    for name in ("README.md", "RELEASE_NOTES.md", "MACOS.md"):
        shutil.copy2(ROOT / name, target / name)
    for file in EXTENSION.rglob("*"):
        if file.is_file() and (target / "Browser_Extension" / file.relative_to(EXTENSION)).read_bytes() != file.read_bytes():
            raise RuntimeError("Packaged plugin differs from source: " + file.name)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    (target / "BUILD_INFO.json").write_text(json.dumps({"version": release_version(manifest),
        "architecture": architecture, "platform": sys.platform, "source_commit": revision,
        "python": sys.version, "build_macos": platform.mac_ver()[0]}, indent=2), encoding="utf-8")
    # tar preserves execute permissions and app-bundle symlinks.
    archive = shutil.make_archive(str(target), "gztar", root_dir=target.parent, base_dir=target.name)
    products = [Path(archive)]
    if sys.platform == "darwin":
        disk = Path(str(target) + ".dmg")
        subprocess.run(["/usr/bin/hdiutil", "create", "-volname", "BrowserAgent " + label,
                        "-srcfolder", str(target), "-format", "UDZO", str(disk)], check=True)
        subprocess.run(["/usr/bin/hdiutil", "verify", str(disk)], check=True)
        products.append(disk)
    checksum = target.parent / ("SHA256SUMS_" + args.tag + "_" + label + ".txt")
    checksum.write_text("".join(hashlib.sha256(file.read_bytes()).hexdigest() + "  " + file.name + "\n"
                                for file in products), encoding="utf-8")
    for product in products:
        print(product)
    print(checksum)


if __name__ == "__main__":
    main()

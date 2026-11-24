"""Build and verify a Windows beta/stable package without user configuration."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

from check_release import EXTENSION, ROOT, check_archive, check_executable, check_versions, release_version, copy_extension


def version_resource(manifest):
    display = release_version(manifest)
    parts = [int(part) for part in manifest["version"].split(".")]
    parts += [0] * (4 - len(parts))
    if "-" in display:
        parts[3] = int(display.rsplit(".", 1)[1]) if display.rsplit(".", 1)[1].isdigit() else 0
    return f'''VSVersionInfo(
  ffi=FixedFileInfo(filevers={tuple(parts)!r}, prodvers={tuple(parts)!r},
    mask=0x3f, flags={2 if "-" in display else 0}, OS=0x40004, fileType=0x1, subtype=0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('040904B0', [
    StringStruct('CompanyName', 'BrowserAgent'),
    StringStruct('FileDescription', 'BrowserAgent Facebook account manager'),
    StringStruct('FileVersion', '{display}'),
    StringStruct('ProductName', 'BrowserAgent'),
    StringStruct('ProductVersion', '{display}'),
    StringStruct('OriginalFilename', 'FB_server.exe')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])])
'''


def zip_folder(folder, destination, include_root=True):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(folder.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(folder.parent if include_root else folder).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "release")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Run this builder on Windows")
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    tag = args.tag or "v" + release_version(manifest)
    check_versions(tag)
    target = args.output_dir.resolve() / ("FB_Auto_Active_" + tag)
    if target.exists():
        parser.error("Release directory already exists; choose a new version or move the old package")
    work = ROOT / "build" / ("windows-" + tag)
    work.mkdir(parents=True, exist_ok=True)
    resource = work / "version_info.txt"
    resource.write_text(version_resource(manifest), encoding="utf-8")
    dist = work / "dist"
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
                    "--name", "FB_server", "--specpath", str(work), "--workpath", str(work / "work"),
                    "--distpath", str(dist), "--version-file", str(resource),
                    "--icon", str(EXTENSION / "icon/bridge.ico"), "--add-data",
                    str(EXTENSION / "icon") + ";WS Browser Bridge/icon", str(ROOT / "server.py")],
                   cwd=ROOT, check=True)
    host = dist / "conf/FB_bridge_host.exe"
    subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                    str(ROOT / "tools/build_native_host.ps1"), "-OutputPath", str(host)], cwd=ROOT, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    check_executable(dist / "FB_server.exe")
    target.mkdir(parents=True)
    shutil.copy2(dist / "FB_server.exe", target / "FB_server.exe")
    (target / "conf").mkdir()
    shutil.copy2(host, target / "conf/FB_bridge_host.exe")
    copy_extension(target / "Browser_Extension")
    for name in ("README.md", "RELEASE_NOTES.md"):
        shutil.copy2(ROOT / name, target / name)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = subprocess.run(["git", "diff", "HEAD", "--quiet"], cwd=ROOT).returncode != 0
    info = {"version": release_version(manifest), "extension_version": manifest["version"],
            "source_commit": revision, "source_modified": dirty, "python": sys.version,
            "dependencies": {item.metadata["Name"]: item.version for item in importlib.metadata.distributions()}}
    (target / "BUILD_INFO.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    archive = Path(str(target) + ".zip")
    zip_folder(target, archive)
    check_archive(archive, tag)
    plugin = target.parent / ("FB_Browser_Bridge_" + tag + ".zip")
    zip_folder(target / "Browser_Extension", plugin, include_root=False)
    checksums = target.parent / ("SHA256SUMS_" + tag + ".txt")
    checksums.write_text("".join(hashlib.sha256(file.read_bytes()).hexdigest() + "  " + file.name + "\n"
                                 for file in (archive, plugin)), encoding="utf-8")
    print(f"Verified Windows package: {archive}")
    print(f"Browser extension package: {plugin}")
    print(f"SHA-256 checksums: {checksums}")


if __name__ == "__main__":
    main()

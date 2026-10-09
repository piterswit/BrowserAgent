"""Check release versions, bundled GUI assets, and distributable contents."""

import argparse
import ast
import json
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "WS Browser Bridge"
GUI_ASSETS = ("bridge.ico", "bridge-128.png", "bridge-32.png", "avatar-placeholder.png")


def check_versions(tag):
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+){0,2}", version) or tag != f"v{version}":
        raise ValueError("Release tag must match the extension version")
    tree = ast.parse((ROOT / "server.py").read_text(encoding="utf-8"))
    app_version = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "APP_VERSION" for target in node.targets)
    )
    if app_version != version:
        raise ValueError("Desktop and extension versions differ")
    popup = (EXTENSION / "popup.html").read_text(encoding="utf-8")
    if f'<div class="footer">{tag}</div>' not in popup:
        raise ValueError("Popup version differs from release tag")
    for asset in GUI_ASSETS:
        if not (EXTENSION / "icon" / asset).is_file():
            raise ValueError(f"Missing GUI asset: {asset}")


def check_executable(path):
    from PyInstaller.archive.readers import CArchiveReader

    names = {name.replace("\\", "/") for name in CArchiveReader(str(path)).toc}
    for asset in GUI_ASSETS:
        if f"WS Browser Bridge/icon/{asset}" not in names:
            raise ValueError(f"Executable is missing GUI asset: {asset}")


def check_archive(path, tag):
    prefix = f"FB_Auto_Active_{tag}/"
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Release archive failed CRC verification")
        names = {name.replace("\\", "/") for name in archive.namelist()}
        expected = {prefix + "FB_server.exe", prefix + "README.md"}
        expected.update(
            prefix + "Browser_Extension/" + file.relative_to(EXTENSION).as_posix()
            for file in EXTENSION.rglob("*") if file.is_file()
        )
        missing = expected - names
        if missing:
            raise ValueError(f"Release archive is missing files: {sorted(missing)}")
        if any(not name.startswith(prefix) or "conf" in name.split("/") for name in names):
            raise ValueError("Unexpected root or user configuration in release archive")
        manifest = json.loads(archive.read(prefix + "Browser_Extension/manifest.json"))
        if f"v{manifest['version']}" != tag:
            raise ValueError("Packaged extension version differs from release tag")
        if archive.getinfo(prefix + "FB_server.exe").file_size == 0:
            raise ValueError("Packaged executable is empty")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--exe", type=Path)
    parser.add_argument("--zip", type=Path)
    args = parser.parse_args()
    check_versions(args.tag)
    if args.exe:
        check_executable(args.exe)
    if args.zip:
        check_archive(args.zip, args.tag)
    print(f"Release checks passed: {args.tag}")


if __name__ == "__main__":
    main()

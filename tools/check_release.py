"""Check release versions, bundled GUI assets, and distributable contents."""

import argparse
import ast
import json
from pathlib import Path
import re
import struct
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


def check_native_host_image(data):
    """Reject an old Python launcher or console build accidentally copied into a release."""
    try:
        offset = struct.unpack_from("<I", data, 0x3c)[0]
        optional = offset + 24
        magic = struct.unpack_from("<H", data, optional)[0]
        if data[:2] != b"MZ" or data[offset:offset + 4] != b"PE\0\0" or magic not in (0x10b, 0x20b):
            raise ValueError("Invalid native host PE image")
        subsystem = struct.unpack_from("<H", data, optional + 68)[0]
        directories = optional + (96 if magic == 0x10b else 112)
        clr_address, clr_size = struct.unpack_from("<II", data, directories + 14 * 8)
        if subsystem != 2 or not clr_address or not clr_size:
            raise ValueError("Native host must be the windowless .NET build, not a console/Python launcher")
    except struct.error as error:
        raise ValueError("Truncated native host PE image") from error


def check_archive(path, tag):
    prefix = f"FB_Auto_Active_{tag}/"
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("Release archive failed CRC verification")
        names = {name.replace("\\", "/") for name in archive.namelist()}
        native_host = prefix + "conf/FB_bridge_host.exe"
        expected = {prefix + "FB_server.exe", native_host, prefix + "README.md"}
        expected.update(
            prefix + "Browser_Extension/" + file.relative_to(EXTENSION).as_posix()
            for file in EXTENSION.rglob("*") if file.is_file()
        )
        missing = expected - names
        if missing:
            raise ValueError(f"Release archive is missing files: {sorted(missing)}")
        allowed_conf = {prefix + "conf/", native_host}
        if any(not name.startswith(prefix) or ".." in name.split("/")
               or ("conf" in name.casefold().split("/") and name not in allowed_conf)
               or name == prefix + "FB_bridge_host.exe" for name in names):
            raise ValueError("Unexpected root or user configuration in release archive")
        manifest = json.loads(archive.read(prefix + "Browser_Extension/manifest.json"))
        if f"v{manifest['version']}" != tag:
            raise ValueError("Packaged extension version differs from release tag")
        if archive.getinfo(prefix + "FB_server.exe").file_size == 0:
            raise ValueError("Packaged executable is empty")
        if archive.getinfo(native_host).file_size == 0:
            raise ValueError("Native Messaging host is empty")
        check_native_host_image(archive.read(native_host))


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

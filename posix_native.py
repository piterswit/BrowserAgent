"""macOS/Linux Native Messaging registration and private per-user credentials."""
import os
from pathlib import Path
import secrets
import shlex
import stat
import sys
import time
import json

from native_bridge import HOST_NAME, EXTENSION_ORIGIN, atomic_write, state_directory
from posix_instance import private_directory, private_open


def load_secret(folder=None):
    folder = private_directory(folder or state_directory())
    path = folder / "credential.key"
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise OSError("Credential file must be private to the current user")
        secret = os.read(descriptor, 33)
        if len(secret) != 32:
            raise ValueError("Invalid credential")
        return secret.hex()
    finally:
        os.close(descriptor)


def ensure_secret(folder=None):
    import fcntl
    folder = private_directory(folder or state_directory())
    descriptor = private_open(folder / ".credential.lock")
    try:
        until = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise OSError("Credential initialization busy")
                time.sleep(0.05)
        path = folder / "credential.key"
        if not path.exists() and not path.is_symlink():
            atomic_write(path, secrets.token_bytes(32))
        return load_secret(folder)
    finally:
        os.close(descriptor)


def manifest_directories(platform=None, home=None, environ=None):
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else Path(home)
    environ = os.environ if environ is None else environ
    if platform == "darwin":
        base = home / "Library/Application Support"
        browsers = ("Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary",
                    "Google/ChromeForTesting", "Chromium", "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev")
    else:
        base = Path(environ.get("XDG_CONFIG_HOME", home / ".config"))
        if not base.is_absolute():
            base = home / ".config"
        browsers = ("google-chrome", "google-chrome-beta", "google-chrome-unstable", "google-chrome-for-testing",
                    "chromium", "microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev")
    return [base / browser / "NativeMessagingHosts" for browser in browsers]


def source_native_host(folder, executable):
    source = Path(__file__).resolve().parent / "native_host_posix.py"
    host = folder / "browseragent-native-host"
    # Quote interpreter and source paths separately; argv is forwarded without evaluation.
    script = "#!/bin/sh\nexec " + shlex.quote(str(executable)) + " " + shlex.quote(str(source)) + ' "$@"\n'
    atomic_write(host, script.encode("utf-8"))
    host.chmod(0o700)
    return host


def prepare_native_bridge(folder=None, executable=None, frozen=None):
    folder = private_directory(folder or state_directory())
    secret = ensure_secret(folder)
    executable = Path(executable or sys.executable).absolute()
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    if frozen:
        candidates = [executable.parent / "conf/FB_bridge_host", executable.parent.parent / "Resources/conf/FB_bridge_host"]
        if getattr(sys, "_MEIPASS", None):
            candidates.append(Path(sys._MEIPASS) / "conf/FB_bridge_host")
        host = next((path for path in candidates if path.is_file() and os.access(path, os.X_OK)), None)
        if host is None:
            raise OSError("Missing executable conf/FB_bridge_host")
    else:
        host = source_native_host(folder, executable)
    manifest = {"name": HOST_NAME, "description": "BrowserAgent automatic bridge authentication",
                "path": str(host.resolve()), "type": "stdio", "allowed_origins": [EXTENSION_ORIGIN]}
    encoded = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    atomic_write(folder / "host.json", encoded)
    # Install per-user manifests only; no root privileges or system policy changes.
    for directory in manifest_directories():
        directory.mkdir(parents=True, exist_ok=True)
        atomic_write(directory / (HOST_NAME + ".json"), encoded)
    return secret

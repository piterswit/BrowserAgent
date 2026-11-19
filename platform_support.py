"""Platform paths and desktop integration without importing a GUI at module load."""
import atexit
import os
from pathlib import Path
import subprocess
import sys


def user_data_directory(platform=None, home=None, environ=None):
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else Path(home)
    environ = os.environ if environ is None else environ
    if platform == "win32":
        return Path(environ.get("LOCALAPPDATA", home / "AppData/Local")) / "BrowserAgent"
    if platform == "darwin":
        return home / "Library/Application Support/BrowserAgent"
    config = Path(environ.get("XDG_CONFIG_HOME", home / ".config"))
    if not config.is_absolute():
        config = home / ".config"
    return config / "BrowserAgent"


def font_family():
    return "Microsoft YaHei UI" if sys.platform == "win32" else "PingFang SC" if sys.platform == "darwin" else "Noto Sans CJK SC"


def keep_awake():
    """Hold an OS-supported idle-sleep assertion for the application's lifetime."""
    if sys.platform == "win32":
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000002)
        atexit.register(lambda: kernel.SetThreadExecutionState(0x80000000))
    elif sys.platform == "darwin":
        try:
            process = subprocess.Popen(["/usr/bin/caffeinate", "-di", "-w", str(os.getpid())],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            atexit.register(lambda: process.terminate() if process.poll() is None else None)
        except OSError:
            pass
    # Linux desktop idle-inhibition protocols differ. Do not change system power settings.


def set_app_identity():
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("BrowserAgent.FBBridge")

"""Read desktop appearance without changing system preferences."""
import os
import shutil
import subprocess
import sys

try:
    import winreg
except ImportError:
    winreg = None


def system_theme_name():
    if sys.platform == "darwin":
        return "darkly" if _read(["/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"]).casefold() == "dark" else "flatly"
    if sys.platform.startswith("linux"):
        if "KDE" in os.environ.get("XDG_CURRENT_DESKTOP", "").upper():
            command = shutil.which("kreadconfig6") or shutil.which("kreadconfig5")
            scheme = _read([command, "--file", "kdeglobals", "--group", "General", "--key", "ColorScheme"]) if command else ""
            return "darkly" if "dark" in scheme.casefold() else "flatly"
        command = shutil.which("gsettings")
        scheme = _read([command, "get", "org.gnome.desktop.interface", "color-scheme"]) if command else ""
        if "dark" in scheme.casefold():
            return "darkly"
        if scheme and "default" not in scheme.casefold():
            return "flatly"
        theme = _read([command, "get", "org.gnome.desktop.interface", "gtk-theme"]) if command else ""
        return "darkly" if "dark" in theme.casefold() else "flatly"
    if winreg is None:
        return "flatly"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        return "darkly" if value == 0 else "flatly"
    except OSError:
        return "flatly"


def _read(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=0.8, check=False)
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""

"""Read the Windows application color preference without changing the system."""

try:
    import winreg
except ImportError:
    winreg = None


def system_theme_name():
    if winreg is None:
        return "flatly"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        return "darkly" if value == 0 else "flatly"
    except OSError:
        return "flatly"

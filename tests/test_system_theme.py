import unittest
from unittest.mock import MagicMock, patch

import system_theme


class SystemThemeTests(unittest.TestCase):
    def test_windows_application_preference(self):
        for value, theme in ((0, "darkly"), (1, "flatly"), ("unknown", "flatly")):
            registry = MagicMock()
            registry.QueryValueEx.return_value = (value, 4)
            with self.subTest(value=value), patch.object(system_theme.sys, "platform", "win32"), patch.object(system_theme, "winreg", registry):
                self.assertEqual(system_theme.system_theme_name(), theme)
                registry.QueryValueEx.assert_called_once_with(
                    registry.OpenKey.return_value.__enter__.return_value, "AppsUseLightTheme")

    def test_missing_or_inaccessible_preference_falls_back_to_light(self):
        registry = MagicMock()
        registry.OpenKey.side_effect = PermissionError("unavailable")
        with patch.object(system_theme.sys, "platform", "win32"), patch.object(system_theme, "winreg", registry):
            self.assertEqual(system_theme.system_theme_name(), "flatly")

    def test_non_windows_fallback(self):
        with patch.object(system_theme.sys, "platform", "win32"), patch.object(system_theme, "winreg", None):
            self.assertEqual(system_theme.system_theme_name(), "flatly")

    def test_macos_appearance(self):
        for value, expected in (("Dark", "darkly"), ("", "flatly")):
            with patch.object(system_theme.sys, "platform", "darwin"), patch.object(system_theme, "_read", return_value=value):
                self.assertEqual(system_theme.system_theme_name(), expected)

    def test_linux_gnome_and_kde_preferences(self):
        for desktop, value, expected in (("GNOME", "'prefer-dark'", "darkly"), ("KDE", "BreezeDark", "darkly"),
                                         ("GNOME", "'prefer-light'", "flatly"), ("KDE", "BreezeLight", "flatly")):
            with self.subTest(desktop=desktop), patch.object(system_theme.sys, "platform", "linux"), \
                    patch.dict(system_theme.os.environ, {"XDG_CURRENT_DESKTOP": desktop}), \
                    patch.object(system_theme.shutil, "which", return_value="/usr/bin/theme-reader"), \
                    patch.object(system_theme, "_read", return_value=value):
                self.assertEqual(system_theme.system_theme_name(), expected)

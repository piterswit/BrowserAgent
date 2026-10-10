import unittest
from unittest.mock import MagicMock, patch

import system_theme


class SystemThemeTests(unittest.TestCase):
    def test_windows_application_preference(self):
        for value, theme in ((0, "darkly"), (1, "flatly"), ("unknown", "flatly")):
            registry = MagicMock()
            registry.QueryValueEx.return_value = (value, 4)
            with self.subTest(value=value), patch.object(system_theme, "winreg", registry):
                self.assertEqual(system_theme.system_theme_name(), theme)
                registry.QueryValueEx.assert_called_once_with(
                    registry.OpenKey.return_value.__enter__.return_value, "AppsUseLightTheme")

    def test_missing_or_inaccessible_preference_falls_back_to_light(self):
        registry = MagicMock()
        registry.OpenKey.side_effect = PermissionError("unavailable")
        with patch.object(system_theme, "winreg", registry):
            self.assertEqual(system_theme.system_theme_name(), "flatly")

    def test_non_windows_fallback(self):
        with patch.object(system_theme, "winreg", None):
            self.assertEqual(system_theme.system_theme_name(), "flatly")

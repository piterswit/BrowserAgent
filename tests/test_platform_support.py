import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import config_store
import platform_support
import posix_native
from packaging.requirements import Requirement


class PlatformPathsTests(unittest.TestCase):
    def test_macos_and_linux_state_are_outside_the_application_bundle(self):
        home = Path.home() / "test-user"
        self.assertEqual(platform_support.user_data_directory("darwin", home, {}), home / "Library/Application Support/BrowserAgent")
        self.assertEqual(platform_support.user_data_directory("linux", home, {}), home / ".config/BrowserAgent")
        custom = home / "custom-config"
        self.assertEqual(platform_support.user_data_directory("linux", home, {"XDG_CONFIG_HOME": str(custom)}), custom / "BrowserAgent")
        self.assertEqual(platform_support.user_data_directory("linux", home, {"XDG_CONFIG_HOME": "relative"}), home / ".config/BrowserAgent")

    def test_posix_configuration_uses_user_directory(self):
        directory = Path.home() / "isolated-settings"
        with patch.object(config_store.sys, "platform", "linux"), patch.object(config_store, "user_data_directory", return_value=directory):
            self.assertEqual(config_store.configuration_folder(), directory / "conf")

    def test_all_browser_manifest_paths_are_user_specific(self):
        home = Path.home() / "test-user"
        for platform in ("darwin", "linux"):
            paths = posix_native.manifest_directories(platform, home, {})
            self.assertTrue(all(path.is_relative_to(home) and path.name == "NativeMessagingHosts" for path in paths))
            self.assertTrue(any("ChromeForTesting" in str(path) or "chrome-for-testing" in str(path) for path in paths))
            self.assertTrue(any("Edge" in str(path) or "microsoft-edge" in str(path) for path in paths))

    def test_non_windows_desktop_helpers_do_not_access_windows_libraries(self):
        with patch.object(platform_support.sys, "platform", "linux"):
            platform_support.keep_awake()
            platform_support.set_app_identity()
            self.assertEqual(platform_support.font_family(), "Noto Sans CJK SC")

    def test_locked_dependencies_select_the_right_native_packaging_components(self):
        path = Path(__file__).resolve().parents[1] / "requirements.lock"
        packages = {}
        for line in path.read_text().splitlines():
            if line and line[0].isalpha() and "==" in line:
                requirement = Requirement(line.rstrip("\\").strip())
                packages[requirement.name] = requirement
        for platform in ("win32", "darwin", "linux"):
            environment = {"sys_platform": platform}
            self.assertEqual(packages["macholib"].marker.evaluate(environment), platform == "darwin")
            self.assertEqual(packages["pefile"].marker.evaluate(environment), platform == "win32")
            self.assertEqual(packages["pywin32-ctypes"].marker.evaluate(environment), platform == "win32")


if __name__ == "__main__":
    unittest.main()

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import config_store
import platform_support
import posix_native
from packaging.requirements import Requirement


class PlatformPathsTests(unittest.TestCase):
    def test_frozen_mac_host_is_found_in_resources_or_pyinstaller_frameworks(self):
        for location in ("Resources", "Frameworks"):
            with self.subTest(location=location), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                state = base / "private"
                state.mkdir()
                executable = base / "BrowserAgent.app/Contents/MacOS/BrowserAgent"
                host = executable.parent.parent / location / "conf/FB_bridge_host"
                host.parent.mkdir(parents=True)
                host.write_bytes(b"native fixture")
                with patch.object(posix_native, "private_directory", return_value=state), \
                        patch.object(posix_native, "ensure_secret", return_value="1" * 64), \
                        patch.object(posix_native, "manifest_directories", return_value=[]), \
                        patch.object(posix_native.os, "access", return_value=True), \
                        patch.object(posix_native.sys, "_MEIPASS", str(executable.parent.parent / "Frameworks"), create=True):
                    self.assertEqual(posix_native.prepare_native_bridge(state, executable, frozen=True), "1" * 64)
                import json
                manifest = json.loads((state / "host.json").read_text())
                self.assertEqual(manifest["path"], str(host.resolve()))

    def test_mac_mouse_and_save_shortcuts_do_not_change_other_platforms(self):
        with patch.object(platform_support.sys, "platform", "darwin"):
            self.assertIn("<Button-2>", platform_support.context_menu_bindings())
            self.assertIn("<Control-Button-1>", platform_support.context_menu_bindings())
            self.assertIn("<Command-Return>", platform_support.save_bindings())
            self.assertEqual(platform_support.font_family(), "PingFang SC")
        for system in ("win32", "linux"):
            with patch.object(platform_support.sys, "platform", system):
                self.assertEqual(platform_support.context_menu_bindings(), ("<Button-3>",))
                self.assertEqual(platform_support.save_bindings(), ("<Control-Return>",))

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

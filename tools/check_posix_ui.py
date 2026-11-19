"""Source UI smoke check for macOS/Linux; no account/network or user-config access."""
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def main():
    with patch.object(server.App, "scan"), patch.object(server, "prepare_native_bridge", return_value="0" * 64), \
            patch.object(server, "load_configuration", return_value={}), patch.object(server, "save_configuration"):
        root = server.tb.Window(themename="flatly")
        app = None
        try:
            app = server.App(root)
            root.update()
            app.open_settings()
            app.open_post_manager()
            app.post_manager.open_captions()
            for theme in ("darkly", "flatly"):
                with patch.object(server, "system_theme_name", return_value=theme):
                    app.apply_system_theme()
                root.update()
                assert app.settings_window.minutes.get() == "5"
                assert app.settings_window.limit.get() == "100"
                for window in (root, app.settings_window, app.post_manager, app.post_manager.caption_window):
                    assert window.winfo_exists()
                    assert window.winfo_width() > 200 and window.winfo_height() > 200
            print("Main window, settings, posts, captions and dark/light theme smoke check passed")
        finally:
            if app is not None:
                app.loop.call_soon_threadsafe(app.loop.stop)
            root.destroy()


if __name__ == "__main__":
    main()

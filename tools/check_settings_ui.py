import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import settings_dialog
from PIL import ImageGrab
from check_ui import check_caption, contrast


def main():
    previews = Path(__file__).resolve().parents[1] / ".audit-venv" / "settings-previews"
    previews.mkdir(parents=True, exist_ok=True)
    with patch.object(server.App, "scan"), patch.object(server, "prepare_native_bridge", return_value="0" * 64), \
            patch.object(server, "load_configuration", return_value={}), patch.object(server, "save_configuration") as persist:
        root = server.tb.Window(themename="flatly")
        app = None
        try:
            app = server.App(root)
            app.open_settings()
            dialog = app.settings_window
            app.open_settings()
            assert app.settings_window is dialog, "settings entry must reuse its existing window"
            assert dialog.minutes.get() == "5" and dialog.limit.get() == "100"
            for theme in ("darkly", "flatly"):
                with patch.object(server, "system_theme_name", return_value=theme):
                    app.apply_system_theme()
                root.update()
                check_caption(dialog, theme)
                for width, height in ((620, 500), (540, 470)):
                    dialog.geometry(f"{width}x{height}")
                    root.update()
                    def check(parent):
                        for child in parent.winfo_children():
                            assert child.winfo_y() + child.winfo_height() <= parent.winfo_height(), str(child)
                            assert child.winfo_x() + child.winfo_width() <= parent.winfo_width(), str(child)
                            if isinstance(child, server.ttk.Button):
                                assert child.winfo_width() >= child.winfo_reqwidth(), str(child)
                            check(child)
                    check(dialog)
                for name in ("Post.TButton", "PostPrimary.TButton"):
                    assert contrast(root.style.lookup(name, "foreground"), root.style.lookup(name, "background")) >= 4.5
                dialog.geometry("620x500")
                dialog.lift()
                dialog.attributes("-topmost", True)
                root.update()
                time.sleep(0.2)
                x, y = dialog.winfo_rootx(), dialog.winfo_rooty()
                ImageGrab.grab(bbox=(x, y, x + dialog.winfo_width(), y + dialog.winfo_height())).save(previews / f"{theme}.png")
            dialog.limit.set("0")
            with patch.object(settings_dialog.messagebox, "showwarning") as warning:
                dialog.save()
                warning.assert_called_once()
            assert dialog.winfo_exists() and "task_settings" not in app.configuration
            dialog.restore()
            assert dialog.minutes.get() == "5" and dialog.limit.get() == "100"
            dialog.minutes.set("12")
            dialog.limit.set("45")
            dialog.save()
            root.update()
            assert app.configuration["task_settings"] == {"activity_minutes": 12, "cancel_request_limit": 45}
            persist.assert_called()
            app.open_settings()
            assert app.settings_window.minutes.get() == "12" and app.settings_window.limit.get() == "45"
            print("Settings defaults, validation, save/reopen, minimum layout, dark/light colors and titlebars passed")
        finally:
            if app is not None:
                app.loop.call_soon_threadsafe(app.loop.stop)
            root.destroy()


if __name__ == "__main__":
    main()

"""Check the native control window at normal and minimum dimensions."""
import sys
import base64
import ctypes
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def contrast(first, second):
    def luminance(color):
        channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        channels = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
        return sum(value * weight for value, weight in zip(channels, (0.2126, 0.7152, 0.0722)))
    high, low = sorted((luminance(first), luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def check_caption(root, theme):
    window = ctypes.windll.user32.GetAncestor(root.winfo_id(), 2)
    get_attribute = ctypes.windll.dwmapi.DwmGetWindowAttribute
    get_attribute.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
    get_attribute.restype = ctypes.c_long
    dark_caption = ctypes.c_int()
    if get_attribute(window, 20, ctypes.byref(dark_caption), ctypes.sizeof(dark_caption)) == 0:
        assert dark_caption.value == int(theme == "darkly")
    caption = ctypes.c_uint()
    if get_attribute(window, 35, ctypes.byref(caption), ctypes.sizeof(caption)) == 0:
        assert caption.value == (0x00222222 if theme == "darkly" else 0xFFFFFFFF)


def native_window_icons(root):
    root.update_idletasks()
    ancestor = ctypes.windll.user32.GetAncestor
    ancestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    ancestor.restype = ctypes.c_void_p
    window = ancestor(root.winfo_id(), 2)
    send_message = ctypes.windll.user32.SendMessageW
    send_message.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
    send_message.restype = ctypes.c_ssize_t
    # Tk's iconbitmap getter returns an empty string on Windows; query the native handles instead.
    return tuple(send_message(window, 0x007F, size, 0) for size in (0, 1))


def main():
    server.App.scan = lambda self: None
    root = server.tb.Window(themename="flatly")
    try:
        original_icons = native_window_icons(root)
        with patch.object(server, "system_theme_name", return_value="darkly"):
            app = server.App(root)
        root.update()
        check_caption(root, "darkly")
        icons = native_window_icons(root)
        assert all(icons), "Missing native small or large window icon"
        assert all(current != original for current, original in zip(icons, original_icons)), "Default native icon was not replaced"
        table_style = app.list_view.cget("style")
        assert table_style == "Accounts.Treeview"
        assert int(root.style.lookup(table_style, "rowheight")) == 40
        assert abs(root.winfo_x() - (root.winfo_screenwidth() - root.winfo_width()) // 2) < 5
        assert abs(root.winfo_y() - (root.winfo_screenheight() - root.winfo_height()) // 2) < 5
        assert app.header_icon.width() == 32
        for cid in ("preview-1", "preview-2"):
            app.clients[cid] = object()
            app.register_client_ui(cid, "同名账号", cid)
        avatar_file = Path(__file__).resolve().parents[1] / "WS Browser Bridge" / "icon" / "avatar-placeholder.png"
        avatar_data = "data:image/png;base64," + base64.b64encode(avatar_file.read_bytes()).decode("ascii")
        app.update_avatar_ui("preview-1", avatar_data)
        assert app.avatar_photos["preview-1"].width() == 36
        original_photo = app.avatar_photos["preview-1"]
        app.update_avatar_ui("preview-1", "data:image/png;base64,invalid")
        assert app.avatar_photos["preview-1"] is original_photo
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            large = server.tk.PhotoImage(master=root, width=64, height=64)
            large.put("#157f78", to=(0, 0, 64, 64))
            filename = Path(directory) / "large.png"
            large.write(filename.as_posix(), format="png")
            encoded = "data:image/png;base64," + base64.b64encode(filename.read_bytes()).decode("ascii")
            app.update_avatar_ui("preview-2", encoded)
            assert app.avatar_photos["preview-2"].height() <= 36
        app.finish_avatar("preview-1", "头像更换成功")
        app.finish_avatar("preview-2", "已提交保存，请核对头像")
        app.list_view.selection_set("preview-1", "preview-2")
        root.update()
        row = app.list_view.bbox("preview-2")
        with patch.object(app.account_menu, "tk_popup"), patch.object(app.account_menu, "grab_release"):
            app.show_account_menu(SimpleNamespace(y=row[1] + 5, x_root=100, y_root=100))
        assert app.account_menu.entrycget(0, "label") == "定位浏览器"
        assert app.account_menu.entrycget(2, "label") == "查看执行详情"
        assert app.list_view.selection() == ("preview-1", "preview-2")
        for geometry in ("1020x700", "860x560"):
            root.geometry(geometry)
            root.update()
            def check(widget):
                for child in widget.winfo_children():
                    if child.winfo_manager() == "pack":
                        assert child.winfo_x() >= 0, str(child)
                        assert child.winfo_x() + child.winfo_width() <= widget.winfo_width(), str(child)
                        assert child.winfo_y() + child.winfo_height() <= widget.winfo_height(), str(child)
                    if isinstance(child, server.ttk.Button):
                        assert child.winfo_width() >= child.winfo_reqwidth(), str(child)
                    check(child)
            check(root)
            assert app.list_view.winfo_height() > 100
            row_box = app.list_view.bbox("preview-1", "#0")
            assert row_box and row_box[3] == 40
            assert row_box[3] >= app.avatar_photos["preview-1"].height() + 4
        assert app.list_view.set("preview-1", "state") == "头像已更新"
        assert app.list_view.set("preview-2", "state") == "待确认"
        assert app.selected_targets() == ["preview-1", "preview-2"]
        for theme in ("darkly", "flatly", "darkly"):
            with patch.object(server, "system_theme_name", return_value=theme):
                app.apply_system_theme()
            root.update()
            assert root.style.theme_use() == theme
            assert int(root.style.lookup("Accounts.Treeview", "rowheight")) == 40
            assert app.list_view.selection() == ("preview-1", "preview-2")
            assert app.list_view.set("preview-1", "state") == "头像已更新"
            assert app.avatar_photos["preview-1"] is original_photo
            assert str(app.account_menu.cget("background")) == root.style.colors.bg, (app.account_menu.cget("background"), root.style.colors.bg)
            assert app.list_view.bbox("preview-1", "#0")[3] == 40
            for button_style in ("Action.TButton", "Stop.TButton"):
                assert contrast(root.style.lookup(button_style, "foreground"), root.style.lookup(button_style, "background")) >= 4.5
            assert contrast(root.style.lookup("Muted.TLabel", "foreground"), root.style.colors.bg) >= 4.5
            stack, action_buttons, muted_labels, styles = [root], 0, 0, []
            while stack:
                widget = stack.pop()
                stack.extend(widget.winfo_children())
                if isinstance(widget, (server.ttk.Button, server.ttk.Label)):
                    styles.append((str(widget.cget("text")), str(widget.cget("style"))))
                if isinstance(widget, server.ttk.Button) and str(widget.cget("style")) == "Action.TButton":
                    action_buttons += 1
                if isinstance(widget, server.ttk.Label) and str(widget.cget("style")) == "Muted.TLabel":
                    muted_labels += 1
            assert action_buttons == 5 and muted_labels == 2, styles
            check_caption(root, theme)
        assert app.theme_timer is not None
        app.remove_client("preview-1")
        root.update()
        assert not app.list_view.exists("preview-1")
        assert "preview-1" not in app.avatar_photos
        print("GUI layout, centering, icons, avatars, live light/dark themes and cleanup checks passed")
    finally:
        root.destroy()


if __name__ == "__main__":
    main()

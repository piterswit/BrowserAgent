# tk_ws_control.py
# pip install websockets

import asyncio
import json
import time
import threading
import random
import sys
import base64
import struct
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import ttkbootstrap as tb
from ttkbootstrap.constants import *
import websockets
from config_store import load_configuration, save_configuration
from system_theme import system_theme_name
from bridge_security import check_origin, authenticate
from native_bridge import prepare_native_bridge
from single_instance import SingleInstance

APP_VERSION = "0.8.1"
PORT_RANGE = range(8765, 8770)

# 防止系统进入睡眠
import ctypes, atexit

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002

ctypes.windll.kernel32.SetThreadExecutionState(
    ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
)

atexit.register(
    lambda: ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
)


class App:
    def __init__(self, root: tb.Window):
        self.root = root
        self.root.title(f"BrowserAgent v{APP_VERSION} · FB账号管理")
        self.root.geometry("1020x700")
        self.root.minsize(min(860, self.root.winfo_screenwidth() - 64), min(960, self.root.winfo_screenheight() - 100))
        self.current_theme = None
        self.theme_timer = None
        self.themed_widgets = []
        self.root.bind("<Map>", self.on_window_mapped, add="+")
        self.apply_system_theme()
        icon_folder = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "WS Browser Bridge" / "icon"
        if (icon_folder / "bridge-128.png").exists():
            self.window_icon = tk.PhotoImage(file=str(icon_folder / "bridge-128.png"))
            self.root.iconphoto(True, self.window_icon)
            self.header_icon = tk.PhotoImage(file=str(icon_folder / "bridge-32.png"))
        if (icon_folder / "bridge.ico").exists():
            self.root.iconbitmap(str(icon_folder / "bridge.ico"))
            self.root.iconbitmap(default=str(icon_folder / "bridge.ico"))
        self.default_avatar = tk.PhotoImage(file=str(icon_folder / "avatar-placeholder.png")) if (icon_folder / "avatar-placeholder.png").exists() else tk.PhotoImage(width=36, height=36)
        self.avatar_photos = {}

        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

        self.servers = {}
        self.clients = {}
        self.accounts = {}
        self.ports = {}
        self.last_seen = {}  # 心跳包
        self.avatar_pending = set()
        self.configuration = load_configuration()
        self.bridge_key = None
        try:
            self.bridge_key = prepare_native_bridge()
        except (OSError, ValueError, KeyError):
            self.root.after(0, lambda: messagebox.showerror(
                "自动连接不可用", "本机通信组件注册失败。请确认软件的 conf 目录包含 FB_bridge_host.exe，且当前用户目录及注册表可写，然后重启软件。"))
        self.config_timer = None

        self.build_ui()
        self.apply_theme_styles()
        self.avatar_directory.trace_add("write", self.schedule_config_save)
        self.root.protocol("WM_DELETE_WINDOW", self.close_application)
        self.schedule_config_save()
        self.center_window()
        self.apply_titlebar_theme()
        self.scan()
        self.root.after(3000, self.check_alive)
        self.theme_timer = self.root.after(2000, self.watch_system_theme)

    def apply_system_theme(self):
        theme = system_theme_name()
        if theme == self.current_theme:
            return
        self.root.style.theme_use(theme)
        self.current_theme = theme
        self.apply_theme_styles()
        self.apply_titlebar_theme()

    def on_window_mapped(self, event):
        if event.widget is self.root:
            self.apply_titlebar_theme()
            self.root.after_idle(self.apply_titlebar_theme)

    def apply_titlebar_theme(self):
        try:
            ancestor = ctypes.windll.user32.GetAncestor
            ancestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            ancestor.restype = ctypes.c_void_p
            window = ancestor(self.root.winfo_id(), 2)
            if not window:
                return
            set_attribute = ctypes.windll.dwmapi.DwmSetWindowAttribute
            set_attribute.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
            set_attribute.restype = ctypes.c_long
            dark = ctypes.c_int(self.current_theme == "darkly")
            for attribute in (20, 19):
                if set_attribute(window, attribute, ctypes.byref(dark), ctypes.sizeof(dark)) == 0:
                    break
            # Windows 11 supports explicit caption colors; older versions ignore these.
            caption = ctypes.c_uint(0x00222222 if dark.value else 0xFFFFFFFF)
            text = ctypes.c_uint(0x00F4F4F4 if dark.value else 0xFFFFFFFF)
            set_attribute(window, 35, ctypes.byref(caption), ctypes.sizeof(caption))
            set_attribute(window, 36, ctypes.byref(text), ctypes.sizeof(text))
        except (OSError, AttributeError, tk.TclError):
            pass

    def apply_theme_styles(self):
        style = ttk.Style(self.root)
        dark = self.current_theme == "darkly"
        style.configure(".", font=("Microsoft YaHei UI", 10))
        for name in ("Treeview", "Accounts.Treeview"):
            style.configure(name, rowheight=40, font=("Microsoft YaHei UI", 10))
            style.configure(name + ".Heading", font=("Microsoft YaHei UI", 10, "bold"), padding=(10, 12))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Section.TLabel", font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("Muted.TLabel", foreground="#c4cbd3" if dark else "#596674")
        for name, background, foreground, border, hover in (
            ("Action.TButton", "#343b42" if dark else "#f0f4f7", "#f2f4f6" if dark else "#26333f",
             "#677682" if dark else "#87939e", "#46545f" if dark else "#e4edf3"),
            ("Stop.TButton", "#4b353a" if dark else "#fff1f2", "#ffb7bf" if dark else "#9b2c37",
             "#aa6872", "#674049" if dark else "#ffe1e5"),
        ):
            style.configure(name, background=background, foreground=foreground, bordercolor=border,
                            lightcolor=background, darkcolor=background, borderwidth=1)
            style.map(name, foreground=[("disabled", "#929aa3" if dark else "#6f7882"), ("!disabled", foreground)],
                      background=[("disabled", background), ("pressed", hover), ("active", hover), ("!disabled", background)],
                      bordercolor=[("focus", foreground), ("active", border), ("!disabled", border)],
                      lightcolor=[("active", hover)], darkcolor=[("active", hover)])
        for widget, name in self.themed_widgets:
            # Bypass ttkbootstrap's bootstyle name normalization for local styles.
            widget.tk.call(str(widget), "configure", "-style", name)
        if hasattr(self, "list_view"):
            self.list_view.tag_configure("success", foreground="#65d6bc" if dark else "#157f78")
            self.list_view.tag_configure("error", foreground="#ff929a" if dark else "#b33e46")
            colors = self.root.style.colors
            self.account_menu.configure(background=colors.bg, foreground=colors.fg,
                                        activebackground=colors.selectbg, activeforeground=colors.selectfg)

    def themed_widget(self, widget, name):
        self.themed_widgets.append((widget, name))
        return widget

    def watch_system_theme(self):
        self.theme_timer = None
        try:
            self.apply_system_theme()
        finally:
            self.theme_timer = self.root.after(2000, self.watch_system_theme)

    def center_window(self):
        self.root.update_idletasks()
        screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        width = min(self.root.winfo_width(), screen_width - 64)
        height = min(self.root.winfo_height(), screen_height - 100)
        self.root.geometry(f"{width}x{height}+{max(0, (screen_width - width) // 2)}+{max(0, (screen_height - height) // 2)}")

    def build_ui(self):
        frm = tb.Frame(self.root)
        frm.pack(fill="both", expand=True, padx=24, pady=20)
        header = tb.Frame(frm)
        header.pack(fill="x", pady=(0, 12))
        if hasattr(self, "header_icon"):
            tb.Label(header, image=self.header_icon).pack(side="left", padx=(0, 10))
        self.themed_widget(tb.Label(header, text="BrowserAgent"), "Title.TLabel").pack(side="left")
        self.themed_widget(tb.Label(header, text="FB账号管理"), "Muted.TLabel").pack(side="left", padx=16, pady=(8, 0))
        self.account_summary = tk.StringVar(value="已连接 0  ·  已选中 0")
        self.themed_widget(tb.Label(header, textvariable=self.account_summary), "Muted.TLabel").pack(side="right")
        tb.Separator(frm).pack(fill="x")

        avatar_frame = tb.Frame(frm)
        avatar_frame.pack(fill="x", pady=(16, 12))
        tb.Label(avatar_frame, text="头像目录").pack(side="left", padx=6)
        directory = self.configuration.get("avatar_directory", "")
        self.avatar_directory = tk.StringVar(value=directory if isinstance(directory, str) else "")
        tb.Entry(avatar_frame, textvariable=self.avatar_directory).pack(side="left", fill="x", expand=True)
        self.themed_widget(tb.Button(avatar_frame, text="选择目录", command=self.choose_avatar_directory, padding=(12, 8)), "Action.TButton").pack(side="left", padx=8)
        tb.Button(avatar_frame, text="换头像", command=self.change_avatar, bootstyle="success", padding=(12, 8)).pack(side="left")

        self.themed_widget(tb.Label(frm, text="账号操作"), "Section.TLabel").pack(anchor="w", pady=(0, 10))
        btnf = tb.Frame(frm)
        btnf.pack(fill="x", pady=(0, 12))
        for text, command in (("首页活跃", self.scroll), ("Reels活跃", self.auto_reels), ("小组活跃", self.auto_group), ("自定义活跃", self.auto_custom)):
            self.themed_widget(tb.Button(btnf, text=text, command=command, padding=(14, 8)), "Action.TButton").pack(side="left", padx=(0, 8))
        self.themed_widget(tb.Button(btnf, text="停止活跃", command=self.stop_scroll, padding=(14, 8)), "Stop.TButton").pack(side="left", padx=(0, 8))
        tb.Button(btnf, text="取消好友请求", command=self.cancel_requets, bootstyle="danger-outline", padding=(14, 8)).pack(side="right")

        frame = tb.Frame(frm)
        frame.pack(fill="both", expand=True, pady=5)

        self.list_view = tb.Treeview(
            frame,
            columns=("name", "fb_id", "state", "detail"),
            show="tree headings",
            selectmode="extended"
        )

        self.list_view.heading("state", text="状态")
        self.list_view.heading("#0", text="头像")
        self.list_view.column("#0", width=64, minwidth=64, stretch=False, anchor="center")
        self.list_view.heading("name", text="账号名称")
        self.list_view.heading("fb_id", text="FB ID / 用户名")
        self.list_view.heading("detail", text="执行结果")
        self.list_view.column("name", width=160, minwidth=100)
        self.list_view.column("fb_id", width=190, minwidth=120)
        self.list_view.column("state", width=130, minwidth=110, stretch=False, anchor="center")
        self.list_view.column("detail", width=350, minwidth=180)
        self.list_view.tag_configure("success", foreground="#157f78")
        self.list_view.tag_configure("error", foreground="#b33e46")
        self.list_view.bind("<<TreeviewSelect>>", lambda event: self.update_summary())
        self.account_menu = tk.Menu(self.root, tearoff=False)
        self.list_view.bind("<Button-3>", self.show_account_menu)
        self.list_view.bind("<Double-Button-1>", self.on_account_double_click)

        yscroll = tb.Scrollbar(frame, orient="vertical", command=self.list_view.yview)
        self.list_view.configure(yscrollcommand=yscroll.set)

        yscroll.pack(side="right", fill="y")
        self.list_view.pack(side="left", fill="both", expand=True)
        # Apply after ttkbootstrap has built its default table style.
        style = ttk.Style(self.root)
        style.configure("Accounts.Treeview", rowheight=40, font=("Microsoft YaHei UI", 10))
        style.configure("Accounts.Treeview.Heading", font=("Microsoft YaHei UI", 10, "bold"), padding=(10, 12))
        self.list_view.configure(style="Accounts.Treeview")

    def remove_client(self, client_id):
        self.clients.pop(client_id, None)
        self.accounts.pop(client_id, None)
        self.ports.pop(client_id, None)
        self.avatar_pending.discard(client_id)
        self.last_seen.pop(client_id, None)

        self.root.after(0, lambda c=client_id: self._remove_client_ui(c))

    def _remove_client_ui(self, client_id):
        if client_id in self.clients:
            return
        if self.list_view.exists(client_id):
            self.list_view.delete(client_id)
        self.avatar_photos.pop(client_id, None)
        self.update_summary()

    def update_summary(self):
        self.account_summary.set(f"已连接 {len(self.list_view.get_children())}  ·  已选中 {len(self.list_view.selection())}")

    def register_client_ui(self, client_id, name, fb_id, error="", avatar_data=None):
        if client_id not in self.clients:
            return
        values = (name, fb_id or "未识别", "识别失败" if error else "空闲", error)
        if self.list_view.exists(client_id):
            previous = self.list_view.item(client_id, "values")
            if len(previous) >= 4:
                values = (name, fb_id or previous[1], previous[2], previous[3])
            self.list_view.item(client_id, values=values, image=self.default_avatar)
            self.avatar_photos.pop(client_id, None)
        else:
            self.list_view.insert("", "end", iid=client_id, values=values, image=self.default_avatar)
        self.update_avatar_ui(client_id, avatar_data)
        self.update_summary()

    def update_avatar_ui(self, client_id, avatar_data):
        if not self.list_view.exists(client_id) or not avatar_data:
            return
        try:
            prefix = "data:image/png;base64,"
            if not isinstance(avatar_data, str) or not avatar_data.startswith(prefix) or len(avatar_data) > 65536:
                return
            encoded = avatar_data[len(prefix):]
            raw = base64.b64decode(encoded, validate=True)
            if raw[:8] != b"\x89PNG\r\n\x1a\n" or len(raw) < 24:
                return
            width, height = struct.unpack(">II", raw[16:24])
            if not (0 < width <= 64 and 0 < height <= 64):
                return
            photo = tk.PhotoImage(master=self.root, data=encoded, format="png")
            if max(width, height) > 36:
                factor = (max(width, height) + 35) // 36
                photo = photo.subsample(factor, factor)
        except (ValueError, tk.TclError):
            return
        self.avatar_photos[client_id] = photo
        self.list_view.item(client_id, image=photo)

    def get_item_id(self, item):
        return item if item in self.clients else None
    
    def get_item_name(self,item):
        return self.list_view.item(item,"values")[0]

    def selected_ports(self):
        return [ self.get_item_id(i) for i in self.list_view.selection()]
    
    def get_item_target(self,item):
        return self.get_item_id(item)

    def selected_targets(self):
        return [self.get_item_target(i) for i in self.list_view.selection()]

    def on_account_double_click(self, event):
        if self.list_view.identify_region(event.x, event.y) not in {"tree", "cell"}:
            return
        client_id = self.list_view.identify_row(event.y)
        if client_id and client_id in self.clients:
            self.locate_browser(client_id)
            return "break"

    def show_account_menu(self, event):
        client_id = self.list_view.identify_row(event.y)
        if not client_id or client_id not in self.clients:
            return
        if client_id not in self.list_view.selection():
            self.list_view.selection_set(client_id)
        self.list_view.focus(client_id)
        menu = self.account_menu
        menu.delete(0, "end")
        menu.add_command(label="定位浏览器", command=lambda: self.locate_browser(client_id))
        menu.add_separator()
        menu.add_command(label="查看执行详情", command=lambda: self.show_execution_detail(client_id))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def locate_browser(self, client_id):
        if client_id in self.clients:
            self.root.after_idle(lambda: self.send_browser_location(client_id))

    def send_browser_location(self, client_id):
        if client_id not in self.clients:
            return
        # Grant foreground activation only after the native popup menu closes.
        try:
            ctypes.windll.user32.AllowSetForegroundWindow(ctypes.c_uint32(0xFFFFFFFF))
        except (OSError, AttributeError):
            pass
        asyncio.run_coroutine_threadsafe(
            self.send(self.ports.get(client_id), client_id, {"action": "locate_browser"}), self.loop)

    def set_status(self, client_id, status):
        if self.list_view.exists(client_id):
            self.list_view.set(client_id, "state", status)
            self.list_view.set(client_id, "detail", "")
            self.list_view.item(client_id, tags=())

    def refresh(self):
        dead_clients = []

        # 检测关闭连接
        for client_id, ws in list(self.clients.items()):
            if ws.close_code is not None:
                dead_clients.append(client_id)

        # 移除失效客户端
        for client_id in dead_clients:
            self.remove_client(client_id)

        # 清理UI孤儿项
        for item in list(self.list_view.get_children()):
            if item not in self.clients:
                self.list_view.delete(item)
        self.update_summary()

    async def authenticated_handler(self, ws, port):
        if self.bridge_key is None:
            await ws.close(code=1011, reason="Native bridge unavailable")
            return
        try:
            connection = await authenticate(ws, self.bridge_key)
            if connection:
                await self.ws_handler(connection, port)
        except websockets.ConnectionClosed:
            pass

    async def ws_handler(self, ws, port):
        client_id = None
        try:
            async for msg in ws:
                data = json.loads(msg)
                if not isinstance(data, dict):
                    await ws.close(code=1008, reason="Object required")
                    return

                # 心跳包
                if data.get("type") == "heartbeat":
                    cid = data.get("client_id")
                    if cid == client_id and self.clients.get(cid) is ws:
                        self.last_seen[cid] = time.time()
                    continue

                # 2. 处理初始化 (自动添加)
                if data.get("type") == "init":
                    requested_id = data.get("client_id", "")
                    if (not isinstance(requested_id, str) or not 1 <= len(requested_id) <= 128
                            or not all(c.isascii() and (c.isalnum() or c in "-_") for c in requested_id)
                            or client_id is not None and requested_id != client_id
                            or self.clients.get(requested_id) not in (None, ws)):
                        await ws.close(code=1008, reason="Invalid or duplicate client ID")
                        return
                    client_id = requested_id
                    name = data.get("fb_name") or "未知用户"
                    name = str(name)[:200]
                    if not client_id: continue

                    # 登记数据
                    if self.clients.get(client_id) is not ws:
                        self.avatar_pending.discard(client_id)
                    self.clients[client_id] = ws
                    self.accounts[client_id] = {"fb_id": data.get("fb_id"), "profile_url": data.get("profile_url")}
                    self.ports[client_id] = port
                    self.last_seen[client_id] = time.time()

                    # 关键：使用 after 确保在 Tkinter 主线程更新 UI
                    display_id = data.get("fb_id") or data.get("fb_username")
                    identity_error = str(data.get("identity_error") or "")[:200]
                    avatar_data = data.get("avatar_data")
                    self.root.after(0, lambda c=client_id, n=name, f=display_id, e=identity_error, a=avatar_data: self.register_client_ui(c, n, f, e, a))
                    print("浏览器已连接")
                    if identity_error:
                        print(f"账号识别失败: {identity_error}")

                # 3. 处理状态更新
                elif data.get("type") == "status" and self.clients.get(client_id) is ws:
                    status_map = {"auto_main_page": "活跃首页", "auto_reels": "活跃Reels", "auto_group": "活跃小组", "auto_custom": "自定义活跃", "stop": "空闲", "cancel_friend_requests": "取消好友请求"}
                    new_status = status_map.get(data.get("status"))
                    if data.get("status") == "change_avatar":
                        new_status = "更换头像中"
                    if new_status and client_id:
                        self.root.after(0, lambda c=client_id, s=new_status: self.set_status(c, s))
                        if data.get("status") == "stop" and isinstance(data.get("stats"), dict):
                            self.root.after(0, lambda c=client_id, stats=data["stats"]: self.show_activity_stats(c, stats))
                    elif data.get("status") == "activity_error" and client_id:
                        detail = str(data.get("error") or "执行失败")[:200]
                        self.root.after(0, lambda c=client_id, e=detail: self.activity_error(c, e))
                        if isinstance(data.get("stats"), dict):
                            self.root.after(0, lambda c=client_id, stats=data["stats"], e=detail: self.show_activity_stats(c, stats, e))

                elif data.get("type") == "activity_detail" and client_id and self.clients.get(client_id) is ws:
                    detail = str(data.get("detail") or "")[:200]
                    self.root.after(0, lambda c=client_id, d=detail: self.set_activity_detail(c, d))

                elif data.get("type") == "avatar_result" and client_id and self.clients.get(client_id) is ws:
                    detail = str(data.get("error", ""))[:200]
                    if data.get("success") is True:
                        status = "头像更换成功" if data.get("confirmed") is True else "已提交保存，请核对头像"
                        if data.get("confirmed") is not True and detail:
                            status += f": {detail}"
                    else:
                        status = f"换头像失败: {detail}"
                    self.root.after(0, lambda c=client_id, s=status: self.finish_avatar(c, s))
                    avatar_data = data.get("avatar_data")
                    if data.get("success") is True and avatar_data:
                        self.root.after(0, lambda c=client_id, a=avatar_data: self.update_avatar_ui(c, a))

        except websockets.ConnectionClosed as e:
            print(f"连接关闭 code={e.code} reason={e.reason}")
        except Exception as e:
            print(f"连接异常: {type(e).__name__}")
        finally:
            if client_id and self.clients.get(client_id) is ws:
                print("浏览器已断开:", client_id)
                self.remove_client(client_id)

    async def start_server(self, port):
        if port in self.servers:
            return
        try:
            server = await websockets.serve(
                lambda ws: self.authenticated_handler(ws, port),
                "127.0.0.1",
                port,
                ping_interval=20,
                ping_timeout=60,
                process_request=check_origin,
                max_size=131072,
                max_queue=8,
                compression=None
            )
            self.servers[port] = server
        except Exception as e:
            print(f"启动端口 {port} 失败: {e}")

    def scan(self):
        for p in PORT_RANGE:
            asyncio.run_coroutine_threadsafe(
                self.start_server(p),
                self.loop
            )

    def schedule_config_save(self, *_):
        if self.config_timer:
            self.root.after_cancel(self.config_timer)
        self.config_timer = self.root.after(600, self.persist_configuration)

    def persist_configuration(self):
        self.config_timer = None
        self.configuration["avatar_directory"] = self.avatar_directory.get().strip()
        try:
            save_configuration(self.configuration)
            return True
        except OSError as error:
            messagebox.showerror("配置保存失败", f"无法写入软件目录下的 conf/config.json：\n{error}")
            return False

    def close_application(self):
        if self.theme_timer:
            self.root.after_cancel(self.theme_timer)
            self.theme_timer = None
        if self.config_timer:
            self.root.after_cancel(self.config_timer)
        self.persist_configuration()
        self.root.destroy()

    def choose_avatar_directory(self):
        directory = filedialog.askdirectory(parent=self.root, title="选择头像目录")
        if directory:
            self.avatar_directory.set(directory)

    def finish_avatar(self, client_id, status):
        self.avatar_pending.discard(client_id)
        success = status == "头像更换成功"
        unconfirmed = status.startswith("已提交保存，请核对头像")
        self.set_status(client_id, "头像已更新" if success else "待确认" if unconfirmed else "执行失败")
        if self.list_view.exists(client_id):
            self.list_view.set(client_id, "detail", status)
            self.list_view.item(client_id, tags=("success" if success else "" if unconfirmed else "error",))

    def change_avatar(self):
        targets = [cid for cid in self.selected_targets() if cid in self.clients and cid not in self.avatar_pending]
        if not targets:
            messagebox.showwarning("换头像", "请选择已连接且未在换头像的账号。", parent=self.root)
            return
        try:
            directory_text = self.avatar_directory.get().strip()
            if not directory_text:
                raise ValueError("请选择头像目录。")
            directory = Path(directory_text).expanduser().resolve(strict=True)
            if not directory.is_dir():
                raise ValueError("头像路径必须是目录。")
            images = [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} and path.stat().st_size > 0]
            if not images:
                raise ValueError("目录中没有 JPG、PNG 或 WebP 图片。")
        except (OSError, ValueError) as exc:
            messagebox.showerror("换头像", str(exc), parent=self.root)
            return
        if len(images) < len(targets):
            messagebox.showwarning(
                "头像数量不足",
                f"本次选择了 {len(targets)} 个账号，目录中只有 {len(images)} 张可用图片。\n"
                "将先随机分配不重复的图片，用完后重新打乱复用；部分账号的头像会重复。",
                parent=self.root)
        pool = []
        previous_image = None
        for client_id in targets:
            if not pool:
                pool = random.sample(images, len(images))
                if len(pool) > 1 and pool[-1] == previous_image:
                    pool[-1], pool[0] = pool[0], pool[-1]
            image = pool.pop()
            previous_image = image
            self.avatar_pending.add(client_id)
            self.set_status(client_id, "更换头像中")
            asyncio.run_coroutine_threadsafe(self.send_avatar(client_id, image), self.loop)

    async def send_avatar(self, client_id, image):
        try:
            ws = self.clients.get(client_id)
            if ws is None:
                raise ValueError("浏览器已断开连接")
            account = self.accounts.get(client_id, {})
            await ws.send(json.dumps({"action": "change_avatar", "file_path": str(image), "profile_url": account.get("profile_url")}))
        except Exception as exc:
            self.root.after(0, lambda c=client_id, s=f"发送失败: {exc}": self.finish_avatar(c, s))

    async def send(self,port,client_id,data):
        if client_id in self.avatar_pending and data.get("action") in {
                "scroll30", "auto_reels", "auto_group", "auto_custom", "cancel_friend_requests", "stop_scroll"}:
            self.root.after(0, lambda c=client_id: self.set_activity_detail(c, "换头像进行中，未执行其他任务，请完成后再试"))
            return
        ws = self.clients.get(client_id)
        if ws:
            try:
                await ws.send(json.dumps(data))
            except Exception as error:
                if data.get("action") != "locate_browser":
                    self.root.after(0, lambda c=client_id, e=str(error): self.activity_error(c, e))

    def activity_error(self, client_id, detail):
        self.set_status(client_id, "执行失败")
        if self.list_view.exists(client_id):
            self.list_view.set(client_id, "detail", detail)

    def set_activity_detail(self, client_id, detail):
        if self.list_view.exists(client_id):
            self.list_view.set(client_id, "detail", detail)

    def show_execution_detail(self, client_id):
        if not self.list_view.exists(client_id):
            return
        detail = str(self.list_view.set(client_id, "detail") or "暂无执行结果")
        messagebox.showinfo("执行详情", detail.replace("；", "\n"), parent=self.root)

    def show_activity_stats(self, client_id, stats, prefix=""):
        def count(group, kind):
            values = stats.get(group)
            value = values.get(kind, 0) if isinstance(values, dict) else 0
            return min(value, 100000) if type(value) is int and value >= 0 else 0
        results, uncertain = [], []
        for kind, label in (("like", "点赞"), ("comment", "评论"), ("share", "分享")):
            attempted = count("attempted", kind)
            confirmed = min(count("confirmed", kind), attempted)
            results.append(f"{label} {confirmed} 次")
            if attempted > confirmed:
                uncertain.append(f"{label} {attempted - confirmed} 次")
        detail = "；".join(results)
        if uncertain:
            detail += "（未确认：" + "、".join(uncertain) + "）"
        issues = stats.get("issues")
        reasons = []
        if isinstance(issues, dict):
            for kind, label in (("like", "点赞"), ("comment", "评论"), ("share", "分享")):
                issue = issues.get(kind)
                if min(count("confirmed", kind), count("attempted", kind)) == 0 and isinstance(issue, str) and issue:
                    reasons.append(f"{label}：{issue[:160]}")
        if reasons:
            detail += "；" + "；".join(reasons)
        issue = stats.get("issue")
        if isinstance(issue, str) and issue and not any(reason.endswith("：" + issue[:160]) for reason in reasons):
            detail += "；原因：" + issue[:160]
        if prefix:
            detail = prefix + "；" + detail
        self.set_activity_detail(client_id, detail)

    def scroll(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"scroll30"}),
                    self.loop
                )
    def auto_reels(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"auto_reels"}),
                    self.loop
                )
    def auto_group(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"auto_group"}),
                    self.loop
                )
    def auto_custom(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"auto_custom"}),
                    self.loop
                )

    def stop_scroll(self):
        for client_id in self.selected_targets():
            if client_id in self.avatar_pending:
                self.set_activity_detail(client_id, "换头像进行中，没有启动停止活跃操作")
                continue
            port = self.ports.get(client_id)
            if port is not None:
                self.set_status(client_id, "正在停止")
                self.root.after(10000, lambda c=client_id: self.check_stop_confirmation(c))
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"stop_scroll"}),
                    self.loop
                )

    def check_stop_confirmation(self, client_id):
        if self.list_view.exists(client_id) and self.list_view.set(client_id, "state") == "正在停止":
            self.activity_error(client_id, "未收到停止确认，请检查浏览器连接后再次停止")

    def cancel_requets(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"cancel_friend_requests"}),
                    self.loop
                )

    def check_alive(self):
        now = time.time()
        dead = []

        for cid, ws in list(self.clients.items()):
            if ws.close_code is not None or now - self.last_seen.get(cid, now) > 60:
                dead.append(cid)

        for cid in dead:
            print("心跳超时删除:", cid)
            self.remove_client(cid)
            self.last_seen.pop(cid, None)

        self.root.after(3000, self.check_alive)


def main():
    instance = SingleInstance()
    try:
        if not instance.claim():
            return
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("BrowserAgent.FBBridge")
        root = tb.Window(themename=system_theme_name(), iconphoto=None)
        App(root)
        instance.attach(root)
        root.mainloop()
    finally:
        instance.close()


if __name__ == "__main__":
    main()

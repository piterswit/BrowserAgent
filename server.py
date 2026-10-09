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
import traceback

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
        self.root.title("BrowserAgent · FB账号管理")
        self.root.geometry("1020x700")
        self.root.minsize(min(860, self.root.winfo_screenwidth() - 64), min(960, self.root.winfo_screenheight() - 100))
        self.root.style.theme_use("flatly")
        style = ttk.Style(self.root)
        style.configure(".", font=("Microsoft YaHei UI", 10))
        style.configure("Treeview", rowheight=40, font=("Microsoft YaHei UI", 10))
        style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 10, "bold"), padding=(10, 12))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Section.TLabel", font=("Microsoft YaHei UI", 11, "bold"))
        icon_folder = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "WS Browser Bridge" / "icon"
        if (icon_folder / "bridge-128.png").exists():
            self.window_icon = tk.PhotoImage(file=str(icon_folder / "bridge-128.png"))
            self.root.iconphoto(True, self.window_icon)
            self.header_icon = tk.PhotoImage(file=str(icon_folder / "bridge-32.png"))
        if (icon_folder / "bridge.ico").exists():
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

        self.build_ui()
        self.center_window()
        self.scan()
        self.root.after(3000, self.check_alive)

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
        tb.Label(header, text="BrowserAgent", style="Title.TLabel").pack(side="left")
        tb.Label(header, text="FB账号管理", bootstyle="secondary").pack(side="left", padx=16, pady=(8, 0))
        self.account_summary = tk.StringVar(value="已连接 0  ·  已选中 0")
        tb.Label(header, textvariable=self.account_summary, bootstyle="secondary").pack(side="right")
        tb.Separator(frm).pack(fill="x")

        tb.Label(frm, text="账号操作", style="Section.TLabel").pack(anchor="w", pady=(12, 10))
        btnf = tb.Frame(frm)
        btnf.pack(fill="x", pady=(0, 12))
        for text, command in (("首页活跃", self.scroll), ("Reels活跃", self.auto_reels), ("小组活跃", self.auto_group)):
            tb.Button(btnf, text=text, command=command, bootstyle="secondary-outline", padding=(14, 8)).pack(side="left", padx=(0, 8))
        tb.Button(btnf, text="停止活跃", command=self.stop_scroll, bootstyle="secondary", padding=(14, 8)).pack(side="left", padx=(0, 8))
        tb.Button(btnf, text="取消好友请求", command=self.cancel_requets, bootstyle="danger-outline", padding=(14, 8)).pack(side="right")

        avatar_frame = tb.Frame(frm)
        avatar_frame.pack(fill="x", pady=(0, 12))
        tb.Label(avatar_frame, text="头像目录").pack(side="left", padx=6)
        self.avatar_directory = tk.StringVar()
        tb.Entry(avatar_frame, textvariable=self.avatar_directory).pack(side="left", fill="x", expand=True)
        tb.Button(avatar_frame, text="选择目录", command=self.choose_avatar_directory, bootstyle="secondary-outline", padding=(12, 8)).pack(side="left", padx=8)
        tb.Button(avatar_frame, text="换头像", command=self.change_avatar, bootstyle="success", padding=(12, 8)).pack(side="left")

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
            self.list_view.item(client_id, values=values)
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

    async def ws_handler(self, ws, port):
        client_id = None
        try:
            async for msg in ws:
                data = json.loads(msg)

                # 心跳包
                if data.get("type") == "heartbeat":
                    cid = data.get("client_id")
                    if cid == client_id and self.clients.get(cid) is ws:
                        self.last_seen[cid] = time.time()
                    continue

                # 2. 处理初始化 (自动添加)
                if data.get("type") == "init":
                    client_id = data.get("client_id", "")
                    name = data.get("fb_name") or "未知用户"
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
                    print(f"浏览器已连接: {name} (ID: {client_id})")
                    if identity_error:
                        print(f"账号识别失败: {identity_error}")

                # 3. 处理状态更新
                elif data.get("type") == "status":
                    status_map = {"auto_main_page": "活跃首页", "auto_reels": "活跃Reels", "auto_group": "活跃小组", "stop": "空闲", "cancel_friend_requests": "取消好友请求"}
                    new_status = status_map.get(data.get("status"))
                    if data.get("status") == "change_avatar":
                        new_status = "更换头像中"
                    if new_status and client_id:
                        self.root.after(0, lambda c=client_id, s=new_status: self.set_status(c, s))

                elif data.get("type") == "avatar_result" and client_id:
                    detail = str(data.get("error", ""))[:200]
                    if data.get("success") is True:
                        status = "头像更换成功" if data.get("confirmed") is True else "已提交保存，请核对头像"
                    else:
                        status = f"换头像失败: {detail}"
                    self.root.after(0, lambda c=client_id, s=status: self.finish_avatar(c, s))
                    avatar_data = data.get("avatar_data")
                    if data.get("success") is True and avatar_data:
                        self.root.after(0, lambda c=client_id, a=avatar_data: self.update_avatar_ui(c, a))

        except websockets.ConnectionClosed as e:
            print(f"连接关闭 code={e.code} reason={e.reason}")
        except Exception as e:
            print(f"连接异常: {e}")
            traceback.print_exc()
        finally:
            if client_id and self.clients.get(client_id) is ws:
                print("浏览器已断开:", client_id)
                self.remove_client(client_id)

    async def start_server(self, port):
        if port in self.servers:
            return
        try:
            server = await websockets.serve(
                lambda ws: self.ws_handler(ws, port),
                "127.0.0.1",
                port,
                ping_interval=20,
                ping_timeout=60
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

    def choose_avatar_directory(self):
        directory = filedialog.askdirectory(parent=self.root, title="选择头像目录")
        if directory:
            self.avatar_directory.set(directory)

    def finish_avatar(self, client_id, status):
        self.avatar_pending.discard(client_id)
        success = status == "头像更换成功"
        unconfirmed = status == "已提交保存，请核对头像"
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
        for client_id in targets:
            image = random.choice(images)
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
        ws = self.clients.get(client_id)
        if ws:
            await ws.send(json.dumps(data))

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
    def stop_scroll(self):
        for client_id in self.selected_targets():
            port = self.ports.get(client_id)
            if port is not None:
                asyncio.run_coroutine_threadsafe(
                    self.send(port,client_id,{"action":"stop_scroll"}),
                    self.loop
                )
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
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("BrowserAgent.FBBridge")
    root = tb.Window(themename="flatly")
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()

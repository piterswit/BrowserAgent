# tk_ws_control.py
# pip install websockets

import asyncio
import json
import time
import threading
import tkinter as tk
from tkinter import ttk
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
        self.root.title("FB账号活跃")
        self.root.geometry("700x700")

        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

        self.servers = {}
        self.clients = {}
        self.ports_name = {}
        self.ports = {}
        self.last_seen = {}  # 心跳包

        self.build_ui()
        self.scan()
        self.root.after(10000, self.check_alive)

    def build_ui(self):
        frm = tb.Frame(self.root)
        frm.pack(fill="both", expand=True, padx=10, pady=10)

        btnf = tb.Frame(frm)
        btnf.pack(fill="x", pady=5)

        tb.Button(btnf, text="刷新", command=self.refresh).pack(side="left", padx=6)
        tb.Button(btnf, text="自动活跃", command=self.scroll).pack(side="left", padx=6)
        tb.Button(btnf, text="活跃Reels", command=self.auto_reels).pack(side="left", padx=6)
        tb.Button(btnf, text="活跃小组", command=self.auto_group).pack(side="left", padx=6)
        tb.Button(btnf, text="停止活跃", command=self.stop_scroll).pack(side="left", padx=6)

        frame = tb.Frame(frm)
        frame.pack(fill="both", expand=True, pady=5)

        self.list_view = tb.Treeview(
            frame,
            columns=("state", "name"),
            show="headings",
            selectmode="extended"
        )

        self.list_view.heading("state", text="状态")
        self.list_view.heading("name", text="名字")
        self.list_view.column("state", width=150, anchor="center")

        yscroll = tb.Scrollbar(frame, orient="vertical", command=self.list_view.yview)
        self.list_view.configure(yscrollcommand=yscroll.set)

        self.list_view.pack(side="left", fill="both", expand=True)
        yscroll.pack(side="right", fill="y")

    def remove_client(self, client_id):
        name = None
        # 找到名字
        for k, v in list(self.ports_name.items()):
            if v == client_id:
                name = k
                break

        # 删除数据
        if name:
            self.ports_name.pop(name, None)

        self.clients.pop(client_id, None)
        self.ports.pop(client_id, None)

        # 用名字删UI
        self.root.after(0, lambda n=name: self._remove_client_ui(n))

    def _remove_client_ui(self, name):
        for item in self.list_view.get_children():
            if self.get_item_name(item) == name:
                self.list_view.delete(item)
                break

    def get_item_id(self, item):
        return self.ports_name.get(self.list_view.item(item, "values")[1])
    
    def get_item_name(self,item):
        return self.list_view.item(item,"values")[1]

    def selected_ports(self):
        return [ self.get_item_id(i) for i in self.list_view.selection()]
    
    def get_item_target(self,item):
        name = self.list_view.item(item,"values")[1]
        return self.ports_name.get(name)

    def selected_targets(self):
        return [self.get_item_target(i) for i in self.list_view.selection()]

    def set_status(self, client_id, status):
        for item in self.list_view.get_children():
            if self.get_item_id(item) == client_id:
                self.list_view.item(item, values=(status, self.list_view.item(item, "values")[1]))
                break

    def delete_by_name(self, fb_name: str):
        client_id = self.ports_name.pop(fb_name, None)
        if not client_id:
            return

        # 删数据
        self.clients.pop(client_id, None)
        self.ports.pop(client_id, None)

        # 删UI
        for item in self.list_view.get_children():
            if self.get_item_name(item) == fb_name:
                self.list_view.delete(item)
                break

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
            name = self.get_item_name(item)
            client_id = self.ports_name.get(name)

            if client_id not in self.clients:
                self.list_view.delete(item)

    async def ws_handler(self, ws, port):
        client_id = None
        try:
            async for msg in ws:
                data = json.loads(msg)

                # 心跳包
                if data.get("type") == "heartbeat":
                    cid = data.get("client_id")
                    if cid:
                        self.last_seen[cid] = time.time()
                    continue

                # 2. 处理初始化 (自动添加)
                if data.get("type") == "init":
                    client_id = data.get("client_id", "")
                    name = data.get("fb_name", "未知用户")
                    if not client_id: continue

                    # 先清理同名旧连接，防止 UI 重复
                    self.delete_by_name(name)

                    # 登记数据
                    self.clients[client_id] = ws
                    self.ports_name[name] = client_id
                    self.ports[client_id] = port

                    # 关键：使用 after 确保在 Tkinter 主线程更新 UI
                    self.root.after(0, lambda n=name: self.list_view.insert("", "end", values=("空闲", n)))
                    print(f"浏览器已连接: {name} (ID: {client_id})")

                # 3. 处理状态更新
                elif data.get("type") == "status":
                    status_map = {"auto_main_page": "活跃首页", "auto_reels": "活跃Reels", "auto_group": "活跃小组", "stop": "空闲"}
                    new_status = status_map.get(data.get("status"))
                    if new_status and client_id:
                        self.root.after(0, lambda c=client_id, s=new_status: self.set_status(c, s))

        except websockets.ConnectionClosed as e:
            print(f"连接关闭 code={e.code} reason={e.reason}")
        except Exception as e:
            print(f"连接异常: {e}")
            traceback.print_exc()
        finally:
            if client_id:
                print("连接可能断开:", client_id)
                # 标记为失联
                self.last_seen[client_id] = 0

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

    def check_alive(self):
        now = time.time()
        dead = []

        for cid, t in list(self.last_seen.items()):
            if now - t > 60:  # 60秒没心跳
                dead.append(cid)

        for cid in dead:
            print("心跳超时删除:", cid)
            self.remove_client(cid)
            self.last_seen.pop(cid, None)

        self.root.after(10000, self.check_alive)


def main():
    root = tb.Window()
    App(root)
    style = ttk.Style()
    style.configure(".", font=("Microsoft YaHei UI", 10))
    style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 10, "bold"))
    style.configure(
        "Treeview",
        rowheight=30   # 行高，单位是像素，可自行调大
    )
    root.mainloop()


if __name__ == "__main__":
    main()

import tkinter as tk
from tkinter import ttk, messagebox

from post_manager import post_widget, center_window, bind_titlebar_theme
from task_settings import DEFAULT_TASK_SETTINGS, validate_task_settings


class SettingsDialog(tk.Toplevel):
    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.title("BrowserAgent · 设置")
        self.transient(app.root)
        self.minsize(540, 470)
        bind_titlebar_theme(self, app)
        center_window(self, app.root, 620, 500)
        settings = app.get_task_settings()
        self.minutes = tk.StringVar(self, str(settings["activity_minutes"]))
        self.limit = tk.StringVar(self, str(settings["cancel_request_limit"]))
        body = ttk.Frame(self, padding=24)
        body.pack(fill="both", expand=True)
        post_widget(ttk.Label, body, "PostTitle.TLabel", text="任务设置").pack(anchor="w")
        post_widget(ttk.Label, body, "PostHint.TLabel", text="保存后对下一次启动的任务生效。").pack(anchor="w", pady=(4, 20))
        self.add_field(body, "自动活跃时长", self.minutes, "分钟", "首页、小组、自定义及 Reels，范围 1–1440 分钟。")
        ttk.Separator(body).pack(fill="x", pady=18)
        self.add_field(body, "每次取消请求", self.limit, "个", "先滚动到底部，再从下往上取消，范围 1–1000 个。")
        footer = ttk.Frame(body)
        footer.pack(side="bottom", fill="x", pady=(20, 0))
        post_widget(ttk.Button, footer, "Post.TButton", text="恢复默认", command=self.restore,
                    padding=(12, 8)).pack(side="left")
        post_widget(ttk.Button, footer, "PostPrimary.TButton", text="保存设置", command=self.save,
                    padding=(18, 8)).pack(side="right")
        self.bind("<Escape>", lambda _event: self.destroy())
        self.bind("<Control-Return>", lambda _event: self.save())

    def add_field(self, parent, label, variable, unit, hint):
        row = ttk.Frame(parent)
        row.pack(fill="x")
        post_widget(ttk.Label, row, "PostLabel.TLabel", text=label).pack(side="left")
        post_widget(ttk.Label, row, "PostLabel.TLabel", text=unit, width=4).pack(side="right", padx=(8, 0))
        post_widget(ttk.Entry, row, "Post.TEntry", textvariable=variable, width=9,
                    justify="center").pack(side="right", ipady=4)
        post_widget(ttk.Label, parent, "PostHint.TLabel", text=hint).pack(anchor="w", pady=(8, 0))

    def restore(self):
        self.minutes.set(str(DEFAULT_TASK_SETTINGS["activity_minutes"]))
        self.limit.set(str(DEFAULT_TASK_SETTINGS["cancel_request_limit"]))

    def save(self):
        try:
            settings = validate_task_settings({"activity_minutes": self.minutes.get(), "cancel_request_limit": self.limit.get()})
        except ValueError as error:
            messagebox.showwarning("检查设置", str(error), parent=self)
            return
        if self.app.save_task_settings(settings):
            self.destroy()

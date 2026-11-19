import random
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from platform_support import font_family


CAPTIONS = (
    "A little moment from today.",
    "Finding joy in the little things.",
    "A simple moment worth keeping.",
    "Taking a moment to slow down.",
    "A small highlight from my day.",
    "Making time for what matters.",
    "Enjoying the moment as it comes.",
    "A little glimpse into my day.",
    "Sometimes the simple things are the best.",
    "One of those moments I wanted to remember.",
    "Sharing a small piece of my day.",
    "Making the most of today.",
    "Taking it one day at a time.",
    "Here's to more moments like this.",
    "A little pause in the middle of the day.",
    "The little things add up.",
    "A moment to stop and look around.",
    "Saving this one for the memories.",
    "A quiet moment worth sharing.",
    "Life lately, one photo at a time.",
    "Keeping it simple today.",
    "A little reminder to enjoy the present.",
    "Making room for the good moments.",
    "A small moment with a story of its own.",
    "A photo for the memory book.",
    "Finding a moment to take it all in.",
    "Just a snapshot of life lately.",
    "Taking the day as it comes.",
    "A moment I'd like to come back to.",
    "Here and now.",
)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_SIZE = 20 * 1024 * 1024

POST_COLORS = {
    "light": {
        "text": "#1B293B", "muted": "#465569", "field": "#F5F7FB", "border": "#758297",
        "header": "#E8EDF4", "selected": "#DDEAFE", "selected_text": "#173765",
        "button": "#E8EDF4", "hover": "#D8E3F0", "primary": "#17458D",
        "primary_hover": "#123468", "primary_text": "#FFFFFF",
        "disabled": "#DCE2EB", "disabled_text": "#455467",
    },
    "dark": {
        "text": "#F1F5FC", "muted": "#C5D0DE", "field": "#222B38", "border": "#8293A9",
        "header": "#303C4C", "selected": "#264D80", "selected_text": "#FFFFFF",
        "button": "#354354", "hover": "#45576C", "primary": "#91BBFF",
        "primary_hover": "#B5D2FF", "primary_text": "#14243B",
        "disabled": "#303A49", "disabled_text": "#BAC7D9",
    },
}


def post_widget(widget_type, parent, style, **options):
    widget = widget_type(parent, **options)
    # ttkbootstrap normalizes custom style names passed to widget constructors.
    widget.tk.call(str(widget), "configure", "-style", style)
    return widget


def available_images(folder):
    images = []
    for path in folder.iterdir():
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        try:
            if path.is_file() and 0 < path.stat().st_size <= MAX_IMAGE_SIZE:
                images.append(path)
        except OSError:
            continue
    return images


def shuffled_cycles(items):
    last = None
    while items:
        batch = random.sample(items, len(items))
        if len(batch) > 1 and batch[0] == last:
            batch[0], batch[1] = batch[1], batch[0]
        yield from batch
        last = batch[-1]


def center_window(window, parent, width, height):
    screen_width = parent.winfo_screenwidth()
    screen_height = parent.winfo_screenheight()
    width = min(width, screen_width - 40)
    height = min(height, screen_height - 90)
    x = max(0, min(parent.winfo_rootx() + (parent.winfo_width() - width) // 2, screen_width - width))
    y = max(0, min(parent.winfo_rooty() + (parent.winfo_height() - height) // 2, screen_height - height - 60))
    window.geometry(f"{width}x{height}+{x}+{y}")


def bind_titlebar_theme(window, app):
    def on_map(event):
        if event.widget is window:
            app.apply_titlebar_theme(window)

    window.bind("<Map>", on_map, add="+")


class CaptionManager(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.manager = parent
        self.title("预设文案")
        self.transient(parent)
        bind_titlebar_theme(self, parent.app)
        center_window(self, parent, 680, 700)
        self.minsize(495, min(510, self.winfo_screenheight() - 90))
        self.editing = None
        panel = ttk.Frame(self, padding=20)
        panel.pack(fill="both", expand=True)
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(1, weight=1)
        heading = ttk.Frame(panel)
        heading.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        post_widget(ttk.Label, heading, "PostTitle.TLabel", text="预设文案").pack(side="left")
        post_widget(ttk.Button, heading, "Post.TButton", text="新增文案",
                    command=self.new_caption, padding=(10, 5)).pack(side="right")
        listing = ttk.Frame(panel)
        listing.grid(row=1, column=0, sticky="nsew")
        self.items = post_widget(ttk.Treeview, listing, "Post.Treeview", columns=("text",),
                                 show="headings", selectmode="browse", height=6)
        self.items.heading("text", text="发布时随机选用")
        self.items.column("text", width=490, minwidth=170)
        scrollbar = ttk.Scrollbar(listing, orient="vertical", command=self.items.yview)
        self.items.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.items.pack(side="left", fill="both", expand=True)
        self.items.bind("<<TreeviewSelect>>", self.select_caption)
        edit_area = ttk.Frame(panel)
        edit_area.grid(row=2, column=0, sticky="ew", pady=(10, 8))
        self.editor = tk.Text(edit_area, height=5, wrap="word", padx=8, pady=6, undo=True,
                              font=(font_family(), 11), highlightthickness=1, borderwidth=0)
        edit_scrollbar = ttk.Scrollbar(edit_area, orient="vertical", command=self.editor.yview)
        self.editor.configure(yscrollcommand=edit_scrollbar.set)
        edit_scrollbar.pack(side="right", fill="y")
        self.editor.pack(side="left", fill="x", expand=True)
        self.editor.bind("<<ThemeChanged>>", self.apply_editor_theme)
        self.apply_editor_theme()
        actions = ttk.Frame(panel)
        actions.grid(row=3, column=0, sticky="ew")
        self.edit_label = post_widget(ttk.Label, actions, "PostHint.TLabel")
        self.edit_label.pack(side="left")
        post_widget(ttk.Button, actions, "PostPrimary.TButton", text="保存文案",
                    command=self.save_caption, padding=(12, 6)).pack(side="right")
        post_widget(ttk.Button, actions, "Post.TButton", text="删除选中",
                    command=self.delete_caption, padding=(12, 6)).pack(side="right", padx=(0, 8))
        self.reload(0)

    def apply_editor_theme(self, _event=None):
        theme = self.manager.app.root.style.theme_use()
        color = POST_COLORS["dark" if theme == "darkly" else "light"]
        self.editor.configure(background=color["field"], foreground=color["text"],
                              insertbackground=color["text"], highlightbackground=color["border"],
                              highlightcolor=color["primary"], selectbackground=color["selected"],
                              selectforeground=color["selected_text"])

    def reload(self, selected):
        self.items.delete(*self.items.get_children())
        for index, text in enumerate(self.manager.captions):
            self.items.insert("", "end", iid=str(index), values=(" ".join(text.split()),))
        self.items.selection_set(str(selected))
        self.items.see(str(selected))
        self.select_caption()

    def select_caption(self, _event=None):
        selection = self.items.selection()
        if selection and int(selection[0]) != self.editing:
            self.editing = int(selection[0])
            self.set_editor(self.manager.captions[self.editing], f"编辑第 {self.editing + 1} 条文案")

    def set_editor(self, text, label):
        self.editor.delete("1.0", "end")
        self.editor.insert("1.0", text)
        self.editor.edit_reset()
        self.edit_label.configure(text=label)

    def new_caption(self):
        self.items.selection_remove(self.items.selection())
        self.editing = None
        self.set_editor("", "新增文案")
        self.editor.focus_set()

    def save_caption(self):
        text = self.editor.get("1.0", "end-1c").strip()
        captions = self.manager.captions
        if not text or len(text) > 5000:
            messagebox.showwarning("检查文案", "请输入 1 到 5000 个字符。", parent=self)
            return
        if text in captions and captions.index(text) != self.editing:
            messagebox.showinfo("文案已存在", "请选择不同的文案。", parent=self)
            return
        index = self.editing
        if index is None:
            if len(captions) >= 200:
                messagebox.showinfo("预设文案已满", "最多可保存 200 条文案。", parent=self)
                return
            index = len(captions)
        captions[index:index + 1] = [text]
        self.manager.save_captions()
        self.editing = None
        self.reload(index)
        self.edit_label.configure(text="已保存")

    def delete_caption(self):
        if self.editing is None:
            return
        captions = self.manager.captions
        if len(captions) == 1:
            messagebox.showwarning("保留预设文案", "至少保留一条文案供发布时使用。", parent=self)
            return
        if messagebox.askyesno("删除文案", "删除选中的预设文案？", parent=self):
            index = self.editing
            del captions[index]
            self.manager.save_captions()
            self.editing = None
            self.reload(min(index, len(captions) - 1))


class PostManager(tk.Toplevel):
    @staticmethod
    def configure_styles(style, dark):
        color = POST_COLORS["dark" if dark else "light"]
        style.configure("PostTitle.TLabel", foreground=color["text"], font=(font_family(), 20, "normal"))
        style.configure("PostLabel.TLabel", foreground=color["text"], font=(font_family(), 11, "normal"))
        style.configure("PostHint.TLabel", foreground=color["muted"])
        for name, fill, ink, hover in (
            ("Post.TButton", color["button"], color["text"], color["hover"]),
            ("PostPrimary.TButton", color["primary"], color["primary_text"], color["primary_hover"]),
        ):
            style.configure(name, background=fill, foreground=ink, bordercolor=color["border"],
                            lightcolor=fill, darkcolor=fill, focuscolor=ink, borderwidth=1)
            fill_states = [("disabled", color["disabled"]), ("pressed", hover), ("active", hover), ("!disabled", fill)]
            style.map(name, background=fill_states, lightcolor=fill_states, darkcolor=fill_states,
                      foreground=[("disabled", color["disabled_text"]), ("!disabled", ink)],
                      bordercolor=[("focus", ink), ("!focus", color["border"])])
        style.configure("Post.TEntry", fieldbackground=color["field"], foreground=color["text"],
                        bordercolor=color["border"], lightcolor=color["field"], darkcolor=color["field"])
        style.map("Post.TEntry", fieldbackground=[("readonly", color["field"])],
                  foreground=[("readonly", color["text"])], bordercolor=[("readonly", color["border"])])
        style.configure("Post.Treeview", background=color["field"], fieldbackground=color["field"],
                        foreground=color["text"], rowheight=42, bordercolor=color["border"])
        style.map("Post.Treeview", background=[("selected", color["selected"])],
                  foreground=[("selected", color["selected_text"])])
        style.configure("Post.Treeview.Heading", background=color["header"], foreground=color["text"],
                        relief="flat", font=(font_family(), 10, "normal"))
        style.map("Post.Treeview.Heading", background=[("active", color["header"])],
                  foreground=[("active", color["text"])])

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.title("BrowserAgent · 批量发帖")
        self.minsize(650, 470)
        self.transient(app.root)
        bind_titlebar_theme(self, app)
        center_window(self, app.root, 1160, 800)
        saved_folder = app.configuration.get("post_image_directory")
        self.folder = Path(saved_folder) if isinstance(saved_folder, str) and saved_folder else None
        self.account_snapshot = None
        self.account_timer = None
        self.caption_window = None
        stored = app.configuration.get("post_captions")
        cleaned = (text.strip() for text in stored if isinstance(text, str)) if isinstance(stored, list) else ()
        self.captions = list(dict.fromkeys(text for text in cleaned if 0 < len(text) <= 5000))[:200] or list(CAPTIONS)
        self.caption_count = tk.StringVar(self, f"{len(self.captions)} 条文案")

        body = ttk.Frame(self, padding=22)
        body.pack(fill="both", expand=True)
        heading = ttk.Frame(body)
        heading.pack(fill="x", pady=(0, 17))
        post_widget(ttk.Label, heading, "PostTitle.TLabel", text="批量发帖").pack(side="left")
        post_widget(ttk.Button, heading, "Post.TButton", text="预设文案…",
                    command=self.open_captions, padding=(12, 6)).pack(side="right")
        post_widget(ttk.Label, heading, "PostHint.TLabel", textvariable=self.caption_count).pack(side="right", padx=10)

        post_widget(ttk.Label, body, "PostLabel.TLabel", text="1. 选择图片文件夹").pack(anchor="w")
        folder_row = ttk.Frame(body)
        folder_row.pack(fill="x", pady=(6, 4))
        self.folder_text = tk.StringVar(self, str(self.folder) if self.folder else "尚未选择文件夹")
        self.folder_entry = post_widget(ttk.Entry, folder_row, "Post.TEntry", textvariable=self.folder_text, state="readonly")
        self.folder_entry.pack(side="left", fill="x", expand=True, ipady=4)
        post_widget(ttk.Button, folder_row, "Post.TButton", text="选择文件夹…",
                    command=self.choose_folder, padding=(12, 6)).pack(side="left", padx=(8, 0))
        self.folder_hint = post_widget(ttk.Label, body, "PostHint.TLabel",
                                       text="JPG、PNG、WebP，每张最多 20 MB")
        self.folder_hint.pack(anchor="w")
        ttk.Separator(body).pack(fill="x", pady=13)

        footer = ttk.Frame(body)
        footer.pack(side="bottom", fill="x", pady=(12, 0))
        self.selection_label = post_widget(ttk.Label, footer, "PostHint.TLabel")
        self.selection_label.pack(side="left")
        self.publish_button = post_widget(ttk.Button, footer, "PostPrimary.TButton", text="发布",
                                          command=self.publish, padding=(18, 8))
        self.publish_button.pack(side="right")

        account_header = ttk.Frame(body)
        account_header.pack(fill="x", pady=(0, 7))
        post_widget(ttk.Label, account_header, "PostLabel.TLabel", text="2. 选择发布账号").pack(side="left")
        post_widget(ttk.Button, account_header, "Post.TButton", text="全选可用账号",
                    command=self.select_available, padding=(10, 4)).pack(side="right")
        table = ttk.Frame(body)
        table.pack(fill="both", expand=True)
        self.accounts = post_widget(ttk.Treeview, table, "Post.Treeview", columns=("name", "identity", "state", "detail"),
                                    show="tree headings", selectmode="extended", height=10)
        scrollbar = ttk.Scrollbar(table, orient="vertical", command=self.accounts.yview)
        self.accounts.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.accounts.pack(side="left", fill="both", expand=True)
        self.accounts.heading("#0", text="头像")
        self.accounts.column("#0", width=64, minwidth=64, stretch=False, anchor="center")
        for column, label, size in (("name", "账号名称", 180), ("identity", "FB ID / 用户名", 160),
                                    ("state", "状态", 125), ("detail", "执行结果", 270)):
            self.accounts.heading(column, text=label)
            self.accounts.column(column, width=size, minwidth=85)
        self.accounts.bind("<<TreeviewSelect>>", self.update_selection)
        self.accounts.bind("<Double-1>", self.show_account_detail)
        if self.folder:
            self.folder_entry.xview_moveto(1)
            self.read_images(self.folder, notify=False)
        self.refresh_accounts(app.selected_targets())
        self.account_timer = self.after(800, self.watch_accounts)

    def refresh_accounts(self, selection=None):
        view = self.app.list_view
        rows = []
        for cid in view.get_children():
            if cid in self.app.clients:
                name, identity, state, detail = view.item(cid, "values")
                if not self.app.accounts.get(cid, {}).get("profile_url"):
                    state = "身份未确认"
                avatar = self.app.avatar_photos.get(cid, self.app.default_avatar)
                rows.append((cid, str(avatar), name, identity, state, detail))
        if rows != self.account_snapshot:
            selected = self.accounts.selection() if selection is None else selection
            current = set(self.accounts.get_children())
            for cid, avatar, *values in rows:
                if cid in current:
                    self.accounts.item(cid, image=avatar, values=values)
                    current.remove(cid)
                else:
                    self.accounts.insert("", "end", iid=cid, image=avatar, values=values)
            self.accounts.delete(*current)
            self.accounts.selection_set([cid for cid in selected if cid and self.accounts.exists(cid)])
            self.account_snapshot = rows
        self.update_selection()

    def watch_accounts(self):
        self.refresh_accounts()
        self.account_timer = self.after(800, self.watch_accounts)

    def destroy(self):
        if self.account_timer is not None:
            self.after_cancel(self.account_timer)
        super().destroy()

    def select_available(self):
        self.accounts.selection_set([cid for cid in self.accounts.get_children() if self.app.post_available(cid)])

    def open_captions(self):
        if self.caption_window is not None and self.caption_window.winfo_exists():
            self.caption_window.lift()
            self.caption_window.focus_set()
        else:
            self.caption_window = CaptionManager(self)

    def save_captions(self):
        self.app.configuration["post_captions"] = list(self.captions)
        self.app.schedule_config_save()
        self.caption_count.set(f"{len(self.captions)} 条文案")

    def update_selection(self, _event=None):
        selected = self.accounts.selection()
        available = sum(self.app.post_available(cid) for cid in selected)
        self.selection_label.configure(text=f"已选 {len(selected)} 个账号 · 可发布 {available} 个")
        self.publish_button.configure(state="normal" if self.folder and available else "disabled")

    def show_account_detail(self, event):
        cid = self.accounts.identify_row(event.y)
        if cid and self.app.list_view.exists(cid):
            detail = self.app.list_view.set(cid, "detail")
            if detail:
                messagebox.showinfo("账号执行详情", detail, parent=self)

    def read_images(self, folder, *, notify=True):
        try:
            images = available_images(folder)
        except OSError as error:
            self.folder_hint.configure(text="无法读取图片文件夹，请检查路径或重新选择。")
            if notify:
                messagebox.showerror("无法读取文件夹", str(error), parent=self)
            return []
        self.folder_hint.configure(text=f"找到 {len(images)} 张可用图片")
        if not images and notify:
            messagebox.showwarning("没有可用图片", "请放入 JPG、PNG 或 WebP 图片，每张最多 20 MB。", parent=self)
        return images

    def choose_folder(self):
        value = filedialog.askdirectory(parent=self, title="选择发帖图片文件夹", mustexist=True)
        if not value:
            return
        self.folder = Path(value)
        self.app.configuration["post_image_directory"] = str(self.folder)
        self.app.schedule_config_save()
        self.folder_text.set(str(self.folder))
        self.folder_entry.xview_moveto(1)
        self.read_images(self.folder)
        self.update_selection()

    def publish(self):
        selected = self.accounts.selection()
        targets = [cid for cid in selected if self.app.post_available(cid)]
        if not self.folder or not targets:
            self.refresh_accounts()
            return
        images = self.read_images(self.folder)
        if not images:
            return
        profiles = {cid: self.app.accounts.get(cid, {}).get("profile_url") for cid in targets}
        count = len(targets)
        summary = [f"将向 {count} 个账号各发布一张随机图片和一条预设文案。"]
        if count > len(images):
            summary.append("图片数量少于账号数，用完后会重新打乱复用。")
        if len(selected) > count:
            summary.append(f"跳过 {len(selected) - count} 个当前不可用的账号。")
        if not messagebox.askyesno("确认发布", "\n".join(summary), parent=self):
            return
        assignments = [
            (cid, caption, profiles[cid], image)
            for cid, caption, image in zip(targets, shuffled_cycles(self.captions), shuffled_cycles(images))
        ]
        if not self.app.start_post(assignments):
            messagebox.showwarning("账号状态已变化", "请检查账号状态后再次发布。", parent=self)
        self.refresh_accounts()

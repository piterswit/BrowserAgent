"""One desktop window per Windows user/session, activated through a named event."""
import ctypes
from ctypes import wintypes
import hashlib
from pathlib import Path


class SingleInstance:
    def __init__(self, name="BrowserAgent.FBBridge"):
        suffix = hashlib.sha256(str(Path.home()).casefold().encode("utf-8")).hexdigest()[:24]
        self.name = f"Local\\{name}.{suffix}"
        self.window_property = f"{name}.Window.{suffix}"
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateEventW.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.SetEvent.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.user.GetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
        self.user.GetPropW.restype = wintypes.HANDLE
        self.user.SetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.HANDLE]
        self.user.RemovePropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
        self.user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        self.user.GetAncestor.restype = wintypes.HWND
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
        self.user.IsIconic.argtypes = [wintypes.HWND]
        self.user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.SetForegroundWindow.argtypes = [wintypes.HWND]
        self.callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user.EnumWindows.argtypes = [self.callback_type, wintypes.LPARAM]
        self.mutex = self.event = None
        self.root = self.window = self.timer = None
        self.primary = False

    def claim(self):
        ctypes.set_last_error(0)
        self.mutex = self.kernel.CreateMutexW(None, False, self.name)
        error = ctypes.get_last_error()
        if not self.mutex:
            raise ctypes.WinError(error)
        self.primary = error != 183  # ERROR_ALREADY_EXISTS
        self.event = self.kernel.CreateEventW(None, False, False, self.name + ".Activate")
        if not self.event:
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)
        if not self.primary:
            self.notify()
        return self.primary

    def find_window(self):
        found = []
        @self.callback_type
        def visit(window, _):
            if self.user.GetPropW(window, self.window_property):
                found.append(window)
                return False
            return True
        self.user.EnumWindows(visit, 0)
        return found[0] if found else None

    def notify(self):
        window = self.find_window()
        if window:
            process = wintypes.DWORD()
            self.user.GetWindowThreadProcessId(window, ctypes.byref(process))
            # The user-launched second instance grants foreground access only to the first.
            if process.value:
                self.user.AllowSetForegroundWindow(process.value)
        self.kernel.SetEvent(self.event)

    def attach(self, root):
        self.root = root
        root.update_idletasks()
        self.window = self.user.GetAncestor(root.winfo_id(), 2)
        if not self.user.SetPropW(self.window, self.window_property, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        self.timer = root.after(0, self.poll)

    def poll(self):
        if self.event is None:
            return
        if self.kernel.WaitForSingleObject(self.event, 0) == 0:
            self.activate()
        self.timer = self.root.after(100, self.poll)

    def activate(self):
        if self.user.IsIconic(self.window):
            self.user.ShowWindow(self.window, 9)  # SW_RESTORE
        self.root.deiconify()
        self.root.lift()
        self.user.SetForegroundWindow(self.window)
        self.root.focus_force()

    def close(self):
        if self.root and self.timer:
            try:
                self.root.after_cancel(self.timer)
            except Exception:
                pass  # Tk may already have been destroyed by the normal close handler.
        if self.window:
            self.user.RemovePropW(self.window, self.window_property)
            self.window = None
        for attribute in ("event", "mutex"):
            handle = getattr(self, attribute)
            if handle:
                self.kernel.CloseHandle(handle)
                setattr(self, attribute, None)

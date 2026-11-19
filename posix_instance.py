"""Per-user flock singleton and activation notification for macOS/Linux."""
import hashlib
import os
from pathlib import Path
import stat
import time

from platform_support import user_data_directory


def private_directory(folder):
    folder = Path(folder)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise OSError("Application state directory is not owned by the current user")
    folder.chmod(0o700)
    return folder


def private_open(path):
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise OSError("Unsafe application state file")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class PosixSingleInstance:
    def __init__(self, name="BrowserAgent.FBBridge", directory=None):
        self.folder = private_directory(directory or user_data_directory() / "instance")
        self.digest = hashlib.sha256(name.encode()).hexdigest()[:24]
        self.signal = self.folder / (self.digest + ".activate")
        self.descriptor = None
        self.root = self.timer = None
        self.primary = False
        self.observed = None

    def token(self):
        try:
            return self.signal.stat().st_mtime_ns
        except FileNotFoundError:
            return None

    def claim(self):
        import fcntl
        self.descriptor = private_open(self.folder / (self.digest + ".lock"))
        try:
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.notify()
            return False
        self.primary = True
        self.observed = self.token()
        return True

    def notify(self):
        descriptor = private_open(self.signal)
        try:
            os.utime(descriptor, ns=(time.time_ns(), time.time_ns()))
        finally:
            os.close(descriptor)

    def attach(self, root):
        self.root = root
        self.timer = root.after(0, self.poll)

    def poll(self):
        token = self.token()
        if token != self.observed:
            self.observed = token
            self.activate()
        self.timer = self.root.after(150, self.poll)

    def activate(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def close(self):
        if self.root is not None and self.timer is not None:
            try:
                self.root.after_cancel(self.timer)
            except Exception:
                pass
            self.timer = None
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None

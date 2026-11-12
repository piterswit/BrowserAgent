"""Windowed launcher for running BrowserAgent from source on Windows."""

import ctypes
from pathlib import Path
import subprocess
import sys


def launch():
    script = Path(__file__).resolve()
    if sys.prefix == sys.base_prefix:
        for environment in (".venv311", ".venv"):
            pythonw = script.parent / environment / "Scripts" / "pythonw.exe"
            if pythonw.is_file():
                subprocess.Popen([str(pythonw), str(script), *sys.argv[1:]],
                                 cwd=script.parent, creationflags=subprocess.CREATE_NO_WINDOW)
                return

    from server import main
    main()


if __name__ == "__main__":
    try:
        launch()
    except (ImportError, OSError) as error:
        ctypes.windll.user32.MessageBoxW(
            None, f"无法启动 BrowserAgent。\n请检查项目虚拟环境和依赖是否已安装。\n\n{error}",
            "BrowserAgent", 0x10,
        )

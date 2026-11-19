"""Windowed launcher for running BrowserAgent from source on Windows."""

import ctypes
from pathlib import Path
import subprocess
import sys


def launch():
    script = Path(__file__).resolve()
    if sys.prefix == sys.base_prefix:
        for environment in (".venv311", ".venv"):
            pythonw = script.parent / environment / ("Scripts/pythonw.exe" if sys.platform == "win32" else "bin/python")
            if pythonw.is_file():
                options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
                subprocess.Popen([str(pythonw), str(script), *sys.argv[1:]],
                                 cwd=script.parent, **options)
                return

    from server import main
    main()


if __name__ == "__main__":
    try:
        launch()
    except (ImportError, OSError) as error:
        message = f"无法启动 BrowserAgent。\n请检查 Python、Tk 和项目依赖是否已安装。\n\n{error}"
        if sys.platform == "win32":
            ctypes.windll.user32.MessageBoxW(None, message, "BrowserAgent", 0x10)
        else:
            print(message, file=sys.stderr)

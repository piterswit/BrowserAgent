import json
import os
import sys
import tempfile
from pathlib import Path
from platform_support import user_data_directory


def application_directory():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def configuration_folder(directory=None):
    base = Path(directory) if directory is not None else application_directory() if sys.platform == "win32" else user_data_directory()
    return base / "conf"


def load_configuration(directory=None):
    path = configuration_folder(directory) / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_configuration(data, directory=None):
    folder = configuration_folder(directory)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=folder,
                                         suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, folder / "config.json")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)

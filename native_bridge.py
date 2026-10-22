"""Windows per-user Native Messaging bootstrap, shared by GUI and console host."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import struct
import subprocess
import sys
import tempfile

HOST_NAME = "com.browseragent.bridge"
EXTENSION_ID = "hckjfiinhjpgdenpmcgeafkajechobmf"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}/"
ENTROPY = b"BrowserAgent.NativeBridge.v1"
MAX_REQUEST = 4096


def state_directory():
    if sys.platform != "win32":
        raise OSError("Native bridge requires Windows")
    return Path(os.environ["LOCALAPPDATA"]) / "BrowserAgent" / "NativeBridge"


class DataBlob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def protect_data(data, decrypt=False):
    """Use current-user DPAPI, with no UI or machine-wide decryption scope."""
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    local_free = kernel.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p
    raw = ctypes.create_string_buffer(data)
    salt = ctypes.create_string_buffer(ENTROPY)
    source = DataBlob(len(data), ctypes.cast(raw, ctypes.POINTER(ctypes.c_ubyte)))
    entropy = DataBlob(len(ENTROPY), ctypes.cast(salt, ctypes.POINTER(ctypes.c_ubyte)))
    result = DataBlob()
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.POINTER(DataBlob),
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob)]
    operation.restype = wintypes.BOOL
    if not operation(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        local_free(result.data)


def atomic_write(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = handle.name
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def load_secret(folder=None):
    path = Path(folder or state_directory()) / "credential.dpapi"
    if path.stat().st_size > 8192:
        raise ValueError("Invalid credential size")
    secret = protect_data(path.read_bytes(), decrypt=True)
    if len(secret) != 32:
        raise ValueError("Invalid credential")
    return secret.hex()


def ensure_secret(folder=None):
    folder = Path(folder or state_directory())
    folder.mkdir(parents=True, exist_ok=True)
    # Serialize creation across independent desktop instances. The host only reads.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    digest = hashlib.sha256(str(folder.resolve()).lower().encode()).hexdigest()[:24]
    handle = kernel.CreateMutexW(None, False, "Local\\BrowserAgent.Bridge." + digest)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(handle, 5000) in (0, 0x80)
        if not acquired:
            raise OSError("Credential initialization busy")
        path = folder / "credential.dpapi"
        if not path.exists():
            atomic_write(path, protect_data(secrets.token_bytes(32)))
        # Corrupt credentials fail closed instead of silently rotating a running app's key.
        return load_secret(folder)
    finally:
        if acquired:
            kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


def source_native_host(folder):
    """Compile a cached windowless host directly, never register a shell launcher."""
    source = Path(__file__).resolve().parent / "native_host" / "BridgeHost.cs"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    output = folder / f"FB_bridge_host-{digest}.exe"
    if output.is_file() and output.stat().st_size > 0:
        return output
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    if not compiler.is_file():
        compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework/v4.0.30319/csc.exe"
    if not compiler.is_file():
        raise OSError("Windows .NET Framework C# compiler unavailable")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, suffix=".exe", delete=False) as handle:
            temporary = Path(handle.name)
        result = subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:anycpu",
            "/optimize+", "/debug-", "/warnaserror+", "/reference:System.Security.dll",
            "/reference:System.Runtime.Serialization.dll", f"/out:{temporary}", str(source)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
        if result.returncode:
            raise OSError("Unable to build windowless Native Messaging host")
        os.replace(temporary, output)
        return output
    except subprocess.TimeoutExpired as error:
        raise OSError("Native host compiler timed out") from error
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def prepare_native_bridge(folder=None, executable=None, frozen=None):
    """Register the host in HKCU on startup, repairing paths after a move."""
    import winreg
    folder = Path(folder or state_directory())
    secret = ensure_secret(folder)
    frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    executable = Path(executable or sys.executable).resolve()
    if frozen:
        host_path = executable.parent / "conf" / "FB_bridge_host.exe"
        if not host_path.is_file():
            raise OSError("Missing conf/FB_bridge_host.exe")
    else:
        host_path = source_native_host(folder)
    manifest = {"name": HOST_NAME, "description": "BrowserAgent automatic bridge authentication",
                "path": str(host_path), "type": "stdio", "allowed_origins": [EXTENSION_ORIGIN]}
    manifest_path = folder / "host.json"
    atomic_write(manifest_path, json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    # Both registry views are written because Chrome queries the 32-bit view first.
    for browser in (r"Software\Google\Chrome", r"Software\Microsoft\Edge", r"Software\Chromium"):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,
                    browser + "\\NativeMessagingHosts\\" + HOST_NAME, 0, winreg.KEY_SET_VALUE | view) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    return secret


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        part = stream.read(size - len(data))
        if not part:
            raise ValueError("Truncated native message")
        data.extend(part)
    return bytes(data)


def serve_native(origin, input_stream, output_stream, folder=None):
    # The argv origin is an additional check, not an authentication boundary against same-user code.
    if origin != EXTENSION_ORIGIN:
        return 1
    try:
        size = struct.unpack("<I", read_exact(input_stream, 4))[0]
        if not 0 < size <= MAX_REQUEST:
            raise ValueError("Invalid native message size")
        request = json.loads(read_exact(input_stream, size))
        if not isinstance(request, dict) or request.get("cmd") != "get_bridge_credentials":
            raise ValueError("Invalid native command")
        response = {"protocol": 1, "key": load_secret(folder)}
    except (OSError, ValueError, KeyError):
        response = {"error": "Bridge unavailable; start the desktop application"}
    data = json.dumps(response).encode("utf-8")
    output_stream.write(struct.pack("<I", len(data)) + data)
    output_stream.flush()
    return 0


class NativePipe:
    """Use Chrome's inherited pipe handles even in a windowed/no-console EXE."""
    def __init__(self, handle, kernel):
        self.handle, self.kernel = handle, kernel

    def read(self, size):
        buffer = ctypes.create_string_buffer(size)
        count = wintypes.DWORD()
        if not self.kernel.ReadFile(self.handle, buffer, size, ctypes.byref(count), None):
            if ctypes.get_last_error() == 109:  # ERROR_BROKEN_PIPE
                return b""
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.raw[:count.value]

    def write(self, data):
        offset = 0
        while offset < len(data):
            buffer = ctypes.create_string_buffer(data[offset:])
            count = wintypes.DWORD()
            if not self.kernel.WriteFile(self.handle, buffer, len(data) - offset, ctypes.byref(count), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not count.value:
                raise OSError("Native pipe closed")
            offset += count.value

    def flush(self):
        pass  # WriteFile is synchronous; no Python userspace buffer.


def native_streams():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    for name in ("ReadFile", "WriteFile"):
        function = getattr(kernel, name)
        function.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                             ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        function.restype = wintypes.BOOL
    handles = [kernel.GetStdHandle(number & 0xffffffff) for number in (-10, -11)]
    if any(not handle or kernel.GetFileType(handle) != 3 for handle in handles):
        raise OSError("Native Messaging requires inherited pipes")
    return tuple(NativePipe(handle, kernel) for handle in handles)


def main():
    if sys.platform != "win32" or len(sys.argv) < 2 or sys.argv[1] != EXTENSION_ORIGIN:
        return 1
    try:
        input_stream, output_stream = native_streams()
        return serve_native(sys.argv[1], input_stream, output_stream)
    except (OSError, ValueError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

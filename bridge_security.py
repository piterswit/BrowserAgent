"""Authenticated loopback frames; bootstrap credentials arrive via Native Messaging."""
import asyncio
import hashlib
import hmac
import json
import re
import secrets
from http import HTTPStatus

HEX_KEY = re.compile(r"[0-9a-f]{64}\Z")
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}\Z")


async def check_origin(path, headers):
    origins = headers.get_all("Origin")
    if len(origins) != 1 or not EXTENSION_ORIGIN.fullmatch(origins[0]):
        return HTTPStatus.FORBIDDEN, [("Content-Type", "text/plain")], b"Extension origin required\n"


def proof(key, role, server_nonce, client_nonce, suffix=""):
    return hmac.new(bytes.fromhex(key),
                    f"fb-bridge-v1|{role}|{server_nonce}|{client_nonce}{suffix}".encode("utf-8"),
                    hashlib.sha256).hexdigest()


async def authenticate(ws, key):
    server_nonce = secrets.token_hex(32)
    await ws.send(json.dumps({"type": "auth_challenge", "nonce": server_nonce}))
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        if not isinstance(raw, str) or len(raw) > 1024:
            raise ValueError("Invalid authentication message")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Object required")
        nonce, supplied = data.get("nonce"), data.get("proof")
        if (data.get("type") != "auth_response" or not isinstance(nonce, str)
                or not HEX_KEY.fullmatch(nonce) or not isinstance(supplied, str)
                or not HEX_KEY.fullmatch(supplied)
                or not hmac.compare_digest(supplied, proof(key, "client", server_nonce, nonce))):
            raise ValueError("Invalid authentication proof")
        await ws.send(json.dumps({"type": "auth_ok", "proof": proof(key, "server", server_nonce, nonce)}))
        return AuthenticatedConnection(ws, key, server_nonce, nonce)
    except (ValueError, TypeError, asyncio.TimeoutError):
        await ws.close(code=1008, reason="Bridge authentication required")
        return None


class AuthenticatedConnection:
    def __init__(self, ws, key, server_nonce, client_nonce):
        self.ws, self.key = ws, key
        self.server_nonce, self.client_nonce = server_nonce, client_nonce
        self.incoming, self.outgoing = 0, 0
        self.send_lock = asyncio.Lock()

    @property
    def close_code(self):
        return self.ws.close_code

    async def close(self, **kwargs):
        await self.ws.close(**kwargs)

    async def send(self, body):
        async with self.send_lock:
            self.outgoing += 1
            signature = proof(self.key, "server-message", self.server_nonce, self.client_nonce,
                              f"|{self.outgoing}|{body}")
            await self.ws.send(json.dumps({"type": "secure", "seq": self.outgoing,
                                           "body": body, "proof": signature}))

    def __aiter__(self):
        return self.messages()

    async def messages(self):
        async for raw in self.ws:
            try:
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError("Object required")
                seq, body, supplied = frame.get("seq"), frame.get("body"), frame.get("proof")
                if (frame.get("type") != "secure" or type(seq) is not int
                        or seq != self.incoming + 1 or not isinstance(body, str)
                        or not isinstance(supplied, str) or not HEX_KEY.fullmatch(supplied)
                        or not hmac.compare_digest(supplied, proof(self.key, "client-message",
                            self.server_nonce, self.client_nonce, f"|{seq}|{body}"))):
                    raise ValueError("Invalid signed frame")
                self.incoming = seq
                yield body
            except (ValueError, TypeError):
                await self.ws.close(code=1008, reason="Invalid authenticated message")
                return

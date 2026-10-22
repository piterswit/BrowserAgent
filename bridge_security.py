"""Origin filtering for the loopback WebSocket bridge.

This filter rejects browser web pages; it does not authenticate local processes.
"""
import re
from http import HTTPStatus

EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}\Z")


async def check_origin(path, headers):
    origins = headers.get_all("Origin")
    if len(origins) != 1 or not EXTENSION_ORIGIN.fullmatch(origins[0]):
        return HTTPStatus.FORBIDDEN, [("Content-Type", "text/plain")], b"Extension origin required\n"

import asyncio
import json
import unittest
from websockets.datastructures import Headers
from websockets.legacy.client import connect
from websockets.legacy.server import serve
from bridge_security import check_origin, authenticate, proof

ORIGIN = "chrome-extension://" + "a" * 32
KEY = "ab" * 32


class OriginTest(unittest.IsolatedAsyncioTestCase):
    async def test_origin_requires_exact_extension_origin(self):
        for origin in (None, "null", "https://evil.example", ORIGIN + ".evil.example", ORIGIN + "/"):
            headers = Headers([] if origin is None else [("Origin", origin)])
            self.assertEqual((await check_origin("/", headers))[0], 403)
        self.assertIsNone(await check_origin("/", Headers({"Origin": ORIGIN})))
        self.assertEqual((await check_origin("/", Headers([("Origin", ORIGIN)] * 2)))[0], 403)

    async def handshake(self, socket):
        challenge = json.loads(await socket.recv())
        sn, cn = challenge["nonce"], "cd" * 32
        await socket.send(json.dumps({"type": "auth_response", "nonce": cn, "proof": proof(KEY, "client", sn, cn)}))
        self.assertEqual(json.loads(await socket.recv())["proof"], proof(KEY, "server", sn, cn))
        return sn, cn

    async def test_mutual_authentication_signed_unicode_and_replay_rejection(self):
        received = []
        async def handler(ws):
            channel = await authenticate(ws, KEY)
            if channel:
                async for body in channel:
                    received.append(json.loads(body))
                    await channel.send(json.dumps({"action": "stop_scroll"}))
        async with serve(handler, "127.0.0.1", 0, process_request=check_origin) as listener:
            port = listener.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}", origin=ORIGIN) as socket:
                sn, cn = await self.handshake(socket)
                body = json.dumps({"type": "init", "fb_name": "测试账号"}, ensure_ascii=False)
                frame = {"type": "secure", "seq": 1, "body": body,
                         "proof": proof(KEY, "client-message", sn, cn, "|1|" + body)}
                await socket.send(json.dumps(frame))
                reply = json.loads(await socket.recv())
                self.assertEqual(reply["proof"], proof(KEY, "server-message", sn, cn, "|1|" + reply["body"]))
                await socket.send(json.dumps(frame))
                await asyncio.wait_for(socket.wait_closed(), 2)
                self.assertEqual(socket.close_code, 1008)
        self.assertEqual(received, [{"type": "init", "fb_name": "测试账号"}])

    async def test_wrong_proof_and_tampering_never_reach_handler(self):
        for attack in ("wrong-proof", "raw", "tamper", "reflection"):
            received = []
            async def handler(ws):
                channel = await authenticate(ws, KEY)
                if channel:
                    async for body in channel:
                        received.append(body)
            async with serve(handler, "127.0.0.1", 0) as listener:
                port = listener.sockets[0].getsockname()[1]
                async with connect(f"ws://127.0.0.1:{port}") as socket:
                    if attack == "wrong-proof":
                        await socket.recv()
                        await socket.send(json.dumps({"type": "auth_response", "nonce": "cd" * 32, "proof": "ab" * 32}))
                    else:
                        sn, cn = await self.handshake(socket)
                        body = '{"type":"init"}'
                        frame = {"type": "secure", "seq": 1, "body": body,
                                 "proof": proof(KEY, "client-message", sn, cn, "|1|" + body)}
                        if attack == "raw": frame = {"type": "init"}
                        if attack == "tamper": frame["body"] += " "
                        if attack == "reflection": frame["proof"] = proof(KEY, "server-message", sn, cn, "|1|" + body)
                        await socket.send(json.dumps(frame))
                    await asyncio.wait_for(socket.wait_closed(), 2)
                    self.assertEqual(socket.close_code, 1008)
            self.assertEqual(received, [])


if __name__ == "__main__":
    unittest.main()

import unittest
from websockets.datastructures import Headers
from bridge_security import check_origin

ORIGIN = "chrome-extension://" + "a" * 32


class OriginTest(unittest.IsolatedAsyncioTestCase):
    async def test_origin_requires_exact_extension_origin(self):
        for origin in (None, "null", "https://evil.example", ORIGIN + ".evil.example", ORIGIN + "/"):
            headers = Headers([] if origin is None else [("Origin", origin)])
            self.assertEqual((await check_origin("/", headers))[0], 403)
        self.assertIsNone(await check_origin("/", Headers({"Origin": ORIGIN})))
        self.assertEqual((await check_origin("/", Headers([("Origin", ORIGIN)] * 2)))[0], 403)


if __name__ == "__main__":
    unittest.main()

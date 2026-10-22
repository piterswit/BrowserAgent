import sys
import unittest
import uuid


@unittest.skipUnless(sys.platform == "win32", "Windows instance synchronization")
class SingleInstanceTests(unittest.TestCase):
    def test_second_launch_signals_first_and_does_not_claim(self):
        from single_instance import SingleInstance
        name = "BrowserAgent.Test." + uuid.uuid4().hex
        first, second, replacement = (SingleInstance(name) for _ in range(3))
        try:
            self.assertTrue(first.claim())
            self.assertFalse(second.claim())
            self.assertEqual(first.kernel.WaitForSingleObject(first.event, 0), 0)
            self.assertEqual(first.kernel.WaitForSingleObject(first.event, 0), 258)
            second.close()
            first.close()
            self.assertTrue(replacement.claim())
        finally:
            first.close()
            second.close()
            replacement.close()

    def test_separate_application_names_do_not_block_one_another(self):
        from single_instance import SingleInstance
        first = SingleInstance("BrowserAgent.Test." + uuid.uuid4().hex)
        other = SingleInstance("BrowserAgent.Test." + uuid.uuid4().hex)
        try:
            self.assertTrue(first.claim())
            self.assertTrue(other.claim())
        finally:
            first.close()
            other.close()


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "bin" / "cindy-watch-script.py"


def load_watch():
    spec = importlib.util.spec_from_file_location("cindy_watch_script", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SummaryTests(unittest.TestCase):
    def test_keeps_orphan_guards_and_detail(self):
        out = load_watch()._summary({
            "mode": "discover",
            "dispatch": False,
            "orphanGuards": 2,
            "detail": "有 2 个孤立接管守卫，用 lock-doctor 清理",
            "prs": [{"number": 1, "feedback": "drop me"}],
            "events": [],
        })
        self.assertEqual(out["orphanGuards"], 2)
        self.assertIn("孤立接管守卫", out["detail"])
        self.assertEqual(out["mode"], "discover")
        self.assertNotIn("feedback", out["prs"][0])

    def test_zero_orphan_guards_without_detail(self):
        out = load_watch()._summary({"mode": "discover", "orphanGuards": 0, "prs": []})
        self.assertEqual(out["orphanGuards"], 0)
        self.assertNotIn("detail", out)


if __name__ == "__main__":
    unittest.main()

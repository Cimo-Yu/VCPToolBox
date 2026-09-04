import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "Plugin" / "BilibiliFetch" / "BilibiliFetch.py"
spec = importlib.util.spec_from_file_location("bilibili_fetch", MODULE_PATH)
bilibili_fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bilibili_fetch)


class ManagedChromeFallbackTests(unittest.TestCase):
    def test_does_not_fallback_when_api_has_subtitles(self):
        self.assertFalse(
            bilibili_fetch.should_try_browser_fallback(
                api_text="【视频信息】\n标题\n\n【字幕内容】\n[0.00] 有效字幕",
                need_subs=True,
                enabled=True,
            )
        )

    def test_falls_back_when_required_subtitles_are_missing(self):
        self.assertTrue(
            bilibili_fetch.should_try_browser_fallback(
                api_text="【视频信息】\n标题\n\n（未获取到字幕内容）",
                need_subs=True,
                enabled=True,
            )
        )

    def test_disabled_fallback_never_runs(self):
        self.assertFalse(
            bilibili_fetch.should_try_browser_fallback(
                api_text="",
                need_subs=True,
                enabled=False,
            )
        )

    @patch.dict(os.environ, {"VCP_Key": "test-key", "PORT": "6015"}, clear=False)
    @patch.object(bilibili_fetch.requests, "post")
    def test_browser_fallback_calls_protected_local_bridge(self, post):
        post.return_value.ok = True
        post.return_value.json.return_value = {
            "success": True,
            "markdown": "# 视频标题\nURL: https://www.bilibili.com/video/BV123\n\n页面正文",
        }

        result = bilibili_fetch.fetch_with_managed_chrome("https://www.bilibili.com/video/BV123")

        self.assertIn("页面正文", result)
        args, kwargs = post.call_args
        self.assertEqual(args[0], "http://127.0.0.1:6015/internal/chrome-bridge/bilibili-page")
        self.assertEqual(kwargs["headers"]["x-vcp-key"], "test-key")
        self.assertEqual(kwargs["json"]["url"], "https://www.bilibili.com/video/BV123")

    def test_merge_preserves_api_data_and_appends_browser_data(self):
        merged = bilibili_fetch.merge_api_and_browser_result(
            "【视频信息】\n视频标题：测试",
            "# 测试\n页面补充内容",
        )
        self.assertIn("视频标题：测试", merged)
        self.assertIn("【managed Chrome 页面补充】", merged)
        self.assertIn("页面补充内容", merged)


if __name__ == "__main__":
    unittest.main()

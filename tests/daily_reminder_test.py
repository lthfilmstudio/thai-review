import importlib.util
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "daily-reminder.py"
SPEC = importlib.util.spec_from_file_location("daily_reminder", MODULE_PATH)
daily_reminder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(daily_reminder)


class FormatProgressLineTest(unittest.TestCase):
    def test_below_goal_shows_remaining_minutes_rounded_up(self):
        line = daily_reminder.format_progress_line(0)
        self.assertIn("已複習 0 分鐘", line)
        self.assertIn("還差 60 分鐘", line)

    def test_at_or_above_goal_shows_achieved_message(self):
        line = daily_reminder.format_progress_line(daily_reminder.DAILY_BUDGET_SEC)
        self.assertIn("達標了", line)

    def test_partial_minute_remaining_rounds_up_not_down(self):
        # 3599 秒 = 59分59秒，離目標只差 1 秒，還是該顯示「還差 1 分鐘」不是 0。
        line = daily_reminder.format_progress_line(daily_reminder.DAILY_BUDGET_SEC - 1)
        self.assertIn("還差 1 分鐘", line)


class FetchProgressSecondsTest(unittest.TestCase):
    def test_missing_key_returns_none_without_network_call(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            with mock.patch("urllib.request.urlopen") as urlopen:
                result = daily_reminder.fetch_progress_seconds("2026-08-22")
        self.assertIsNone(result)
        urlopen.assert_not_called()

    def test_success_returns_total_seconds_from_json_body(self):
        response = mock.MagicMock()
        response.read.return_value = b'{"date": "2026-08-22", "total": 1500, "byDevice": {}}'
        response.__enter__.return_value = response
        with mock.patch.dict("os.environ", {"PROGRESS_READ_KEY": "test-key"}):
            with mock.patch("urllib.request.urlopen", return_value=response):
                result = daily_reminder.fetch_progress_seconds("2026-08-22")
        self.assertEqual(result, 1500)

    def test_network_failure_returns_none_instead_of_raising(self):
        import urllib.error
        with mock.patch.dict("os.environ", {"PROGRESS_READ_KEY": "test-key"}):
            with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
                result = daily_reminder.fetch_progress_seconds("2026-08-22")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()

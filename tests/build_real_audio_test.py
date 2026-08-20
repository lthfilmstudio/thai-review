import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_real_audio", ROOT / "scripts" / "build-real-audio.py")
bra = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bra
SPEC.loader.exec_module(bra)


def word(text, start, end, speaker="speaker_0"):
    return {"type": "word", "text": text, "start": start, "end": end, "speaker_id": speaker}


def spacing(start, end, speaker="speaker_0"):
    return {"type": "spacing", "text": " ", "start": start, "end": end, "speaker_id": speaker}


class SpeakerIndexTest(unittest.TestCase):
    def test_groups_by_speaker_and_skips_spacing(self):
        words = [
            word("ส", 0.0, 0.1), word("วัสดี", 0.1, 0.4),
            spacing(0.4, 0.42),
            word("ครับ", 0.42, 0.6, speaker="speaker_1"),
        ]
        per_speaker, durations = bra.build_speaker_index(words)
        self.assertEqual(per_speaker["speaker_0"]["text"], "สวัสดี")
        self.assertEqual(per_speaker["speaker_1"]["text"], "ครับ")
        self.assertAlmostEqual(durations["speaker_0"], 0.4, places=5)
        self.assertAlmostEqual(durations["speaker_1"], 0.18, places=5)

    def test_pick_teacher_uses_total_duration_not_token_count(self):
        # speaker_1 has fewer tokens but a much longer single utterance.
        durations = {"speaker_0": 5.0, "speaker_1": 40.0}
        self.assertEqual(bra.pick_teacher(durations), "speaker_1")

    def test_pick_teacher_empty(self):
        self.assertIsNone(bra.pick_teacher({}))


class FindMatchTest(unittest.TestCase):
    def setUp(self):
        words = [word("สวัสดี", 1.0, 1.5), word("ครับ", 1.5, 1.8), word("ผม", 2.0, 2.2)]
        self.per_speaker, _ = bra.build_speaker_index(words)
        self.entry = self.per_speaker["speaker_0"]

    def test_exact_match_spans_correct_tokens(self):
        result = bra.find_match(self.entry, "สวัสดีครับ")
        self.assertIsNotNone(result)
        start, end, occurrences = result
        self.assertAlmostEqual(start, 1.0)
        self.assertAlmostEqual(end, 1.8)
        self.assertEqual(occurrences, 1)

    def test_no_match_returns_none(self):
        self.assertIsNone(bra.find_match(self.entry, "ไม่มีจริง"))

    def test_counts_multiple_occurrences(self):
        words = [word("กิน", 0.0, 0.3), word("กิน", 1.0, 1.3)]
        per_speaker, _ = bra.build_speaker_index(words)
        result = bra.find_match(per_speaker["speaker_0"], "กิน")
        self.assertEqual(result[2], 2)
        # first occurrence wins
        self.assertAlmostEqual(result[0], 0.0)

    def test_rejects_match_spanning_inside_a_larger_token(self):
        # "รับ" 只是 "รับสมัคร" 這個單一 token 內部的字元巧合，不是真的獨立說過
        # "รับ" 這個詞——不該對齊到這個 token 的完整起訖時間。
        words = [word("รับสมัคร", 10.0, 10.9)]
        per_speaker, _ = bra.build_speaker_index(words)
        self.assertIsNone(bra.find_match(per_speaker["speaker_0"], "รับ"))

    def test_matches_when_text_spans_exactly_across_token_boundaries(self):
        # 真的橫跨兩個 token、但剛好對齊 token 邊界，應該正常命中。
        words = [word("รับ", 10.0, 10.3), word("สมัคร", 10.3, 10.9)]
        per_speaker, _ = bra.build_speaker_index(words)
        result = bra.find_match(per_speaker["speaker_0"], "รับสมัคร")
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result[0], 10.0)
        self.assertAlmostEqual(result[1], 10.9)

    def test_skips_unaligned_hit_and_finds_later_aligned_one(self):
        # 第一次出現咬在長詞中間（不對齊），第二次是獨立的完整 token，應該找到第二次。
        words = [word("รับสมัคร", 0.0, 0.9), word("รับ", 5.0, 5.3)]
        per_speaker, _ = bra.build_speaker_index(words)
        result = bra.find_match(per_speaker["speaker_0"], "รับ")
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result[0], 5.0)
        self.assertEqual(result[2], 1)


class PaddingTest(unittest.TestCase):
    def test_pad_clamped_by_neighboring_token_gap(self):
        # 前一個字結束在 0.95，只留 0.05s 間隔 < 120ms 上限，pad 應該被夾住
        words = [word("ก่อน", 0.5, 0.95), word("สวัสดี", 1.0, 1.5), word("หลัง", 1.55, 2.0)]
        toks, starts = bra.build_timeline(words)
        start, end = bra.padded_range(toks, starts, 1.0, 1.5, start_pad_ms=120, end_pad_ms=150)
        self.assertAlmostEqual(start, 0.95, places=5)  # 夾在鄰字結束點，不是 1.0-0.12=0.88
        self.assertAlmostEqual(end, 1.55, places=5)    # 夾在鄰字開始點，不是 1.5+0.15=1.65

    def test_pad_uses_full_cap_when_far_from_neighbors(self):
        words = [word("sole", 5.0, 5.5)]
        toks, starts = bra.build_timeline(words)
        start, end = bra.padded_range(toks, starts, 5.0, 5.5, start_pad_ms=120, end_pad_ms=150)
        self.assertAlmostEqual(start, 4.88, places=5)
        self.assertAlmostEqual(end, 5.65, places=5)

    def test_pad_ignores_other_speakers_too(self):
        # 隔壁講者的字也要拿來夾邊界，不能只看老師自己的 timeline
        words = [
            word("student", 0.9, 0.98, speaker="speaker_1"),
            word("สวัสดี", 1.0, 1.5, speaker="speaker_0"),
        ]
        toks, starts = bra.build_timeline(words)
        start, _ = bra.padded_range(toks, starts, 1.0, 1.5, start_pad_ms=120, end_pad_ms=150)
        self.assertAlmostEqual(start, 0.98, places=5)


class MatchVariantsTest(unittest.TestCase):
    def test_strips_internal_space_and_period(self):
        labels_by_text = dict(bra.match_variants("รับสมัคร รปภ."))
        self.assertEqual(labels_by_text.get("รับสมัครรปภ"), "normalized")

    def test_no_normalized_variant_when_nothing_to_strip(self):
        variants = bra.match_variants("สวัสดี")
        self.assertEqual(variants, [("สวัสดี", "exact")])

    def test_trailing_particle_variant_generated(self):
        pairs = bra.match_variants("กินสามชามค่ะ")
        labels = [label for _, label in pairs]
        self.assertTrue(any("ค่ะ" in label for label in labels))
        trimmed = next(text for text, label in pairs if "ค่ะ" in label)
        self.assertEqual(trimmed, "กินสามชาม")

    def test_does_not_strip_particle_that_is_the_whole_word(self):
        # "ค่ะ" 本身當成一張卡時不該被去光變成空字串
        variants = bra.match_variants("ค่ะ")
        self.assertEqual(variants, [("ค่ะ", "exact")])


class MatchLessonCardsTest(unittest.TestCase):
    def test_recovers_hit_via_particle_trim_and_labels_it(self):
        # 老師講的是「กินสามชาม」，卡片多寫了敬語尾詞「ค่ะ」——第一輪抓不到，
        # 第二輪去尾詞後應該要抓到，且標記不是 exact。
        words = [word("กินสามชาม", 2.0, 2.6)]
        lesson = {"id": "gid-test", "cards": [{"thai": "กินสามชามค่ะ", "zh": "吃三碗（女性禮貌）"}]}
        result = bra.match_lesson_cards(lesson, [words], start_pad_ms=0, end_pad_ms=0)
        self.assertEqual(len(result["hits"]), 1)
        hit = result["hits"][0]
        self.assertEqual(hit["thai"], "กินสามชามค่ะ")
        self.assertEqual(hit["matched_text"], "กินสามชาม")
        self.assertIn("ค่ะ", hit["match_kind"])

    def test_hits_misses_and_multi_occurrence_flag(self):
        part0_words = [
            word("สวัสดี", 0.0, 0.5), word("ครับ", 0.5, 0.8),
            word("test", 5.0, 5.1, speaker="speaker_2"),
        ]
        lesson = {"id": "gid-test", "cards": [
            {"thai": "สวัสดี", "zh": "你好"},
            {"thai": "ไม่มีจริง", "zh": "查無此句"},
        ]}
        result = bra.match_lesson_cards(lesson, [part0_words], start_pad_ms=50, end_pad_ms=50)
        self.assertEqual(len(result["hits"]), 1)
        self.assertEqual(len(result["misses"]), 1)
        self.assertEqual(result["hits"][0]["thai"], "สวัสดี")
        self.assertEqual(result["hits"][0]["part_index"], 0)
        self.assertEqual(result["misses"][0]["thai"], "ไม่มีจริง")

    def test_prefers_earlier_part_on_tie(self):
        part0 = [word("หนึ่ง", 0.0, 0.3)]
        part1 = [word("หนึ่ง", 0.0, 0.3)]
        lesson = {"id": "gid-test", "cards": [{"thai": "หนึ่ง", "zh": "一"}]}
        result = bra.match_lesson_cards(lesson, [part0, part1], start_pad_ms=0, end_pad_ms=0)
        self.assertEqual(result["hits"][0]["part_index"], 0)

    def test_skips_cards_without_thai_text(self):
        lesson = {"id": "gid-test", "cards": [{"thai": "", "zh": "空白"}]}
        result = bra.match_lesson_cards(lesson, [[]], start_pad_ms=0, end_pad_ms=0)
        self.assertEqual(result["hits"], [])
        self.assertEqual(result["misses"], [])


class SlicePcmTest(unittest.TestCase):
    def test_slices_expected_byte_range(self):
        # 1 秒的假 PCM（24000 sample/s * 2 bytes），切 0.5s~0.75s
        pcm = bytes(range(256)) * (bra.SAMPLE_RATE * 2 // 256 + 1)
        pcm = pcm[: bra.SAMPLE_RATE * 2]
        clip = bra.slice_pcm(pcm, 0.5, 0.75)
        expected_len = round(0.25 * bra.SAMPLE_RATE) * 2
        self.assertEqual(len(clip), expected_len)

    def test_clamps_to_buffer_end(self):
        pcm = b"\x00" * 1000
        clip = bra.slice_pcm(pcm, 0.0, 10.0)
        self.assertEqual(len(clip), 1000)


class LessonHashTest(unittest.TestCase):
    def test_deterministic_and_sensitive_to_inputs(self):
        h1 = bra.lesson_hash("gid-x", "260814", ["a", "b"], 120, 150)
        h2 = bra.lesson_hash("gid-x", "260814", ["a", "b"], 120, 150)
        h3 = bra.lesson_hash("gid-x", "260814", ["a", "c"], 120, 150)
        self.assertEqual(h1, h2)
        self.assertNotEqual(h1, h3)


if __name__ == "__main__":
    unittest.main()

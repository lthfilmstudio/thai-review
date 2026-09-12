import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gen_audio", ROOT / "scripts" / "gen-audio.py")
gen_audio = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gen_audio
SPEC.loader.exec_module(gen_audio)


class GenAudioTest(unittest.TestCase):
    def test_dialogue_turns_are_included_and_reuse_matching_lesson_audio(self):
        data = {
            "lessons": [{
                "title": "初 1",
                "cards": [{"thai": "สวัสดีค่ะ", "zh": "你好"}],
            }],
            "dialogues": [{
                "id": "D01",
                "title": "初次見面",
                "turns": [
                    {"thai": "สวัสดีค่ะ", "zh": "你好"},
                    {"thai": "ยินดีที่ได้รู้จัก", "zh": "很高興認識你"},
                ],
            }],
        }

        items, total_cards, _, _ = gen_audio.collect_unique_thai(data)
        self.assertEqual(total_cards, 3)
        self.assertEqual([item.thai for item in items], ["สวัสดีค่ะ", "ยินดีที่ได้รู้จัก"])
        self.assertEqual(items[0].count, 2)
        self.assertEqual(items[1].lesson, "對話：初次見面")

    def test_dry_run_treats_zero_byte_manifest_audio_as_missing(self):
        data = {
            "generated_at": 0,
            "source_url": "test",
            "lessons": [{
                "title": "中 1-2",
                "cards": [
                    {"thai": "ลาพักร้อนประจำปี", "zh": "特休／年假"},
                ],
            }],
        }

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            manifest_path = tmp_path / "audio-manifest.json"
            spec = gen_audio.AudioSpec(
                voice_name="test",
                voice_id="voice",
                model_id="model",
                language_code="th",
                output_format="mp3",
                audio_prefix="audio",
            )
            key = gen_audio.audio_key("ลาพักร้อนประจำปี", spec)
            rel_path = gen_audio.audio_path(key, spec)
            audio_file = tmp_path / rel_path
            audio_file.parent.mkdir(parents=True)
            audio_file.write_bytes(b"")
            manifest_path.write_text(json.dumps({
                "items": {
                    key: {
                        "thai": "ลาพักร้อนประจำปี",
                        "path": rel_path,
                    },
                },
            }, ensure_ascii=False), encoding="utf-8")

            items, total_cards, total_chars, unique_chars = gen_audio.collect_unique_thai(data)
            existing_keys, existing_normalized_thai = gen_audio.manifest_coverage(manifest_path)
            dry_run = gen_audio.build_dry_run(
                data_path=Path("data.json"),
                manifest_path=manifest_path,
                data=data,
                spec=spec,
                items=items,
                total_cards=total_cards,
                total_chars=total_chars,
                unique_chars=unique_chars,
                existing_keys=existing_keys,
                existing_normalized_thai=existing_normalized_thai,
                usd_per_1k_chars=0.10,
                twd_rate=31.835,
            )

        self.assertEqual(dry_run["coverage"]["missing_audio_files"], 1)
        self.assertEqual(dry_run["missing"][0]["key"], key)

    def test_dry_run_reuses_manifest_audio_when_only_whitespace_changed(self):
        data = {
            "generated_at": 0,
            "source_url": "test",
            "lessons": [{
                "title": "中 1-6",
                "cards": [
                    {"thai": "ฟังแล้วอยากย้ายไปอยู่ด้วยเลย", "zh": "想搬去一起住"},
                    {"thai": "เสียงใหม่จริงๆ", "zh": "真的新聲音"},
                ],
            }],
        }
        manifest = {
            "items": {
                "old-spaced-key": {
                    "thai": "ฟัง แล้ว อยาก ย้าย ไป อยู่ ด้วย เลย",
                    "path": "audio/jessica-v1/old-spaced-key.mp3",
                },
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "audio-manifest.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            audio_file = Path(tmp) / manifest["items"]["old-spaced-key"]["path"]
            audio_file.parent.mkdir(parents=True)
            audio_file.write_bytes(b"audio")

            spec = gen_audio.AudioSpec(
                voice_name="test",
                voice_id="voice",
                model_id="model",
                language_code="th",
                output_format="mp3",
                audio_prefix="audio",
            )
            items, total_cards, total_chars, unique_chars = gen_audio.collect_unique_thai(data)
            existing_keys, existing_normalized_thai = gen_audio.manifest_coverage(manifest_path)
            dry_run = gen_audio.build_dry_run(
                data_path=Path("data.json"),
                manifest_path=manifest_path,
                data=data,
                spec=spec,
                items=items,
                total_cards=total_cards,
                total_chars=total_chars,
                unique_chars=unique_chars,
                existing_keys=existing_keys,
                existing_normalized_thai=existing_normalized_thai,
                usd_per_1k_chars=0.10,
                twd_rate=31.835,
            )

        self.assertEqual(dry_run["coverage"]["space_normalized_reused_files"], 1)
        self.assertEqual(dry_run["coverage"]["missing_audio_files"], 1)
        self.assertEqual(dry_run["missing"][0]["item"].thai, "เสียงใหม่จริงๆ")

    def test_tts_prompt_sidecar_uses_prompt_text_for_audio_key_and_cost(self):
        data = {
            "generated_at": 0,
            "source_url": "test",
            "lessons": [{
                "id": "gid-638383387",
                "gid": "638383387",
                "title": "中 1-6",
                "cards": [
                    {"thai": "ขอบใจ นะ", "zh": "謝謝喔"},
                ],
            }],
        }
        prompts = {
            "lessons": {
                "gid-638383387": {
                    "items": [{
                        "row": 1,
                        "thai": "ขอบใจ นะ",
                        "zh": "謝謝喔",
                        "tts_prompt": "[warm, sincere] ขอบใจนะ",
                    }],
                },
            },
        }
        manifest = {
            "items": {
                "clean-visible-key": {
                    "thai": "ขอบใจ นะ",
                    "path": "audio/jessica-v1/clean-visible-key.mp3",
                },
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            manifest_path = tmp_path / "audio-manifest.json"
            prompt_path = tmp_path / "tts-prompts.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            prompt_path.write_text(json.dumps(prompts, ensure_ascii=False), encoding="utf-8")

            spec = gen_audio.AudioSpec(
                voice_name="test",
                voice_id="voice",
                model_id="model",
                language_code="th",
                output_format="mp3",
                audio_prefix="audio",
            )
            prompted_data = gen_audio.apply_tts_prompts(data, gen_audio.load_tts_prompts(prompt_path))
            items, total_cards, total_chars, unique_chars = gen_audio.collect_unique_thai(prompted_data)
            existing_keys, existing_normalized_thai = gen_audio.manifest_coverage(manifest_path)
            dry_run = gen_audio.build_dry_run(
                data_path=Path("data.json"),
                manifest_path=manifest_path,
                data=prompted_data,
                spec=spec,
                items=items,
                total_cards=total_cards,
                total_chars=total_chars,
                unique_chars=unique_chars,
                existing_keys=existing_keys,
                existing_normalized_thai=existing_normalized_thai,
                usd_per_1k_chars=0.10,
                twd_rate=31.835,
            )

        self.assertEqual(dry_run["coverage"]["missing_audio_files"], 1)
        self.assertEqual(dry_run["coverage"]["missing_chars_to_generate"], len("[warm, sincere] ขอบใจนะ"))
        self.assertEqual(dry_run["missing"][0]["item"].thai, "ขอบใจ นะ")
        self.assertEqual(dry_run["missing"][0]["item"].tts_text, "[warm, sincere] ขอบใจนะ")

    def test_stale_prompt_is_dropped_when_thai_changed_but_zh_did_not(self):
        """泰文修了錯字、中文沒動 → 舊 prompt 必須被丟掉。

        2026-09-12 踩到：條件原本是「thai 不符『且』zh 不符」才跳過，改錯字時
        zh 一樣就讓過期 prompt 過關，tts_text 還是舊字串，覆蓋率報 missing=0，
        那張卡卻一直播改之前的發音，而且零警告。
        """
        data = {
            "lessons": [{
                "id": "gid-202574020",
                "title": "初 5-7",
                "cards": [
                    {"thai": "ทำเค้กเป็นมั้ย", "zh": "會做蛋糕嗎"},
                ],
            }],
        }
        prompts = {
            "lessons": {
                "gid-202574020": {
                    "items": [{
                        "row": 1,
                        "thai": "ทำเค้กเป็นมย",
                        "zh": "會做蛋糕嗎",
                        "tts_prompt": "[curious, conversational] ทำเค้กเป็นมย",
                    }],
                },
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            prompt_path = Path(tmp) / "tts-prompts.json"
            prompt_path.write_text(json.dumps(prompts, ensure_ascii=False), encoding="utf-8")
            prompted = gen_audio.apply_tts_prompts(data, gen_audio.load_tts_prompts(prompt_path))

        card = prompted["lessons"][0]["cards"][0]
        self.assertNotIn("tts_prompt", card)

        items, _, _, _ = gen_audio.collect_unique_thai(prompted)
        self.assertEqual([i.tts_text for i in items], ["ทำเค้กเป็นมั้ย"])

    def test_prompt_still_applies_when_thai_matches(self):
        """泰文相符時照舊套用，不能因為上面那條防呆把正常路徑一起擋掉。"""
        data = {
            "lessons": [{
                "id": "gid-202574020",
                "title": "初 5-7",
                "cards": [
                    {"thai": "ทำเค้กเป็นมั้ย", "zh": "會做蛋糕嗎"},
                ],
            }],
        }
        prompts = {
            "lessons": {
                "gid-202574020": {
                    "items": [{
                        "row": 1,
                        "thai": "ทำเค้กเป็นมั้ย",
                        "zh": "會做蛋糕嗎",
                        "tts_prompt": "[curious, conversational] ทำเค้กเป็นมั้ย",
                    }],
                },
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            prompt_path = Path(tmp) / "tts-prompts.json"
            prompt_path.write_text(json.dumps(prompts, ensure_ascii=False), encoding="utf-8")
            prompted = gen_audio.apply_tts_prompts(data, gen_audio.load_tts_prompts(prompt_path))

        items, _, _, _ = gen_audio.collect_unique_thai(prompted)
        self.assertEqual([i.tts_text for i in items],
                         ["[curious, conversational] ทำเค้กเป็นมั้ย"])


if __name__ == "__main__":
    unittest.main()

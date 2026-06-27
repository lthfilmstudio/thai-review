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


if __name__ == "__main__":
    unittest.main()

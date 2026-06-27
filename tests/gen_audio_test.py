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


if __name__ == "__main__":
    unittest.main()

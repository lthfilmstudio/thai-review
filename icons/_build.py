#!/usr/bin/env python3
"""產生 PWA app icons：深綠底 + 泰金「ก」字，泰絲風。
執行：python3 _build.py
輸出：icon-192.png / icon-512.png / icon-maskable-512.png / apple-touch-icon.png
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

# 顏色
BG_DARK = (15, 24, 20)        # #0F1814
BG_PANEL = (26, 43, 36)       # #1A2B24
GOLD = (196, 165, 116)        # #C4A574
GOLD_DIM = (139, 111, 63)     # #8B6F3F
HAIR = (245, 240, 232, 18)    # 泰絲紋線

THAI_CHAR = "ก"

# macOS 有的泰文字體
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Ayuthaya.ttf",
    "/System/Library/Fonts/ThonburiUI.ttc",
    "/System/Library/Fonts/Supplemental/Thonburi.ttc",
]


def load_font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def draw_silk_pattern(img: Image.Image, bg: tuple):
    """加幾條 45° 細紋，呼應『泰絲』質感。"""
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    step = max(18, w // 28)
    for offset in range(-h, w + h, step):
        draw.line(
            [(offset, 0), (offset + h, h)],
            fill=(245, 240, 232, 10),
            width=1,
        )
    img.alpha_composite(overlay)


def make_icon(size: int, maskable: bool = False, apple: bool = False) -> Image.Image:
    """
    safe zone：
    - regular：72%（logo 範圍）
    - maskable：60%（OS 會裁成圓 / 圓角矩形）
    - apple：72%，底色填滿，不透明
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if maskable:
        # 整張實色底（OS 會裁圓），char 範圍 60%
        draw.rectangle([0, 0, size, size], fill=BG_DARK)
        draw_silk_pattern(img, BG_DARK)
        char_ratio = 0.60
    elif apple:
        # iOS 不支援透明，畫圓角矩形 + 實色底
        r = int(size * 0.22)
        draw.rounded_rectangle([0, 0, size, size], radius=r, fill=BG_DARK)
        draw_silk_pattern(img, BG_DARK)
        char_ratio = 0.72
    else:
        # 一般 PWA icon：圓角矩形 + 內邊細金邊框
        r = int(size * 0.22)
        draw.rounded_rectangle([0, 0, size, size], radius=r, fill=BG_DARK)
        draw_silk_pattern(img, BG_DARK)
        # 金色細框
        inset = max(1, size // 64)
        draw.rounded_rectangle(
            [inset, inset, size - inset, size - inset],
            radius=r - inset,
            outline=GOLD,
            width=max(1, size // 128),
        )
        char_ratio = 0.72

    # 畫泰文 ก 字
    target_box = size * char_ratio
    # 先試一個字體大小，量實際寬高，再調整
    font_size = int(target_box * 0.95)
    font = load_font(font_size)
    # 量字
    bbox = draw.textbbox((0, 0), THAI_CHAR, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # 若超過 target_box 比例，縮一下
    scale = min(target_box / tw, target_box / th)
    if scale < 1.0:
        font_size = int(font_size * scale)
        font = load_font(font_size)
        bbox = draw.textbbox((0, 0), THAI_CHAR, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), THAI_CHAR, fill=GOLD, font=font)

    return img


def main():
    out = Path(__file__).resolve().parent
    make_icon(192).save(out / "icon-192.png", "PNG")
    make_icon(512).save(out / "icon-512.png", "PNG")
    make_icon(512, maskable=True).save(out / "icon-maskable-512.png", "PNG")
    make_icon(180, apple=True).save(out / "apple-touch-icon.png", "PNG")
    # 社交分享小 icon（可選）
    make_icon(32).save(out / "favicon-32.png", "PNG")
    print("icons written to", out)


if __name__ == "__main__":
    main()

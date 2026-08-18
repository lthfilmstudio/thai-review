"""
目的達拼音系統聲調計算器 — 機械式套用確認過的泰語聲調規則，
不做拼字判斷（class / syllable type / vowel length / tone mark 由呼叫端先自己判斷好，
這裡只負責「給定這四個輸入，聲調是幾號」這個純查表動作，避免自由心證出錯）。

聲調符號（補在整個音節拼音最後面，這套是直接從 PDF 文字層機械抽出來的真實
Unicode 字元，唯一標準，不要用肉眼辨識照片猜的 ˅‵∕ 那套——兩套形狀像但編碼不同，
混用曾經造成過一次全部降調被誤標成低調的重大事故）：
  1 中平調 = 不標
  2 低調   = ˇ  (U+02C7 caron)
  3 降調   = ˋ  (U+02CB grave)
  4 高調   = ~  (U+007E tilde)
  5 升調   = ˊ  (U+02CA acute)
"""
TONE_MARK = {1: "", 2: "ˇ", 3: "ˋ", 4: "~", 5: "ˊ"}

def tone_number(consonant_class, syllable_type, vowel_long, explicit_mark=None):
    """
    consonant_class: 'mid' | 'high' | 'low'
    syllable_type: 'live' | 'dead'   (live=活音節：長母音開尾或响音尾 ง น ม ย ว；dead=死音節：短母音開尾或塞音尾 ก ด บ)
    vowel_long: True/False（只有 low class + dead 才會用到這個參數）
    explicit_mark: None | 'ek' | 'tho' | 'tri' | 'chattawa'  （ไม้เอก ไม้โท ไม้ตรี ไม้จัตวา）
    回傳 1-5
    """
    if explicit_mark == 'ek':
        # mid/high + mai ek = 低調(2)；low + mai ek = 降調(3)
        return 2 if consonant_class in ('mid', 'high') else 3
    if explicit_mark == 'tho':
        # mid/high + mai tho = 降調(3)；low + mai tho = 高調(4)
        return 3 if consonant_class in ('mid', 'high') else 4
    if explicit_mark == 'tri':
        return 4  # 高調，只跟中音字母搭配
    if explicit_mark == 'chattawa':
        return 5  # 升調，只跟中音字母搭配

    # 無聲調符號
    if syllable_type == 'live':
        if consonant_class == 'mid':
            return 1
        if consonant_class == 'high':
            return 5
        if consonant_class == 'low':
            return 1
    else:  # dead
        if consonant_class == 'mid':
            return 2
        if consonant_class == 'high':
            return 2
        if consonant_class == 'low':
            return 4 if not vowel_long else 3
    raise ValueError(f"unhandled combo: {consonant_class} {syllable_type} {vowel_long} {explicit_mark}")


def mark(consonant_class, syllable_type, vowel_long, explicit_mark=None):
    return TONE_MARK[tone_number(consonant_class, syllable_type, vowel_long, explicit_mark)]


# ---- 自我驗證：用這次對話裡已經人工核對過、確定正確答案的字 ----
CASES = [
    # (class, syllable_type, vowel_long, mark, expected_tone_number, word_for_reference)
    ('low', 'dead', False, 'ek', 3, 'ไม่ mâi'),
    ('low', 'dead', False, 'ek', 3, 'ค่ะ khâ (ค low class + short a + ek)'),
    ('mid', 'live', None, 'tho', 3, 'ได้ dhâi (ด mid + mai tho)'),
    ('high', 'live', True, None, 5, 'ไหม mǎi (ห high class + live long)'),
    ('high', 'live', True, None, 5, 'ขอ kǎw (ข high class + live long)'),
    ('low', 'dead', True, None, 3, 'โทษ tʰôːt (ท low + dead + long)'),
    ('low', 'dead', True, None, 3, 'โชค chôːk (ช low + dead + long)'),
    ('low', 'dead', True, None, 3, 'มาก mâːk (ม low + dead + long)'),
    ('low', 'dead', False, None, 4, 'สนุก sanùk -> nuk high (น low + dead + short)'),
    ('low', 'dead', False, None, 4, 'ครับ kráp (ค low + dead + short)'),
    ('mid', 'dead', False, None, 2, 'กะ ga˅ (ก mid + dead + short)'),
    ('high', 'dead', True, None, 2, 'ขอบ kɔ̀ːp (ข high class + dead, regardless length = low)'),
    ('mid', 'dead', True, None, 2, 'กราบ gràːp (ก mid + dead + long = low, mid class 不分長短都低調)'),
    ('low', 'live', None, 'tho', 4, 'รู้ rúː (ร low + mai tho)'),
    ('mid', 'live', None, 'tho', 3, 'กล้า glâː (ก mid + mai tho)'),
    ('mid', 'dead', None, None, 2, 'จะ ja˅ (จ mid + dead short)'),
    ('mid', 'live', None, None, 1, 'กา gaa (ก mid + live long)'),
    ('low', 'live', None, None, 1, 'มา maa (ม low + live)'),
    ('mid', 'dead', None, 'ek', 2, 'ก่อน gɔ̀ɔn (ก mid + mai ek)'),
    ('low', 'dead', None, 'ek', 3, 'ช่วง chûang (ช low + mai ek)'),
]

if __name__ == '__main__':
    ok = 0
    for cls, styp, vlong, em, expected, note in CASES:
        got = tone_number(cls, styp, vlong, em)
        status = 'OK' if got == expected else 'FAIL'
        if got == expected:
            ok += 1
        print(f"{status}: {note}  -> got {got}({TONE_MARK[got]}) expected {expected}({TONE_MARK[expected]})")
    print(f"\n{ok}/{len(CASES)} passed")

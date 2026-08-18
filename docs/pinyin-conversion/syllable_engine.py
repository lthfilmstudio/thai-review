"""
泰文音節結構分析器 -> 目的達拼音系統。
規則式（不用 ML），對每個 pythainlp 切出來的音節做結構解析：
  初子音(含cluster) + 母音(長短) + 韻尾(活/死) + 明確聲調符號
再呼叫 tone_calc.tone_number() 算聲調，組合成目的達拼音字串。

看不懂的音節結構回傳 None（呼叫端要能分辨「處理不了」跟「處理結果」）。
"""
import re
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tone_calc import tone_number, TONE_MARK

# ---------------- 子音表 ----------------
# char -> (class, initial_rom, final_rom_or_None)
CONSONANTS = {
    'ก': ('mid', 'g', 'k'),
    'ข': ('high', 'k', 'k'), 'ฃ': ('high', 'k', 'k'),
    'ค': ('low', 'k', 'k'), 'ฅ': ('low', 'k', 'k'), 'ฆ': ('low', 'k', 'k'),
    'ง': ('low', 'ng', 'ng'),
    'จ': ('mid', 'j', 't'),
    'ฉ': ('high', 'ch', None),
    'ช': ('low', 'ch', 't'), 'ฌ': ('low', 'ch', None),
    'ญ': ('low', 'y', 'n'),
    'ฎ': ('mid', 'd', 't'), 'ฏ': ('mid', 'd', 't'),
    'ฐ': ('high', 't', 't'),
    'ฑ': ('low', 't', 't'), 'ฒ': ('low', 't', 't'),
    'ณ': ('low', 'n', 'n'),
    'ด': ('mid', 'dh', 't'), 'ต': ('mid', 'd', 't'),
    'ถ': ('high', 't', 't'), 'ท': ('low', 't', 't'), 'ธ': ('low', 't', 't'),
    'น': ('low', 'n', 'n'),
    'บ': ('mid', 'bh', 'p'), 'ป': ('mid', 'b', 'p'),
    'ผ': ('high', 'p', None),
    'ฝ': ('high', 'f', None),
    'พ': ('low', 'p', 'p'), 'ภ': ('low', 'p', 'p'),
    'ฟ': ('low', 'f', 'p'),
    'ม': ('low', 'm', 'm'),
    'ย': ('low', 'y', 'i'),
    'ร': ('low', 'r', 'n'),
    'ล': ('low', 'l', 'n'), 'ฬ': ('low', 'l', 'n'),
    'ว': ('low', 'w', 'w'),  # 尾音實測跟 pilot 對照應為 w（不是先前照片誤判的 u）
    'ศ': ('high', 's', 't'), 'ษ': ('high', 's', 't'), 'ส': ('high', 's', 't'),
    'ซ': ('low', 's', 't'),
    'ห': ('high', 'h', None),
    'ฮ': ('low', 'h', None),
    'อ': ('mid', '', None),  # 沉默/母音載體
}

TONE_MARKS = {'่': 'ek', '้': 'tho', '๊': 'tri', '๋': 'chattawa'}
# ่ ้ ๊ ๋
MAI_TAIKHU = '็'  # ็ 短音符號（跟聲調符號不同，是縮短母音用的）

# 常見「隱藏母音無法從單一音節結構分辨 a/o」或其他真正不規則讀音的字，
# 查不出明確規則、屬於詞彙記憶範疇，用小型對照表補（不是硬猜規則）。
# key: 去掉聲調符號前的原始音節字串；value: 完整目的達拼音（含聲調符號）
IRREGULAR_SYLLABLES = {
    'อยู่': 'yūˋ', 'อย่า': 'yāˋ', 'อยาก': 'yākˋ', 'อย่าง': 'yāngˋ',
    'น้ำ': 'nām~',  # 語音學上 ำ 不分長短，但這個極常用字 pilot 對照確認是約定俗成長音寫法
    'คน': 'kon', 'รถ': 'rot~', 'ผม': 'pomˊ', 'ตก': 'dokˇ',
    'บน': 'bhon', 'ลง': 'long', 'ก็': 'gɔ̄ˋ', 'ณ': 'na~',
    'ผลิต': 'paˇ lit~',  # 正式書面詞，2音節（pha-lìt），不是 ผล+ิต 複合聲母
    'ไทย': 'tai',  # ไ...ย 是 ไ(ai)的裝飾性拼法，ย 不是獨立尾音，不能用一般規則硬套
    'หก': 'hokˇ', 'สนุก': 'saˇ nuk~', 'ขนม': 'kaˇ nom', 'ตลาด': 'daˇ lātˋ',
    'สด': 'sotˇ', 'สถา': 'saˇ tāˊ', 'อร่อย': 'aˇ rɔ̄iˋ', 'สบาย': 'saˇ bhāi',
    'ต้ม': 'domˋ', 'ผง': 'pōngˊ', 'ส้ม': 'somˋ', 'หม้อ': 'mɔ̄ˋ', 'ปอ': 'bɔ̄', 'พอ': 'pɔ̄',
    'ตรง': 'drong', 'นม': 'nom', 'อบ': 'opˇ',
    'โทร': 'tō',  # ร是裝飾性拼法、不是真尾音（跟 ไทย 的 ย 同類）；單獨當動詞用（打電話）唸1音節「thoh」，
                  # 舊版誤把 ร 當成真尾音給 final='n' 唸成「tōn」是錯的。
                  # 注意：โทรศัพท์/โทรทัศน์ 這種正式複合詞裡 ร 會恢復成獨立音節「tō ra~」，
                  # 這裡的值只覆蓋單獨當動詞用的情況，複合詞在 resolve_uncertain.py 另外處理。
}
MAI_HAN_AKAT = 'ั'  # ั
SARA_A = 'ะ'        # ะ
SARA_AA = 'า'       # า
SARA_I = 'ิ'        # ิ
SARA_II = 'ี'       # ี
SARA_UE = 'ึ'       # ึ
SARA_UEE = 'ื'      # ื
SARA_U = 'ุ'        # ุ
SARA_UU = 'ู'       # ู
SARA_E = 'เ'        # เ (leading)
SARA_AE = 'แ'       # แ (leading)
SARA_O = 'โ'        # โ (leading)
SARA_AI_MAIMUAN = 'ไ'  # ไ
SARA_AI_MAIMALAI = 'ใ'  # ใ
NIKHAHIT = 'ํ'       # ํ (used in ำ decomposition sometimes)
SARA_AM = 'ำ'        # ำ
GARAN = '์'          # ์ silent mark
YAMOK = 'ๆ'          # ๆ repeat

CLUSTER_SECONDS = {'ร', 'ล', 'ว'}  # 複合聲母第二個字母
# 泰語真正存在的複合聲母組合白名單（ตล ตว 這種不是真正的cluster，容易誤判）
VALID_CLUSTERS = {
    'กร', 'กล', 'กว', 'ขร', 'ขล', 'ขว', 'คร', 'คล', 'คว',
    'ตร', 'ปร', 'ปล', 'ผล', 'พร', 'พล', 'ฟร', 'ฟล', 'ศร', 'สร',
}
# ห-นำ：ห 後面接這些「只有低音字母、沒有對應中/高音字母」的響音聲母時，
# ห 不發音、只把後面那個字母的聲調類別「借」成高音字母（拼法還是照後面那個字母本身的拼法）
HO_NAM_TARGETS = {'ง', 'ญ', 'น', 'ม', 'ย', 'ร', 'ล', 'ว'}

VOWEL_ROM = {  # (short, long)
    'a': ('a', 'ā'), 'i': ('i', 'ī'), 'ue': ('ɯ', 'ɯ̄'), 'u': ('u', 'ū'),
    'e': ('e', 'ē'), 'ae': ('ɛ', 'ɛ̄'), 'o': ('o', 'ō'), 'oo': ('ɔ', 'ɔ̄'),
    'er': ('ə', 'ə̄'),
}


def classify_consonant(ch):
    return CONSONANTS.get(ch)


def strip_final_garan(syl):
    """把 ...X์ 這種不發音字母砍掉（含前面那個被消音的字母）。"""
    idx = syl.find(GARAN)
    if idx == -1:
        return syl
    # garan 通常消音它前面緊接的 1 個字母（如果前面那個字母前面還有一個子音黏著，例如 นาม > นามส์ 這種也常見兩個字母一起消音，
    # 但先處理最常見的「消音前一個字母」情況，不確定的整個標記處理不了）
    return syl[:idx-1] + syl[idx+1:] if idx >= 1 else None


def analyze_syllable(syl):
    """回傳 dict: {rom, tone_num, debug} 或 None(處理不了)"""
    orig = syl
    syl = syl.replace(YAMOK, '').strip()
    if not syl:
        return None

    # 真正查不出明確規則、屬於詞彙記憶的字，先查小型對照表
    if syl in IRREGULAR_SYLLABLES:
        return {'rom': IRREGULAR_SYLLABLES[syl], 'tone': None, 'class': None,
                'syllable_type': None, 'is_long': None, 'final': None,
                'mark_in': None, 'source': 'irregular_dict'}

    if GARAN in syl:
        stripped = strip_final_garan(syl)
        if stripped is None:
            return None
        syl = stripped
        if not syl:
            return None

    # 抽出聲調符號
    explicit_mark = None
    for ch, name in TONE_MARKS.items():
        if ch in syl:
            if explicit_mark is not None:
                return None  # 不該有兩個聲調符號，不會處理
            explicit_mark = name
            syl = syl.replace(ch, '')

    # 抽出 ็ (ไม้ไต่คู้ 短音符號，跟聲調符號無關，是母音縮短用的)
    shortened = False
    if MAI_TAIKHU in syl:
        shortened = True
        syl = syl.replace(MAI_TAIKHU, '')

    # 前導母音 (เ แ โ ใ ไ)
    leading = ''
    if syl and syl[0] in (SARA_E, SARA_AE, SARA_O, SARA_AI_MAIMUAN, SARA_AI_MAIMALAI):
        leading = syl[0]
        syl = syl[1:]
    leading2 = ''
    if syl and syl[0] == SARA_E and leading == SARA_E:
        # เเ 有些字型打成兩個 เ 代表 แ，正常應該不會出現，防呆
        pass

    # 開頭子音（可能兩個組成 cluster，或 ห-นำ 不發音只借聲調類別）
    if not syl or syl[0] not in CONSONANTS:
        return None
    c1 = syl[0]
    rest = syl[1:]

    # ห-นำ：ห 後面直接接響音聲母（ง ญ น ม ย ร ล ว），ห 不發音，聲調類別借用高音，
    # 拼法用後面那個字母自己的拼法（不是 ห 的 h）。
    # 但這條規則跟「ห 本身就是正常聲母、後面那個響音字母其實是尾音」是同一種字面結構
    # （例如 แห้ง：ห 是正常聲母、ง 是尾音，不是 ห-นำ），純看字面沒辦法從結構分辨，
    # 是詞彙記憶問題。實測發現：「有前導母音 + ห + 單一響音字母 + 後面沒東西了」這個子
    # 情況只有 leading 是 ไ/ใ 時才是真的 ห-นำ（ไหม ใหม่ ใหญ่ ไหน ไหล 這類常見字），
    # leading 是 เ/แ/โ 時反而通常是 ห 當正常聲母（แห้ง 這種），所以加這個條件排除。
    is_ho_nam = (c1 == 'ห' and rest and rest[0] in HO_NAM_TARGETS
                 and not (leading in (SARA_E, SARA_AE, SARA_O) and len(rest) == 1))
    if is_ho_nam:
        c1 = rest[0]
        rest = rest[1:]
        cls = 'high'
        _, init_rom, final_rom = CONSONANTS[c1]
        c2 = None
    else:
        c2 = None
        if rest and rest[0] in CLUSTER_SECONDS and (c1 + rest[0]) in VALID_CLUSTERS:
            # 只有「移除掉這兩個聲母之後,後面還有真正的母音內容」才算複合聲母；
            # 不然像 แก้ว 的 ก+ว，移除後 rest 是空的，那個 ว 其實是尾子音，不是複合聲母第二音。
            # 但如果前面已經有前導母音（เ/แ/โ/ใ/ไ）提供了母音本體，且第二個字母是 ร/ล
            # （不是 ว），那剩下正好一個字母也該當複合聲母，例如 ไกล(gl+ai) ตรง 的 ตร
            # ——ว 因為同時也很常單純當尾音（แก้ว），保留原本比較保守的判斷。
            if len(rest) > 1 or (leading and rest[0] in ('ร', 'ล')):
                c2 = rest[0]
                rest = rest[1:]

        cls, init_rom, final_rom = CONSONANTS[c1]
        if c2:
            _, init_rom2, _ = CONSONANTS[c2]
            init_rom = init_rom + init_rom2

    # 剩下的 rest 應該是：[母音記號]*[尾子音]?，加上前面抽出來的 leading
    # 先處理尾子音：從 rest 尾端找一個「不是母音符號」的 Thai 子音字母
    VOWEL_CHARS = {MAI_HAN_AKAT, SARA_A, SARA_AA, SARA_I, SARA_II, SARA_UE, SARA_UEE,
                   SARA_U, SARA_UU, SARA_AM, NIKHAHIT, 'อ'}  # อ 常常是母音的一部分
    final_char = None
    core = rest

    # ีย(ia) / ัว(ua) / ือ(ɯa，standalone無前導母音也算) 這幾個雙母音自帶的「像子音」字母
    # (ย/ว/อ) 要先鎖進 core，不能被底下的通用尾子音判斷誤吃掉
    diphthong_prefix = None
    if core.startswith(SARA_II + 'ย'):
        diphthong_prefix = SARA_II + 'ย'
    elif core.startswith(MAI_HAN_AKAT + 'ว'):
        diphthong_prefix = MAI_HAN_AKAT + 'ว'
    elif core.startswith(SARA_UEE + 'อ'):
        diphthong_prefix = SARA_UEE + 'อ'
    elif not leading and core.startswith('วย'):
        # 沒有 ั 記號、直接子音+วย 的 uai 雙母音（如 สวย ด้วย），跟 ัว 不同寫法但同一家族
        diphthong_prefix = 'วย'

    if diphthong_prefix:
        after = core[len(diphthong_prefix):]
        core = diphthong_prefix
        if after:
            if after[0] in CONSONANTS:
                final_char = after[0]
            else:
                return None
    elif core and core[-1] in CONSONANTS and core[-1] not in VOWEL_CHARS:
        # 但如果整個 core 只有一個字母而且就是子音本身沒有母音，那它可能是「有隱藏母音」的情況，final 不算
        if len(core) > 1:
            final_char = core[-1]
            core = core[:-1]
        elif leading:
            # 有前導母音（เ/แ/โ/ใ/ไ）+ 剩下正好一個子音字母 → 前導母音已經給了母音本體，
            # 這個字母是尾子音，不是隱藏母音（隱藏母音的 a/o 分不清問題只發生在完全沒有
            # 前導母音、也沒有母音符號的情況，例如 คน/รถ 這種，那種交給 IRREGULAR_SYLLABLES）
            final_char = core
            core = ''
        elif not core[:-1]:
            # 單一子音字母、沒有前導母音 → 視為有隱藏短 a 母音，不算尾子音，例如 "ณ" 這種孤字（罕見）
            pass

    # ---- 依 leading + core + final 組合判斷母音型態 ----
    result = _match_vowel(leading, core, final_char, c1, shortened)
    if result is None:
        return None
    vowel_rom, is_long, syllable_type_final = result

    final_rom_out = None
    if final_char:
        fcls, _, from_ = CONSONANTS.get(final_char, (None, None, None))
        if from_ is None:
            return None  # 這個字母不能當韻尾，不會處理（或是本身沒韻尾規則）
        final_rom_out = from_
        # ว 接在「長母音/雙母音」後面時，拼成 u 不是 w（例如 ข้าว/ลาว/เปรี้ยว 這種
        # -าว/-ีย ว 結尾，跟 pilot 逐筆核對過都是 u；短母音直接接 ว 才維持 w，例如 หิว）
        if final_char == 'ว' and is_long:
            final_rom_out = 'u'

    # 判斷活/死音節
    if final_rom_out in ('k', 't', 'p'):
        styp = 'dead'
    elif final_rom_out in ('ng', 'n', 'm', 'i', 'u', 'w') or final_rom_out is None:
        if final_rom_out is None:
            styp = 'dead' if not is_long else 'live'
        else:
            styp = 'live'
    else:
        return None

    try:
        tnum = tone_number(cls, styp, (is_long if styp == 'dead' else None), explicit_mark)
    except Exception:
        return None
    tmark = TONE_MARK[tnum]

    rom = init_rom + vowel_rom + (final_rom_out or '') + tmark
    return {'rom': rom, 'tone': tnum, 'class': cls, 'syllable_type': styp,
            'is_long': is_long, 'final': final_rom_out, 'mark_in': explicit_mark}


def _match_vowel(leading, core, final_char, c1, shortened=False):
    """回傳 (vowel_rom_str, is_long, ...) 或 None。
    leading: '' | เ | แ | โ | ไ | ใ
    core: 中間母音符號（已去掉前導母音跟尾子音）
    final_char: 尾子音字母 or None
    shortened: 有沒有 ็（ไม้ไต่คู้）把預設長母音縮短
    """
    has_final = final_char is not None

    if leading == SARA_AI_MAIMUAN or leading == SARA_AI_MAIMALAI:
        if core == '' and not has_final:
            return ('ai', True, None)
        return None

    if leading == SARA_E:
        if core == SARA_A:
            return ('e', False, None)
        if core == '' and final_char == 'ย':
            # เ-ย ə̄i 雙母音（如 เลย เคย เนย），ย 當結尾字母不是子音尾音本身，
            # 但外層仍會用 CONSONANTS['ย'] 的 final_rom('i') 接在後面組成 ə̄i
            return ('ə̄', True, None)
        if core == '':
            # เ+子音(+尾子音)、沒有其他母音符號：預設長 ē，除非有 ็ 把它縮短成短 e
            return ('e', False, None) if shortened else ('ē', True, None)
        if core == SARA_II:  # เ...ีย handled elsewhere; here just เ+ ี rare
            return None
        if core == MAI_HAN_AKAT + 'ย':  # เ..ียะ short ia -- handled below generically
            return None
        if core == 'อ' + SARA_A:  # เ-อะ short ə
            return ('e' if False else 'ə', False, None)
        if core == 'อ':  # เ-อ long ə (no final) หรือ เ-ิ deformed handled separately
            return ('ə̄', True, None)
        if core == SARA_I:  # เ-ิ deformed short/long ə with final
            return ('ə̄', True, None) if has_final else None
        if core == MAI_HAN_AKAT:  # เ-ัะ... rare
            return None
        if core == 'ียะ':
            return None
        if core == SARA_AA:  # เ-า ao 雙母音（如 เขา เท่า เช้า）
            # 跟 pilot 逐筆核對過：聲母是 อ（沉默母音載體，如 เอา 這個字本身跟它的
            # 衍生詞）時拼成不帶長音符號的 au，其他真正子音（ข ก ท ช...）才用 āu
            return ('au', True, None) if c1 == 'อ' else ('āu', True, None)
        if core.startswith(SARA_II + 'ย'):  # เ-ีย ia 雙母音（如 เตี้ย เที่ยว）
            return ('īa', True, None)
        if core == SARA_UEE + 'อ':  # เ-ือ ɯa 雙母音（如 เดือน）
            return ('ɯ̄a', True, None)
        if core == SARA_AA + SARA_A:  # เ-าะ short ɔ 雙母音（如 เกาะ เพราะ เงาะ）
            return ('ɔ', False, None)
        return None

    if leading == SARA_AE:
        if core == SARA_A:
            return ('ɛ', False, None)
        if core == '':
            return ('ɛ', False, None) if shortened else ('ɛ̄', True, None)
        return None

    if leading == SARA_O:
        if core == SARA_A:
            return ('o', False, None)
        if core == '':
            return ('ō', True, None)
        return None

    if leading == '':
        if core == SARA_A:
            return ('a', False, None)
        if core == MAI_HAN_AKAT:
            return ('a', False, None)  # ั 短a，通常後面接尾子音
        if core == SARA_AA:
            return ('ā', True, None)
        if core == SARA_I:
            return ('i', False, None)
        if core == SARA_II:
            return ('ī', True, None)
        if core == SARA_UE:
            return ('ɯ', False, None)
        if core == SARA_UEE:
            return ('ɯ̄', True, None)
        if core == SARA_UEE + 'อ':
            return ('ɯ̄a', True, None) if has_final else ('ɯ̄', True, None)
        if core == MAI_HAN_AKAT + 'ว':
            return ('ūa', True, None)
        if core == 'ว' and has_final:
            # 沒有 ั 記號、直接「聲母+ว+尾子音」代表 ua 母音（跟 ัว 同一家族的另一種
            # 拼寫慣例，例如 พวก ช่วง ส่วน ปวด ขวด ดวง ม่วง ห่วง ง่วง รวม สวน），
            # 跟 pilot/handout_dict 對照過確認拼法一致
            return ('ūa', True, None)
        if core == 'วย':
            return ('ūay', True, None)  # สวย ด้วย 這種沒有 ั 記號的 uai 雙母音
        if core == SARA_U:
            return ('u', False, None)
        if core == SARA_UU:
            return ('ū', True, None)
        if core == SARA_AM or core == NIKHAHIT + SARA_AA:
            # pilot 對這個母音的長短標示不一致（ทำ->短am，น้ำ->長ām），
            # 泰語音韻學上 ำ 是固定單位、理論上不分長短，這裡用短音當預設規則
            # （น้ำ 這種極常用字可能是被當成約定俗成的例外處理，不是規則本身的反例）
            return ('am', True, None)  # is_long給True不影響live判斷（ำ一律活音節）
        if core == 'อ':
            return ('ɔ̄', True, None)  # ...อ(+final)的 ออ 縮寫形式（如 ขอบ 的 อ；ขอ 單獨一個字也是這樣，沒有 final 一樣長 ɔ̄）
        if core == '':
            # 完全沒寫母音符號（隱藏母音）：可能是短 a（多音節詞的前音節，如 ขนม ka-nom）
            # 也可能是短 o（單音節閉音節，如 คน kon、ตก dtok）。這兩種光看單一音節分不出來，
            # 不確定，交給後續人工/LLM判斷，不硬猜。
            return None
        return None

    return None

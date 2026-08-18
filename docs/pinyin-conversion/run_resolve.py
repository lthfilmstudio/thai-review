"""
用 resolve_uncertain.SYL_FIX + syllable_engine.analyze_syllable 對
全課-不確定清單.tsv 的 2,322 筆逐句處理，輸出：
  - 全課-不確定清單-已解決.tsv
  - 全課-仍不確定清單.tsv
執行：uv run --with pythainlp --with python-crfsuite python3 run_resolve.py
"""
import sys, os, re, csv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pythainlp.tokenize import subword_tokenize
from syllable_engine import analyze_syllable
from resolve_uncertain import SYL_FIX

YAMOK = 'ๆ'
# 非泰文片段（數字、時間、英文、中文、縮寫句點）：不是泰語語音內容，原樣通過不轉換
NON_THAI_RE = re.compile(r'^[0-9a-zA-Z:.\-%一-鿿぀-ヿ＀-￯]+$')
THAI_CHAR_RE = re.compile(r'[ก-๙]')

def resolve_word(thai_word):
    """回傳 (rom_or_None, source, note)。thai_word 是完整的一個「泰文」欄位字串
    （可能含空白、逗號、斜線等標點）。"""
    # 先把整串按「泰文字元 vs 非泰文字元」切開，分開處理
    tokens = re.findall(r'[ก-๙]+|[^ก-๙]+', thai_word)
    out_parts = []
    used_syl_fix = False
    prev_rom = None
    for tok in tokens:
        if not THAI_CHAR_RE.search(tok):
            # 非泰文片段（標點、數字、英文、中文...）原樣保留
            out_parts.append(tok)
            continue
        # 泰文片段：先切音節
        syls = subword_tokenize(tok, engine='dict')
        for s in syls:
            s = s.strip()
            if not s:
                continue
            if s == YAMOK:
                if prev_rom is not None:
                    out_parts.append(' ' + prev_rom)
                else:
                    return None, None, f'ๆ 前面沒有可重複的音節：{thai_word}'
                continue
            res = analyze_syllable(s)
            if res:
                rom = res['rom']
            elif s in SYL_FIX:
                rom = SYL_FIX[s]
                used_syl_fix = True
            else:
                return None, None, f'音節「{s}」無法解析'
            out_parts.append((' ' if out_parts and not out_parts[-1].endswith(' ') else '') + rom)
            prev_rom = rom
    rom_str = ''.join(out_parts)
    # 清一下多餘空白（標點片段前後可能疊加空白）
    rom_str = re.sub(r' {2,}', ' ', rom_str).strip()
    source = 'derived' if used_syl_fix else 'engine-auto'
    return rom_str, source, None


def main():
    with open('全課-不確定清單.tsv') as f:
        rows = list(csv.DictReader(f, delimiter='\t'))
    print('total rows:', len(rows))

    resolved = []
    unresolved = []
    cache = {}
    for row in rows:
        thai = row['泰文']
        if thai not in cache:
            cache[thai] = resolve_word(thai)
        rom, source, err = cache[thai]
        if rom:
            resolved.append({
                '泰文': thai, '舊拼音(Sheet)': row['舊拼音(Sheet)'],
                '新拼音(目的達)': rom, '中文': row['中文'],
                '來源': source, '備註': '',
            })
        else:
            unresolved.append({
                '泰文': thai, '舊拼音(Sheet)': row['舊拼音(Sheet)'],
                '中文': row['中文'], '課次': row['課次'],
                '無法處理的音節': err or row['無法處理的音節'],
            })

    with open('全課-不確定清單-已解決.tsv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['泰文', '舊拼音(Sheet)', '新拼音(目的達)', '中文', '來源', '備註'], delimiter='\t')
        w.writeheader()
        w.writerows(resolved)

    with open('全課-仍不確定清單.tsv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['泰文', '舊拼音(Sheet)', '中文', '課次', '無法處理的音節'], delimiter='\t')
        w.writeheader()
        w.writerows(unresolved)

    print('resolved:', len(resolved), 'unresolved:', len(unresolved))
    from collections import Counter
    print('source distribution:', Counter(r['來源'] for r in resolved))

if __name__ == '__main__':
    main()

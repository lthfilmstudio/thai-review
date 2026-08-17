import re, json, glob, os, sys
from collections import defaultdict

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
TXT_DIR = os.path.join(OUT_DIR, "pdf-text")

THAI_RE = re.compile(r'[฀-๿]')
LATIN_TONE_RE = re.compile(r"[A-Za-zāēīōūɛɔəɯ\.\-~\^ˋˊˇ'\/\d\s]+")

def thai_only(s):
    return ''.join(ch for ch in s if not ch.isspace())

def split_line(line):
    # find contiguous Thai-script run(s) as the anchor column
    # a "run" allows internal ascii spaces (pdftotext justification artifacts)
    # but stops at 2+ consecutive spaces (real column boundary) or Chinese/CJK char
    m = re.search(r'[฀-๿](?:[฀-๿ ัิ-ฺ็-๎]*[฀-๿็-๎])?', line)
    if not m:
        return None
    thai_start, thai_end = m.start(), m.end()
    left = line[:thai_start]
    right = line[thai_end:]
    thai = thai_only(m.group())
    if not thai:
        return None
    return left.strip(), thai, right.strip()

def looks_like_romanization(s):
    s = s.strip()
    if not s:
        return False
    if not re.match(r"^[A-Za-zāēīōūɛɔəɯĀĒĪŌŪƐƆƏƜ]", s):
        return False
    # reject pure chinese/english prose headers
    if re.search(r'[一-鿿]', s):
        return False
    return True

pairs = defaultdict(lambda: defaultdict(int))  # thai -> romanization -> count
sources = defaultdict(set)  # thai -> set of source files

files = sorted(glob.glob(os.path.join(TXT_DIR, "*.txt")))
total_lines = 0
matched_lines = 0
for fp in files:
    with open(fp, encoding='utf-8') as f:
        lines = f.readlines()
    for line in lines:
        line = line.rstrip('\n')
        if not THAI_RE.search(line):
            continue
        total_lines += 1
        res = split_line(line)
        if not res:
            continue
        left, thai, right = res
        if len(thai) < 1:
            continue
        if looks_like_romanization(left):
            pairs[thai][left.strip()] += 1
            sources[thai].add(os.path.basename(fp))
            matched_lines += 1

print(f"total thai-bearing lines: {total_lines}, matched with romanization: {matched_lines}", file=sys.stderr)
print(f"unique thai keys: {len(pairs)}", file=sys.stderr)

# collapse to best (most frequent) romanization per thai key
best = {}
conflicts = {}
for thai, cands in pairs.items():
    ranked = sorted(cands.items(), key=lambda kv: -kv[1])
    best[thai] = ranked[0][0]
    if len(ranked) > 1:
        conflicts[thai] = ranked

with open(os.path.join(OUT_DIR, "handout_dict.json"), "w", encoding='utf-8') as f:
    json.dump(best, f, ensure_ascii=False, indent=1)

print(f"conflicts (thai key with >1 distinct romanization string): {len(conflicts)}", file=sys.stderr)
for thai, ranked in list(conflicts.items())[:15]:
    print(thai, ranked, file=sys.stderr)

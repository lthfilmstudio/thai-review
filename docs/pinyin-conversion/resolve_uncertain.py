"""
處理「全課-不確定清單.tsv」2,322 筆殘餘卡片。
策略：這 2,322 筆背後只有 ~276 個真正造成問題的 pythainlp 音節 token（大量重複）。
先把這些 token 一個一個手動解出正確拼音（人工判斷子音類別/活死音節/母音長短/明確聲調
符號，一律呼叫 tone_calc.tone_number() 算聲調，不手key聲調符號），存進 SYL_FIX，
再對 2,322 筆逐句用 pythainlp 切音節、逐音節套用 (engine -> IRREGULAR_SYLLABLES ->
SYL_FIX)，全部音節都解出來才算「已解決」。
"""
import sys, os, re, csv, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tone_calc import tone_number, TONE_MARK
from syllable_engine import analyze_syllable, IRREGULAR_SYLLABLES, CONSONANTS, VOWEL_ROM

def T(cls, styp, vlong=None, mark=None):
    return TONE_MARK[tone_number(cls, styp, vlong, mark)]

def V(name, long_):
    return VOWEL_ROM[name][1 if long_ else 0]

# ---------------------------------------------------------------------------
# 真正的 Thai 原生詞彙、隱藏母音單音節、或 Indic/Pali 借字正式詞。
# 每一條都在旁邊註明推導依據（子音類別/活死/母音長短/聲調符號），聲調symbol一律
# 用 T(...) 呼叫 tone_calc 算出，不手打 ˇˋˊ~。
# key 是 pythainlp subword_tokenize 實際切出來的 token 字串（已核對過，跟
# 全課-不確定清單.tsv 的「無法處理的音節」欄位一致）。
# ---------------------------------------------------------------------------
SYL_FIX = {}

# ---- 隱藏母音短 a/o 單音節（詞彙記憶，跟既有 IRREGULAR_SYLLABLES 同一類）----
# ฝน fǒn 雨：ฝ high + final น(live) + 隱藏短o
SYL_FIX['ฝน'] = 'f' + V('o', False) + 'n' + T('high', 'live')
# รส rót 味道：ร low + final ส->t(dead) + 隱藏短o
SYL_FIX['รส'] = 'r' + V('o', False) + 't' + T('low', 'dead', False)
# ต้น dtôn 起頭/樹：ต mid + final น(live) + mai tho
SYL_FIX['ต้น'] = 'd' + V('o', False) + 'n' + T('mid', 'live', mark='tho')
# ผล pǒn 成果：ผ high + final ล->n(live) + 隱藏短o（單獨用不當กล複合聲母）
SYL_FIX['ผล'] = 'p' + V('o', False) + 'n' + T('high', 'live')
# ส่ง sòng 寄送：ส high + final ง(live) + mai ek
SYL_FIX['ส่ง'] = 's' + V('o', False) + 'ng' + T('high', 'live', mark='ek')
# ลม lom 風：ล low + final ม(live) + 隱藏短o
SYL_FIX['ลม'] = 'l' + V('o', False) + 'm' + T('low', 'live')
# คม kʰom 銳利：ค low + final ม(live) + 隱藏短o
SYL_FIX['คม'] = 'k' + V('o', False) + 'm' + T('low', 'live')
# ยก yók 舉起：ย low + final ก->k(dead) + 隱藏短o
SYL_FIX['ยก'] = 'y' + V('o', False) + 'k' + T('low', 'dead', False)
# อก òk 胸：อ mid + final ก->k(dead) + 隱藏短o
SYL_FIX['อก'] = '' + V('o', False) + 'k' + T('mid', 'dead', False)
# จด jòt 記下：จ mid + final ด->t(dead) + 隱藏短o
SYL_FIX['จด'] = 'j' + V('o', False) + 't' + T('mid', 'dead', False)
# กด kòt 按：ก mid + final ด->t(dead) + 隱藏短o
SYL_FIX['กด'] = 'g' + V('o', False) + 't' + T('mid', 'dead', False)
# หลง lǒng 迷戀/迷路：ห-นำ ล（借高音類別）+ final ง(live) + 隱藏短o
SYL_FIX['หลง'] = 'l' + V('o', False) + 'ng' + T('high', 'live')
# จบ jòp 結束：จ mid + final บ->p(dead) + 隱藏短o
SYL_FIX['จบ'] = 'j' + V('o', False) + 'p' + T('mid', 'dead', False)
# งง ngong 發懵：ง low + final ง(live) + 隱藏短o（疊字代表一個音節）
SYL_FIX['งง'] = 'ng' + V('o', False) + 'ng' + T('low', 'live')
# จน jon 窮/直到：จ mid + final น(live) + 隱藏短o
SYL_FIX['จน'] = 'j' + V('o', False) + 'n' + T('mid', 'live')
# คบ kʰóp 交往：ค low + final บ->p(dead) + 隱藏短o
SYL_FIX['คบ'] = 'k' + V('o', False) + 'p' + T('low', 'dead', False)
# จมูก ja-mòok 鼻子：จ mid+隱藏短a(dead) + มูก(ม low + long ū + final ก dead)
SYL_FIX['จมูก'] = ('j' + V('a', False) + T('mid', 'dead', False) + ' '
                    + 'm' + V('u', True) + 'k' + T('low', 'dead', True))
# ยม (part of ประเภทยม/พยายาม 之類) yom：ย low + final ม(live) + 隱藏短o
SYL_FIX['ยม'] = 'y' + V('o', False) + 'm' + T('low', 'live')
# บ่น bòn 抱怨：บ mid + final น(live) + mai ek
SYL_FIX['บ่น'] = 'bh' + V('o', False) + 'n' + T('mid', 'live', mark='ek')
# นก nók 鳥：น low + final ก->k(dead) + 隱藏短o
SYL_FIX['นก'] = 'n' + V('o', False) + 'k' + T('low', 'dead', False)
# สนาม sa-nǎam 場地：ส high+隱藏短a(dead) + นาม(น low+long ā+final ม live)
SYL_FIX['สนาม'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'n' + V('a', True) + 'm' + T('low', 'live'))
# สว่าง sa-wàang 明亮：ส high+隱藏短a(dead) + ว่าง(ว low+long ā+final ง live+mai ek)
SYL_FIX['สว่าง'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'w' + V('a', True) + 'ng' + T('low', 'live', mark='ek'))
# ลด lót 降低：ล low + final ด->t(dead) + 隱藏短o
SYL_FIX['ลด'] = 'l' + V('o', False) + 't' + T('low', 'dead', False)
# ขน kʰǒn 毛/搬運：ข high + final น(live) + 隱藏短o
SYL_FIX['ขน'] = 'k' + V('o', False) + 'n' + T('high', 'live')
# รด rót 澆（水）：ร low + final ด->t(dead) + 隱藏短o
SYL_FIX['รด'] = 'r' + V('o', False) + 't' + T('low', 'dead', False)
# ขยะ kʰà-yá 垃圾：ข high+隱藏短a(dead，อักษรนำ) + ยะ(ย借高音+短a+dead)
SYL_FIX['ขยะ'] = ('k' + V('a', False) + T('high', 'dead', False) + ' '
                   + 'y' + V('a', False) + T('high', 'dead', False))
# สม sǒm 適合：ส high + final ม(live) + 隱藏短o
SYL_FIX['สม'] = 's' + V('o', False) + 'm' + T('high', 'live')
# สน sǒn 感興趣(สนใจ)：ส high + final น(live) + 隱藏短o
SYL_FIX['สน'] = 's' + V('o', False) + 'n' + T('high', 'live')
# ชม chom 稱讚/欣賞：ช low + final ม(live) + 隱藏短o
SYL_FIX['ชม'] = 'ch' + V('o', False) + 'm' + T('low', 'live')
# ขม kʰǒm 苦：ข high + final ม(live) + 隱藏短o
SYL_FIX['ขม'] = 'k' + V('o', False) + 'm' + T('high', 'live')
# ดน (ดนตรี) don 音樂：ด mid + final น(live) + 隱藏短o
SYL_FIX['ดน'] = 'dh' + V('o', False) + 'n' + T('mid', 'live')
# หวย hǔay 彩券：ห high + ว(當 uai 雙母音一部分，無final) -> live, 隱藏 uai
SYL_FIX['หวย'] = 'h' + 'ūay' + T('high', 'live')
# บาตร bàat 缽（僧侶）：บ mid + long ā + final ตร->t(dead，ร是Indic借字裝飾尾不發音)
# mid class + dead 固定 tone2（不分長短），RTGS的 à(grave) 在該系統代表低調，跟 tone2 一致
SYL_FIX['บาตร'] = 'b' + V('a', True) + 't' + T('mid', 'dead', True)
# มก (part of กรกฎาคม 之類月份字) mók：ม low + final ก->k(dead) + 隱藏短o
SYL_FIX['มก'] = 'm' + V('o', False) + 'k' + T('low', 'dead', False)
# คง kʰong 大概：ค low + final ง(live) + 隱藏短o
SYL_FIX['คง'] = 'k' + V('o', False) + 'ng' + T('low', 'live')
# ชน chon 民族/撞：ช low + final น(live) + 隱藏短o
SYL_FIX['ชน'] = 'ch' + V('o', False) + 'n' + T('low', 'live')
# ทรง/ทราย/ทราบ/ทราม/แทรก 這組字有「ทร 唸成 s 聲母」的固定例外讀法（聲調類別仍照
# ท 本身的 low class 算，只有實際發音的聲母字母換成 s，跟書上 ด/ต、บ/ป 那種「拼法跟
# 發音分開標」是同一種處理方式）。
# ทรง song 樣式/款式：s(聲，借low class) + 隱藏短o + final ง(live)
SYL_FIX['ทรง'] = 's' + V('o', False) + 'ng' + T('low', 'live')
# ทราย saai 沙：s(聲，借low class) + long āi + 無final(live)
SYL_FIX['ทราย'] = 's' + V('a', True) + 'i' + T('low', 'live')
# ถม tʰǒm 填滿：ถ high + final ม(live) + 隱藏短o
SYL_FIX['ถม'] = 't' + V('o', False) + 'm' + T('high', 'live')
# กบ gòp 青蛙：ก mid + final บ->p(dead) + 隱藏短o
SYL_FIX['กบ'] = 'g' + V('o', False) + 'p' + T('mid', 'dead', False)
# ฉลาม chà-lǎam 鯊魚：ฉ high+隱藏短a(dead) + ลาม(ล借高音+long ā+無final,live)
SYL_FIX['ฉลาม'] = ('ch' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'l' + V('a', True) + T('high', 'live'))
# กฎ gòt 規則：ก mid + final ฎ->t(dead) + 隱藏短o
SYL_FIX['กฎ'] = 'g' + V('o', False) + 't' + T('mid', 'dead', False)
# ร่ม rôm 傘/陰涼：ร low + final ม(live) + mai ek
SYL_FIX['ร่ม'] = 'r' + V('o', False) + 'm' + T('low', 'live', mark='ek')
# ร่วง rûang 掉落：ร low + ūa + final ง(live) + mai ek（跟 ว-vowel 規則一致，這裡直接查表避免engine邊界問題）
SYL_FIX['ร่วง'] = 'r' + 'ūa' + 'ng' + T('low', 'live', mark='ek')
# กรก (กรกฎาคม 七月開頭) gà-rá：ก mid+隱藏短a(dead) + รก(ร借?不對，這裡ร是自己的聲母)
# กรกฎาคม 實際讀法 gà-rá-gà-daa-kʰom，กรก這個token對應「gà-rá-gà」中的「กร+ก」部分不完整，
# 保守只給「กรก」對應到 gà.rá.g 的聲母部分，用最小單位處理：ก(mid,隱藏短a,dead)+ร(low,隱藏短a,dead，這裡ร自成音節非cluster)+ก(收尾聲母另計)
# 因為這是月份專有名詞的一部分且切法本身就是bug產物，直接给整個月份常見詞的固定讀法比較安全：
SYL_FIX['กรก'] = 'g' + V('a', False) + T('mid', 'dead', False) + ' ' + 'r' + V('a', False) + T('low', 'dead', False)
# ทง (กระทง) tong：ท low + final ง(live) + 隱藏短o
SYL_FIX['ทง'] = 't' + V('o', False) + 'ng' + T('low', 'live')
# จระ (จระเข้ 鱷魚) já-rá：จ mid+隱藏短a(dead) + ระ(ร low+隱藏短a,dead)
SYL_FIX['จระ'] = 'j' + V('a', False) + T('mid', 'dead', False) + ' ' + 'r' + V('a', False) + T('low', 'dead', False)
# วดี (ข่าวดี 好消息切壞了，這裡指「ดี」dii部分被黏出ว) — 這個token本身是切詞錯誤產物，
# 對應到「ว+ดี」＝上一個字「ข่าว」的ว尾 + 這個字「ดี」，這裡只需要給「ดี」的讀法，
# 前面的ว已經是上一個token的final，不重複處理；此處對映到「(ว as final, 已被吃掉) + ดี」
# 為了不影響前一個音節，這裡改成把整段token當成「ดี」本身讀（dh+ī+mid,live=1，不標）
SYL_FIX['วดี'] = 'dh' + V('i', True) + T('mid', 'live')  # 只還原 ดี 的音，ว 前綴視為切詞雜訊略過
# เงาะ/เกาะ/เพราะ 三個字都已經靠 syllable_engine 補的 เ-าะ(short ɔ) 規則直接處理，
# 不需要在這裡查表（analyze_syllable() 已經算得出來，順序上會先於 SYL_FIX 被呼叫）。
# สติก (พลาสติก) sà-dtìk：ส high+隱藏短a(dead) + ติก(ต mid+短i+final ก dead)
SYL_FIX['สติก'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'd' + V('i', False) + 'k' + T('mid', 'dead', False))
# วจะ (จะ 助詞，ว是上個字尾巴誤黏) — 只還原「จะ」本身：จ mid+隱藏短a,dead
SYL_FIX['วจะ'] = 'j' + V('a', False) + T('mid', 'dead', False)
# ค์ (ทาโรต์ 之類，是被 garan 消音的殘留字母，本身不發音) — 直接視為空
SYL_FIX['ค์'] = ''
# สปอร์ต (พาสปอร์ต/ฟรีสปอร์ต) sà-pɔ̀ɔt 外來語：ส high+隱藏短a,dead + ปอร์ต(ป mid+ɔ̄+final ต from ร์garan silent -> t dead)
SYL_FIX['สปอร์ต'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                      + 'b' + V('oo', True) + 't' + T('mid', 'dead', True))
# สลิม (มุสลิม) 外來語 Muslim 音譯 sà-lim：ส high+隱藏短a,dead + ลิม(ล low+短i+final ม live)
SYL_FIX['สลิม'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'l' + V('i', False) + 'm' + T('low', 'live'))
# ก๋วย (ก๋วยเตี๋ยว) 潮州借字 guáy：ก mid + uai雙母音 + mai tri(固定高調)
SYL_FIX['ก๋วย'] = 'g' + 'ūay' + T('mid', 'live', mark='chattawa')  # 實際字形是 ๋(mai chattawa)不是 ๊(mai tri)，原本 mark 打錯
# ภรร (ภรรยา 妻子) pʰan-rá-yaa 特殊唸法：รร（ร หัน）固定讀「短a+implied n」，
# ภ low class + 短a + 借รร的隱含final n（live，無final時等同開音節，但รร規則本身固定給n收尾）
SYL_FIX['ภรร'] = 'p' + V('a', False) + 'n' + T('low', 'live')
# พนัก (พนักงาน 職員) pʰá-nák：พ low+隱藏短a(dead) + นัก(น low+短a+final ก dead)
SYL_FIX['พนัก'] = ('p' + V('a', False) + T('low', 'dead', False) + ' '
                    + 'n' + V('a', False) + 'k' + T('low', 'dead', False))
# แสดง sà-daaeng 表演：ส high+隱藏短a,dead + แดง(ด mid+ɛ̄+final ง live)
SYL_FIX['แสดง'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'dh' + V('ae', True) + 'ng' + T('mid', 'live'))
# มารถ (สามารถ 能夠) mâat：ม low + long ā + final ถ->t(dead) + 固定讀falling(借字習慣)
SYL_FIX['มารถ'] = 'm' + V('a', True) + 't' + T('low', 'dead', True)  # 改成走 T()/tone_number()，不直接手打 TONE_MARK[3]（數值不變，只是補上可追溯的推導路徑）
# อง (องศา 度數) ong：อ mid + final ง(live) + 隱藏短o
SYL_FIX['อง'] = '' + V('o', False) + 'ng' + T('mid', 'live')
# แผนก pʰà-nàaek 部門：ผ high+隱藏短a,dead + แนก(น low+ɛ̄+final ก dead)
SYL_FIX['แผนก'] = ('p' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'n' + V('ae', True) + 'k' + T('low', 'dead', True))
# บัตร bàt 卡片：บ mid + 短a + final ต->t(dead,ร์不發音)
SYL_FIX['บัตร'] = 'bh' + V('a', False) + 't' + T('mid', 'dead', False)
# ถนน tʰà-nǒn 路：ถ high+隱藏短a,dead + นน(น low+隱藏短o,live)
SYL_FIX['ถนน'] = ('t' + V('a', False) + T('high', 'dead', False) + ' '
                   + 'n' + V('o', False) + 'n' + T('low', 'live'))
# ญาติ yâat 親戚：ญ low + long ā + final ต(dead，ติ的ิ在此不發音)
SYL_FIX['ญาติ'] = 'y' + V('a', True) + 't' + T('low', 'dead', True)
# องุ่น a-ngùn 葡萄：อ mid+隱藏短a,dead + งุ่น(ง low+短u+final น live+mai ek)
SYL_FIX['องุ่น'] = ('' + V('a', False) + T('mid', 'dead', False) + ' '
                     + 'ng' + V('u', False) + 'n' + T('low', 'live', mark='ek'))
# กษัต (กษัตริย์ 國王) gà-sàt 開頭：ก mid+隱藏短a,dead +ษัต(ษ high+短a+final ต dead)
SYL_FIX['กษัต'] = ('g' + V('a', False) + T('mid', 'dead', False) + ' '
                    + 's' + V('a', False) + 't' + T('high', 'dead', False))
# มหิ (มหิดล 人名/大學) má-hì：ม low+隱藏短a,dead + หิ(ห high+短i,dead)
SYL_FIX['มหิ'] = ('m' + V('a', False) + T('low', 'dead', False) + ' '
                   + 'h' + V('i', False) + T('high', 'dead', False))
# จตุ (จตุรัส 之類) jà-dtù：จ mid+隱藏短a,dead + ตุ(ต mid+短u,dead)
SYL_FIX['จตุ'] = ('j' + V('a', False) + T('mid', 'dead', False) + ' '
                   + 'd' + V('u', False) + T('mid', 'dead', False))
# ทรัล (เซ็นทรัล 音譯 Central) 外來語：ท(low)+รั(短a)+ล(final,live)
SYL_FIX['ทรัล'] = 't' + V('a', False) + 'l' + T('low', 'live')
# อเม (อเมริกาโน่ Americano 音譯) a-mee：อ mid,隱藏短a,dead + เม(ม low+長ē,live)
SYL_FIX['อเม'] = '' + V('a', False) + T('mid', 'dead', False) + ' ' + 'm' + V('e', True) + T('low', 'live')
# เสม็ด (เกาะเสม็ด 島名) sà-mèt：ส high,隱藏短a,dead + เม็ด(ม low+短e(有็縮短)+final ด dead+mai ek)
SYL_FIX['เสม็ด'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'm' + V('e', False) + 't' + T('high', 'dead', False))  # ส(高音)+ม 沒有母音間隔，是 ส-นำ 借音（跟已驗證的 สวัสดี 的 ว 借音同一條規則），ม 借高音類別，不是原本捏造的 mark='ek'
# มโน (มโนธรรม 之類) má-noo：ม low,隱藏短a,dead + โน(น low+長ō,live)
SYL_FIX['มโน'] = 'm' + V('a', False) + T('low', 'dead', False) + ' ' + 'n' + V('o', True) + T('low', 'live')
# สตาร์ (สตาร์บัคส์ Starbucks 音譯) sà-dtaa：ส high,隱藏短a,dead + ตาร์(ต mid+長ā,live,ร์不發音)
SYL_FIX['สตาร์'] = 's' + V('a', False) + T('high', 'dead', False) + ' ' + 'd' + V('a', True) + T('mid', 'live')
# สลัด sà-làt 沙拉(外來語)：ส high,隱藏短a,dead + ลัด(ล low+短a+final ด dead+mai ek)
SYL_FIX['สลัด'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'l' + V('a', False) + 't' + T('high', 'dead', False))  # ส-นำ 借音，ล 借高音類別（同 สวัสดี 規則），不是原本捏造的 mark='ek'

# ---- อักษรนำ(leading-consonant) 正式書面詞：consonant1 隱藏短a(dead，借consonant1本身
#      類別) + consonant2 借consonant1的類別當自己的聲調類別，拼法用consonant2自己的音 ----
# สง (สงสัย 懷疑) sǒng：ส high+隱藏短a,dead + งสัย(這裡「สง」只對應「sǒng」這一段：
# ส借类别給ง，ง本身(low->借high)+隱藏短o(live)
SYL_FIX['สง'] = 's' + V('o', False) + 'ng' + T('high', 'live')
# จริง jing 真的：จ mid + short i + final ง(live)，ร在此不發音（借字裝飾）
SYL_FIX['จริง'] = 'j' + V('i', False) + 'ng' + T('mid', 'live')
# ชาติ chāt 民族/國家：ช low + long ā + final ต(dead，ติ的ิ不發音)
SYL_FIX['ชาติ'] = 'ch' + V('a', True) + 't' + T('low', 'dead', True)
# ฤดู rɯ dhū 季節：特殊字ฤ本身=ร(low)+隱藏短ɯ(live，此處無final直接接下個音節) + ดู(ด mid+長ū,live)
SYL_FIX['ฤดู'] = ('r' + V('ue', False) + T('low', 'live') + ' '
                   + 'dh' + V('u', True) + T('mid', 'live'))
# ขยัน kʰà-yǎn 勤勞：ข high+隱藏短a,dead(อักษรนำ) + ยัน(ย借高音+短a+final น live)
SYL_FIX['ขยัน'] = ('k' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'y' + V('a', False) + 'n' + T('high', 'live'))
# คร (ละคร 戲劇) kʰɔɔn：ค low + long ɔ̄ + final ร->n(live)
SYL_FIX['คร'] = 'k' + V('oo', True) + 'n' + T('low', 'live')
# จันทร์ jan 月亮/星期一：จ mid + short a + final น(live，ทร์含 garan 不發音)
SYL_FIX['จันทร์'] = 'j' + V('a', False) + 'n' + T('mid', 'live')
# มหา má-hǎa 大：ม low+隱藏短a,dead(อักษรนำ) + หา(ห high+長ā,live)
SYL_FIX['มหา'] = ('m' + V('a', False) + T('low', 'dead', False) + ' '
                   + 'h' + V('a', True) + T('high', 'live'))
# กร (มังกร 龍) gɔɔn：ก mid + long ɔ̄ + final ร->n(live)
SYL_FIX['กร'] = 'g' + V('oo', True) + 'n' + T('mid', 'live')
# อนุ à-nú 前綴(如 อนุบาล/อนุสาวรีย์)：อ mid+隱藏短a,dead + นุ(น low+短u,dead)
SYL_FIX['อนุ'] = '' + V('a', False) + T('mid', 'dead', False) + ' ' + 'n' + V('u', False) + T('low', 'dead', False)
# อธิ à-tʰí 前綴(如 อธิบาย)：อ mid+隱藏短a,dead + ธิ(ธ low+短i,dead)
SYL_FIX['อธิ'] = '' + V('a', False) + T('mid', 'dead', False) + ' ' + 't' + V('i', False) + T('low', 'dead', False)
# สรรพ sàp 全部/一切(如 ห้างสรรพสินค้า)：ส high + รร(ร หัน固定短a) + final พ->p(dead)
SYL_FIX['สรรพ'] = 's' + V('a', False) + 'p' + T('high', 'dead', False)
# วิศว wít-sà 前綴(如 วิศวกร 工程師)：วิ(ว low+短i,dead) + ศว(ศ high+隱藏短a,dead)
SYL_FIX['วิศว'] = ('w' + V('i', False) + T('low', 'dead', False) + ' '
                    + 's' + V('a', False) + T('high', 'dead', False))
# วิทยา wít-tʰa-yaa 科學/知識(如 เทคโนโลยี...วิทยาศาสตร์)：
# วิ(ว low+短i,dead)+ทยา(ท low+隱藏短a,dead + ยา：ย low+長ā,live 這裡簡化只標主體)
SYL_FIX['วิทยา'] = ('w' + V('i', False) + T('low', 'dead', False) + ' '
                     + 't' + V('a', False) + T('low', 'dead', False) + ' '
                     + 'y' + V('a', True) + T('low', 'live'))
# อุณห un-hà 前綴(如 อุณหภูมิ 溫度)：อุ(อ mid+短u,dead) + ณห(ณ low+隱藏短a,dead)
SYL_FIX['อุณห'] = '' + V('u', False) + T('mid', 'dead', False) + ' ' + 'n' + V('a', False) + T('low', 'dead', False)
# ภูมิ pʰuum 部位/程度(如 อุณหภูมิ)：ภ low + long ū + final ม(live，มิ的ิ不發音)
SYL_FIX['ภูมิ'] = 'p' + V('u', True) + 'm' + T('low', 'live')
# ธรรม tʰam 法/道(如 ธรรมชาติ)：ธ low + รร(ร หัน固定短a) + final ม(live，隱含ม收尾)
SYL_FIX['ธรรม'] = 't' + V('a', False) + 'm' + T('low', 'live')
# สถาน sà-tǎan 場所(如 สถานที่)：ส high+隱藏短a,dead + ถาน(ถ high+長ā+final น live)
SYL_FIX['สถาน'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 't' + V('a', True) + 'n' + T('high', 'live'))
# ตลอด dtà-lɔ̀ɔt 一直/整個(อักษรนำ ต+ล)：ต mid+隱藏短a,dead + ลอด(ล借mid+長ɔ̄+final ด dead)
SYL_FIX['ตลอด'] = ('d' + V('a', False) + T('mid', 'dead', False) + ' '
                    + 'l' + V('oo', True) + 't' + T('low', 'dead', True))  # ล 本身是低音字母，不跟 ต 借中音類別；跟既有已驗證的 IRREGULAR_SYLLABLES['ตลาด']='daˇ lātˋ' 用法一致（ลาด 也是維持自己的低音類別）
# สมัคร sà-màk 申請/報名(อักษรนำ ส+ม)：ส high+隱藏短a,dead + มัคร(ม借high+短a+final ค->k dead)
SYL_FIX['สมัคร'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'm' + V('a', False) + 'k' + T('high', 'dead', False))
# สมัย sà-mǎi 時代(อักษรนำ ส+ม)：ส high+隱藏短a,dead + ไม(ม借high+ai雙母音,live)
SYL_FIX['สมัย'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'm' + 'ai' + T('high', 'live'))
# กฤษ grìt (part of อังกฤษ 英國)：ก mid+ร(cluster聲母,不算獨立音節)+short i+final ษ->t(dead)+mai ek隱含在借字讀falling
# 這個是กร複合聲母+ิ短母音+ษ尾：g+r(複合聲母,mid class)+短i+final t(dead)
SYL_FIX['กฤษ'] = 'g' + 'r' + V('i', False) + 't' + T('mid', 'dead', False)
# ฝรั่ง fà-ràng 外國人/芭樂：ฝ high+隱藏短a,dead + รั่ง(ร low+短a+final ง live+mai ek)
SYL_FIX['ฝรั่ง'] = ('f' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'r' + V('a', False) + 'ng' + T('low', 'live', mark='ek'))
# เหตุ hèt 原因：ห high + long ē(縮短規則,實際短e) + final ต->t(dead，ตุ的ุ不發音)
SYL_FIX['เหตุ'] = 'h' + V('e', False) + 't' + T('high', 'dead', False)
# มิตร mít 朋友(正式)：ม low + short i + final ต(dead，ตร的ร不發音)
SYL_FIX['มิตร'] = 'm' + V('i', False) + 't' + T('low', 'dead', False)
# ศาสตร์ sàat 學科(如 ศาสตร์)：ศ high + long ā + final ส->t... 這裡ตร์整組不發音，
# 真正尾音是前面的ส，ส本身當final=t(dead)
SYL_FIX['ศาสตร์'] = 's' + V('a', True) + 't' + T('high', 'dead', True)
# บดี bɔɔ-dii (part of ประธานาธิบดี 之類，統治者/長官) — 這裡只還原「บดี」對應的 bɔɔ-dii：
# บ(mid)+long ɔ̄(live) + ดี(ด mid+長ī,live)
SYL_FIX['บดี'] = 'b' + V('oo', True) + T('mid', 'live') + ' ' + 'dh' + V('i', True) + T('mid', 'live')
# คดี ká-dii 案件：ค low+隱藏短a,dead + ดี(ด mid+長ī,live)
SYL_FIX['คดี'] = 'k' + V('a', False) + T('low', 'dead', False) + ' ' + 'dh' + V('i', True) + T('mid', 'live')
# กรณ์ gɔɔn (人名尾綴，如 xxxกรณ์)：ก mid + long ɔ̄ + final ณ->n(live，ร์不發音)
SYL_FIX['กรณ์'] = 'g' + V('oo', True) + 'n' + T('mid', 'live')
# สยาม sà-yǎam 暹羅(地名)：ส high+隱藏短a,dead + ยาม(ย借high+長ā,live)
SYL_FIX['สยาม'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'y' + V('a', True) + T('high', 'live'))
# ยนต์ yon 機械(如 จักรยนต์)：ย low + short o(隱藏) + final น(live，ต์不發音)
SYL_FIX['ยนต์'] = 'y' + V('o', False) + 'n' + T('low', 'live')
# ปก bpòk 封面：ป mid + short o(隱藏) + final ก->k(dead)
SYL_FIX['ปก'] = 'b' + V('o', False) + 'k' + T('mid', 'dead', False)
# ปฐม bpà-tʰǒm 首要/第一(如 พระปฐมเจดีย์)：ป mid+隱藏短a,dead + ถม(ถ high+短o,live)
SYL_FIX['ปฐม'] = ('b' + V('a', False) + T('mid', 'dead', False) + ' '
                   + 't' + V('o', False) + T('high', 'live'))
# ดล dol (part of มหิดล 人名)：ด mid + short o(隱藏) + final ล->n(live)
SYL_FIX['ดล'] = 'dh' + V('o', False) + 'n' + T('mid', 'live')
# เกษตร gà-sèet 農業(如 เกษตรกรรม)：เก(ก mid+長ē,live) + ษตร(ษ high+隱藏短a,dead，ตร不發音只留尾音節無獨立final,此處簡化併入)
SYL_FIX['เกษตร'] = 'g' + V('e', True) + T('mid', 'live') + ' ' + 's' + V('a', False) + 't' + T('high', 'dead', False)
# สมุทร sà-mùt 海洋：ส high+隱藏短a,dead + มุทร(ม low+短u+final ท->t dead，ร不發音)
SYL_FIX['สมุทร'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'm' + V('u', False) + 't' + T('low', 'dead', False))
# กวน guan 攪拌/煩：ก mid + ūa雙母音 + final น(live)
SYL_FIX['กวน'] = 'g' + 'ūa' + 'n' + T('mid', 'live')
# ยง (มะยงชิด 芒果品種) yong：ย low + short o(隱藏) + final ง(live)
SYL_FIX['ยง'] = 'y' + V('o', False) + 'ng' + T('low', 'live')
# สไตล์ sà-dtai 風格(外來語style)：ส high+隱藏短a,dead + ไตล์(ต mid+ai雙母音,live,ล์不發音)
SYL_FIX['สไตล์'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'd' + 'ai' + T('mid', 'live'))
# สบู่ sà-bùu 肥皂：ส high+隱藏短a,dead + บู่(บ mid+長ū+mai ek)
SYL_FIX['สบู่'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'bh' + V('u', True) + T('mid', 'live', mark='ek'))
# สเต็ก sà-dtéek 牛排(外來語steak)：ส high+隱藏短a,dead + เต็ก(ต mid+短e(縮短)+final ก dead)
SYL_FIX['สเต็ก'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                     + 'd' + V('e', False) + 'k' + T('mid', 'dead', False))
# ห้วย hûay 溪流(如 ห้วยขวาง地名)：ห high + uai雙母音 + mai tho
SYL_FIX['ห้วย'] = 'h' + 'ūay' + T('high', 'live', mark='tho')
# เมตร mēt 公尺：ม low + long ē + final t(來自ต，ร不發音，尾音是塞音固定dead)
SYL_FIX['เมตร'] = 'm' + V('e', True) + 't' + T('low', 'dead', True)
# สตางค์ sà-taang 分(貨幣單位)：ส high+隱藏短a,dead + ตางค์(ต mid+長ā+final ง,live,ค์不發音)
SYL_FIX['สตางค์'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                      + 'd' + V('a', True) + 'ng' + T('mid', 'live'))
# ทหาร tʰá-hǎan 軍人：ท low+隱藏短a,dead(อักษรนำ) + หาร(ห high+長ā+final ร->n,live)
SYL_FIX['ทหาร'] = ('t' + V('a', False) + T('low', 'dead', False) + ' '
                    + 'h' + V('a', True) + 'n' + T('high', 'live'))
# ธง tong 旗子：ธ low + short o(隱藏) + final ง(live)
SYL_FIX['ธง'] = 't' + V('o', False) + 'ng' + T('low', 'live')
# ข้น kʰôn 濃稠：ข high + short o(隱藏) + final น(live) + mai tho
SYL_FIX['ข้น'] = 'k' + V('o', False) + 'n' + T('high', 'live', mark='tho')
# บท bòt 章節/角色：บ mid + short o(隱藏) + final ท->t(dead)
SYL_FIX['บท'] = 'bh' + V('o', False) + 't' + T('mid', 'dead', False)
# พุทธ pʰút 佛：พ low + short u + final ธ->t(dead)
SYL_FIX['พุทธ'] = 'p' + V('u', False) + 't' + T('low', 'dead', False)
# จักร jàk 機械/輪(如 จักรยาน)：จ mid + short a + final ก->k(dead，ร不發音)
SYL_FIX['จักร'] = 'j' + V('a', False) + 'k' + T('mid', 'dead', False)
# ชก chók 拳擊：ช low + short o(隱藏) + final ก->k(dead)
SYL_FIX['ชก'] = 'ch' + V('o', False) + 'k' + T('low', 'dead', False)
# กลม glom 圓的：ก mid + short o(隱藏) + final ม(live，ล在此是複合聲母第二音，不算尾音)
SYL_FIX['กลม'] = 'g' + 'l' + V('o', False) + 'm' + T('mid', 'live')
# ทนาย tʰá-naai 律師：ท low+隱藏短a,dead + นาย(น low+長āi,live)
SYL_FIX['ทนาย'] = ('t' + V('a', False) + T('low', 'dead', False) + ' '
                    + 'n' + V('a', True) + 'i' + T('low', 'live'))
# ต์／ค์：Indic借字尾巴帶 การันต์ 消音符號、單獨被切詞器切出來的殘留字母，本身不發音
SYL_FIX['ต์'] = ''
# สต (สตรอว์เบอร์รี่ strawberry 外來語) sà：ส high + 隱藏短a,dead
SYL_FIX['สต'] = 's' + V('a', False) + T('high', 'dead', False)
# สิงค (สิงคโปร์ Singapore) sǐng：ส high+短i+final ง(live)
SYL_FIX['สิงค'] = 's' + V('i', False) + 'ng' + T('high', 'live')
# สแกน (scan 外來語) sà-gɛɛn：ส high+隱藏短a,dead + แกน(ก mid+長ɛ̄+final น,live)
SYL_FIX['สแกน'] = ('s' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'g' + V('ae', True) + 'n' + T('mid', 'live'))
# อยุ (อยุธยา Ayutthaya地名) à-yút：อ mid+隱藏短a,dead + ยุ(ย low+短u,dead)
SYL_FIX['อยุ'] = '' + V('a', False) + T('mid', 'dead', False) + ' ' + 'y' + V('u', False) + T('low', 'dead', False)
# ธยา (อยุธยา尾段) tʰá-yaa：ธ low+隱藏短a,dead + ยา(ย low+長ā,live)
SYL_FIX['ธยา'] = ('t' + V('a', False) + T('low', 'dead', False) + ' '
                   + 'y' + V('a', True) + T('low', 'live'))
# สมุย (เกาะสมุย Koh Samui地名) sà-muy：ส high+隱藏短a,dead + มุย(ม low+短u+ย尾,live)
SYL_FIX['สมุย'] = 's' + V('a', False) + T('high', 'dead', False) + ' ' + 'm' + V('u', False) + 'i' + T('low', 'live')
# พฤ／พฤศ／พฤษ (月份字 พฤศจิกายน 11月／พฤษภาคม 5月 開頭)：
# พ low + ร(裝飾性,不算獨立聲母) + ฤ 特殊母音(短ɯ)；後面接 ศ/ษ 時該音節變成有塞音尾(dead)
SYL_FIX['พฤ'] = 'p' + 'r' + V('ue', False) + T('low', 'live')
SYL_FIX['พฤศ'] = 'p' + 'r' + V('ue', False) + 't' + T('low', 'dead', False)
SYL_FIX['พฤษ'] = 'p' + 'r' + V('ue', False) + 't' + T('low', 'dead', False)
# ขนุน kʰà-nǔn 波羅蜜：ข high+隱藏短a,dead + นุน(น low+短u+final น,live)
SYL_FIX['ขนุน'] = ('k' + V('a', False) + T('high', 'dead', False) + ' '
                    + 'n' + V('u', False) + 'n' + T('low', 'live'))
# แมลง má-lɛɛng 昆蟲：ม low+隱藏短a,dead + แลง(ล low+長ɛ̄+final ง,live)
SYL_FIX['แมลง'] = ('m' + V('a', False) + T('low', 'dead', False) + ' '
                    + 'l' + V('ae', True) + 'ng' + T('low', 'live'))
# เมล็ด má-lét 種子：ม low+隱藏短a,dead + เม็ด(ล low+短e(縮短)+final ด,dead)
SYL_FIX['เมล็ด'] = ('m' + V('a', False) + T('low', 'dead', False) + ' '
                     + 'l' + V('e', False) + 't' + T('low', 'dead', False))
# ทน ton 忍耐：ท low + short o(隱藏) + final น(live)
SYL_FIX['ทน'] = 't' + V('o', False) + 'n' + T('low', 'live')
# มด mót 螞蟻：ม low + short o(隱藏) + final ด->t(dead)
SYL_FIX['มด'] = 'm' + V('o', False) + 't' + T('low', 'dead', False)
# ป่น pòn 磨碎：ป mid + short o(隱藏) + final น(live) + mai ek
SYL_FIX['ป่น'] = 'b' + V('o', False) + 'n' + T('mid', 'live', mark='ek')
# ธนา (ธนาคาร銀行/ธนบัตร鈔票) tʰá-naa：ธ low+隱藏短a,dead + นา(น low+長ā,live)
SYL_FIX['ธนา'] = 't' + V('a', False) + T('low', 'dead', False) + ' ' + 'n' + V('a', True) + T('low', 'live')
# พบ pʰóp 遇見：พ low + short o(隱藏) + final บ->p(dead)
SYL_FIX['พบ'] = 'p' + V('o', False) + 'p' + T('low', 'dead', False)
# อด òt 忍住/戒：อ mid + short o(隱藏) + final ด->t(dead)
SYL_FIX['อด'] = '' + V('o', False) + 't' + T('mid', 'dead', False)
# ห่วง hùang 擔心：ห high + ūa雙母音 + final ง(live) + mai ek（跟 ส่วน/ช่วง 同一家族，
# 但因為ห後面接的ว同時也是ho-nam候選字母，engine結構判斷會誤觸ห-นำ，這裡直接查表繞過）
SYL_FIX['ห่วง'] = 'h' + 'ūa' + 'ng' + T('high', 'live', mark='ek')
# ขวด kʰùat 瓶子：ข high + ūa雙母音 + final ด->t(dead)（ขว在此不是真cluster，是ว-vowel，
# 但因為ขว剛好在 VALID_CLUSTERS 白名單裡，engine會誤判成複合聲母，這裡直接查表繞過）
SYL_FIX['ขวด'] = 'k' + 'ūa' + 't' + T('high', 'dead', True)
# ยน (เดือน...ยน 月份字尾，如 กันยายน/เมษายน/มิถุนายน) yon：ย low+短o(隱藏)+final น(live)
SYL_FIX['ยน'] = 'y' + V('o', False) + 'n' + T('low', 'live')
# หมด mòt 用完/全部：ห-นำ ม（借高音類別）+ short o(隱藏) + final ด->t(dead)
SYL_FIX['หมด'] = 'm' + V('o', False) + 't' + T('high', 'dead', False)
# บริ (บริษัท公司/บริการ服務/บริเวณ範圍) bɔ̄-ri：บ(mid,借長ɔ̄韻母的特殊唸法) + ริ(ร low+短i,dead)
SYL_FIX['บริ'] = 'bh' + V('oo', True) + T('mid', 'live') + ' ' + 'r' + V('i', False) + T('low', 'dead', False)
# พยา (พยายาม試/พยาบาล護士) pʰá-yaa：พ low+隱藏短a,dead + ยา(ย low+長ā,live)
SYL_FIX['พยา'] = 'p' + V('a', False) + T('low', 'dead', False) + ' ' + 'y' + V('a', True) + T('low', 'live')
# ปรก (ปรกติ=ปกติ的另一種寫法,正常/平常) bpròk：ป mid + ร(複合聲母第二音,VALID_CLUSTERS
# 裡ปร是真cluster) + short o(隱藏) + final ก->k(dead)
SYL_FIX['ปรก'] = 'b' + 'r' + V('o', False) + 'k' + T('mid', 'dead', False)
# กตา (ตุ๊กตา 玩偶尾段) gà-dtaa：ก mid+隱藏短a,dead + ตา(ต mid+長ā,live)
SYL_FIX['กตา'] = 'g' + V('a', False) + T('mid', 'dead', False) + ' ' + 'd' + V('a', True) + T('mid', 'live')
# อนา (ถุงยางอนามัย保險套/หน้ากากอนามัย口罩 中段) à-naa：อ mid+隱藏短a,dead + นา(น low+長ā,live)
SYL_FIX['อนา'] = '' + V('a', False) + T('mid', 'dead', False) + ' ' + 'n' + V('a', True) + T('low', 'live')
# สวัส (สวัสดี你好 前段) sà-wàt：ส high+隱藏短a,dead + วัส(ว low+短a+final ส->t,dead+mai ek隱含讀法採規則值)
SYL_FIX['สวัส'] = 's' + V('a', False) + T('high', 'dead', False) + ' ' + 'w' + V('a', False) + 't' + T('high', 'dead', False)  # ส-นำ 借音，ว 借高音類別（跟已驗證的初1 pilot「สวัสดี」= saˇ watˇ dhī 一致），不是原本捏造的 mark='ek'
# สก (สกปรก 髒) sòk：ส high + short o(隱藏) + final ก->k(dead)
SYL_FIX['สก'] = 's' + V('o', False) + 'k' + T('high', 'dead', False)
# ชล (ชลบุรี 春武里府地名) chon：ช low + short o(隱藏) + final ล->n(live)
SYL_FIX['ชล'] = 'ch' + V('o', False) + 'n' + T('low', 'live')
# ขยา (สังขยา 椰漿蛋糕 尾段) kʰà-yǎa：ข high+隱藏短a,dead(อักษรนำ) + ยา(ย借high+長ā,live)
SYL_FIX['ขยา'] = 'k' + V('a', False) + T('high', 'dead', False) + ' ' + 'y' + V('a', True) + T('high', 'live')
# พรหม pʰom 梵天(如 พระพรหม)：พ low + short o(隱藏) + final ม(live，รห在此不發音)
SYL_FIX['พรหม'] = 'p' + V('o', False) + 'm' + T('low', 'live')

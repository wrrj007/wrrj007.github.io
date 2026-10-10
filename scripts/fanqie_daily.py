# -*- coding: utf-8 -*-
"""
番茄小说榜单每日采集脚本（供 GitHub Actions 每日自动运行）

流程：
  1. 遍历 男频/女频 × 阅读榜/新书榜 × 各分类，调用「分类排行榜 API」获取当日榜单
     （简介/书名/作者为字体加密，需解密），每个榜单最多保存前 40 本
  2. 对每个榜单的前 N 本调用「书籍详情 API」逐本获取详细数据
       阅读榜：前 30 本；新书榜：全部（前 40 本）
     详情来源优先「外部详情接口」，失败时回退到本地 Java 签名包
     （vendor/fqsign，需先启动 http://127.0.0.1:8082 签名服务）
  3. 补充字段：作者等级（需签名）、作者开书、点评人数、催更（均无需签名）
     作者等级/开书结果按作者缓存于 data/authors.json，避免每天重复签名
  4. 输出 JSON 到 fanqie/data/：
       data/index.json              可用日期索引
       data/daily/YYYY-MM-DD.json   当日榜单（男/女频 × 榜单 × 分类）
       data/detail/YYYY-MM-DD.json  当日书籍详情（bookId -> 详情，含近14天在读）
       data/authors.json            作者等级/开书缓存
       data/updates.json            各书「最近更新字数」每日序列（跨天累积）

可用环境变量：
  FANQIE_DATE           指定采集日期归属（YYYY-MM-DD，默认自动推算，见下）
  FANQIE_SAVE_TOP       每个榜单保存前多少本（默认 40）
  FANQIE_DETAIL_TOP     每次详情抓取本数，覆盖阅读榜/新书榜的默认值（留空用默认）
  FANQIE_KEEP_DAYS      历史数据保留天数，超期自动清理（默认 30，设 0 表示永久保留）
  FANQIE_WORKERS        详情抓取线程数（默认 8）
  FANQIE_NO_DETAIL      设为 1 则跳过详情抓取
  FANQIE_SKIP_IF_EXISTS 设为 1 时，若目标日期的数据已存在则跳过（用于定时任务的兜底重跑）
  FANQIE_OUTPUT_DIR     自定义数据输出目录（默认 <仓库根>/fanqie/data）

日期归属规则（番茄榜单每天中午 12:00 之后才更新为「前一天」的数据）：
  - 北京时间 < 12:00 运行：拿到的是「前天」的数据，数据归属日期 = 今天 - 2
  - 北京时间 >= 12:00 运行：拿到的是「昨天」的数据，数据归属日期 = 今天 - 1
  例如 10-10 凌晨 01:00 采集 -> 归属 10-08；10-10 下午 13:00 采集 -> 归属 10-09。
"""

import json
import os
import re
import sys
import time
import random
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

# ============================================================
# 基础配置
# ============================================================
BJ_TZ = timezone(timedelta(hours=8))

RANK_API_URL = "https://fanqienovel.com/api/rank/category/list"
# 外部详情接口（优先使用；失效/超时则回退到本地 Java 签名包）
DETAIL_API_URL = "http://101.35.133.34:5000/api/detail?book_id="
EXTERNAL_TIMEOUT = 20  # 外部详情接口偶发高延迟，超时即走 Java 兜底

RANK_API_LIMIT = 190  # 接口单次最大返回数量

RANK_MOLD_MAP = {"阅读榜": 2, "新书榜": 1}

# 各榜单默认抓取详情的本数（阅读榜只取前 30，新书榜全量）
DETAIL_TOP_DEFAULT = {"阅读榜": 30, "新书榜": 40}

SAVE_TOP_DEFAULT = 40
KEEP_DAYS_DEFAULT = 30
WORKERS_DEFAULT = 8
AUTHOR_TTL_DAYS = 7  # 作者等级/开书缓存的刷新周期

# ---- 本地 Java 签名服务（vendor/fqsign） ----
SIGN_API = "http://127.0.0.1:8082/api/fq-sign/sign"
SIGN_HEALTH = "http://127.0.0.1:8082/api/fq-sign/health"

FQ_MULTI_DETAIL_URL = "https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/multi-detail/v/"
FQ_BASIC_INFO_URL = "https://api5-normal-sinfonlinea.fqnovel.com/reading/user/basic_info/get/v"
FQ_URGE_URL = "https://api5-normal-sinfonlinec.fqnovel.com/reading/ugc/urge_update/get/v"
FQ_AUTHOR_BOOK_URL = "https://api5-normal-sinfonlinea.fqnovel.com/reading/user/author_book/get/v"
FQ_SCORE_CNT_URL = "https://reading.snssdk.com/reading/ugc/novel_comment/book/v/"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0"
)

RANK_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "referer": "https://fanqienovel.com/",
    "user-agent": UA,
}

DETAIL_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9",
    "user-agent": UA,
}

# 签名接口请求所需的 UA 与 Cookie（与本地采集工具保持一致）
FQ_COOKIES = {
    "novel_web_id": "7636576424158496310",
    "serial_uuid": "7636576424158496310",
    "serial_webid": "7636576424158496310",
    "n_mh": "CIOl7IbPqEeCbjav_VlxQPj7wmYNhp151iUUZNMtb64",
    "csrf_session_id": "5d274f1a5390c34403af2d985b0a04f9",
    "s_v_web_id": "verify_mr9xatd7_rEfwePpu_cqyE_4UmF_BfBM_QK2yW4qzwWMo",
    "passport_csrf_token": "62e2733807200da69649412be0b9ca7f",
    "passport_csrf_token_default": "62e2733807200da69649412be0b9ca7f",
    "odin_tt": "b71009f5eb02b53b17c87c13db93e146133f36cf8ca7ff6c45aa72ae6a19d62215f65be4fd452693b92e4d042270c683",
}

FQ_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "referer": "https://fanqienovel.com/",
    "user-agent": UA,
    # 签名接口默认返回 gzip，必须显式要求 identity，否则 .json() 解析失败
    "accept-encoding": "identity",
}

# 男频分类 (gender=1)
MALE_CATEGORIES = {
    "西方奇幻": 1141,
    "东方仙侠": 1140,
    "科幻末世": 8,
    "都市日常": 261,
    "都市修真": 124,
    "都市高武": 1014,
    "历史古代": 273,
    "战神赘婿": 27,
    "都市种田": 263,
    "传统玄幻": 258,
    "历史脑洞": 272,
    "悬疑脑洞": 539,
    "都市脑洞": 262,
    "玄幻脑洞": 257,
    "悬疑灵异": 751,
    "抗战谍战": 504,
    "游戏体育": 746,
    "动漫衍生": 718,
    "男频衍生": 1016,
}

# 女频分类 (gender=0)
FEMALE_CATEGORIES = {
    "古风世情": 1139,
    "科幻末世": 8,
    "游戏体育": 746,
    "女频衍生": 1015,
    "玄幻言情": 248,
    "种田": 23,
    "年代": 79,
    "现言脑洞": 267,
    "宫斗宅斗": 246,
    "悬疑脑洞": 539,
    "古言脑洞": 253,
    "快穿": 24,
    "青春甜宠": 749,
    "星光璀璨": 745,
    "女频悬疑": 747,
    "职场婚恋": 750,
    "豪门总裁": 748,
    "民国言情": 1017,
}

# ============================================================
# 字体解密
# ============================================================
CODE_ST = 58344
CODE_ED = 58715
CHARSET = [
    'D', '在', '主', '特', '家', '军', '然', '表', '场', '4', '要', '只', 'v', '和', '?', '6', '别', '还', 'g',
    '现', '儿', '岁', '?', '?', '此', '象', '月', '3', '出', '战', '工', '相', 'o', '男', '直', '失', '世', 'F',
    '都', '平', '文', '什', 'V', 'O', '将', '真', 'T', '那', '当', '?', '会', '立', '些', 'u', '是', '十', '张',
    '学', '气', '大', '爱', '两', '命', '全', '后', '东', '性', '通', '被', '1', '它', '乐', '接', '而', '感',
    '车', '山', '公', '了', '常', '以', '何', '可', '话', '先', 'p', 'i', '叫', '轻', 'M', '士', 'w', '着', '变',
    '尔', '快', 'l', '个', '说', '少', '色', '里', '安', '花', '远', '7', '难', '师', '放', 't', '报', '认',
    '面', '道', 'S', '?', '克', '地', '度', 'I', '好', '机', 'U', '民', '写', '把', '万', '同', '水', '新', '没',
    '书', '电', '吃', '像', '斯', '5', '为', 'y', '白', '几', '日', '教', '看', '但', '第', '加', '候', '作',
    '上', '拉', '住', '有', '法', 'r', '事', '应', '位', '利', '你', '声', '身', '国', '问', '马', '女', '他',
    'Y', '比', '父', 'x', 'A', 'H', 'N', 's', 'X', '边', '美', '对', '所', '金', '活', '回', '意', '到', 'z',
    '从', 'j', '知', '又', '内', '因', '点', 'Q', '三', '定', '8', 'R', 'b', '正', '或', '夫', '向', '德', '听',
    '更', '?', '得', '告', '并', '本', 'q', '过', '记', 'L', '让', '打', 'f', '人', '就', '者', '去', '原', '满',
    '体', '做', '经', 'K', '走', '如', '孩', 'c', 'G', '给', '使', '物', '?', '最', '笑', '部', '?', '员', '等',
    '受', 'k', '行', '一', '条', '果', '动', '光', '门', '头', '见', '往', '自', '解', '成', '处', '天', '能',
    '于', '名', '其', '发', '总', '母', '的', '死', '手', '入', '路', '进', '心', '来', 'h', '时', '力', '多',
    '开', '已', '许', 'd', '至', '由', '很', '界', 'n', '小', '与', 'Z', '想', '代', '么', '分', '生', '口',
    '再', '妈', '望', '次', '西', '风', '种', '带', 'J', '?', '实', '情', '才', '这', '?', 'E', '我', '神', '格',
    '长', '觉', '间', '年', '眼', '无', '不', '亲', '关', '结', '0', '友', '信', '下', '却', '重', '己', '老',
    '2', '音', '字', 'm', '呢', '明', '之', '前', '高', 'P', 'B', '目', '太', 'e', '9', '起', '稜', '她', '也',
    'W', '用', '方', '子', '英', '每', '理', '便', '四', '数', '期', '中', 'C', '外', '样', 'a', '海', '们',
    '任',
]


def decrypt_font(text: str) -> str:
    """番茄字体加密解密：PUA 区字符按 CHARSET 偏移还原"""
    if not text:
        return ""
    out = []
    for ch in text:
        code = ord(ch)
        if CODE_ST <= code <= CODE_ED:
            idx = code - CODE_ST
            out.append(CHARSET[idx] if idx < len(CHARSET) else ch)
        else:
            out.append(ch)
    return "".join(out)


_COVER_RE = re.compile(r"(novel-pic/[A-Za-z0-9]+)")


def extract_cover_uri(url: str) -> str:
    """从带签名的封面 URL 中提取稳定的 `novel-pic/xxx` 路径。

    带签名的 URL（含 x-expires/x-signature）会过期，历史数据里的图片会失效；
    提取出的稳定路径可拼接永久地址 https://p6-novel.byteimg.com/origin/{path} 使用。
    """
    if not url:
        return ""
    m = _COVER_RE.search(url)
    return m.group(1) if m else ""


def timestamp_to_str(ts: Any) -> str:
    """时间戳 -> 北京时间字符串 YYYY-MM-DD HH:MM:SS"""
    if ts is None or ts == "":
        return ""
    try:
        if isinstance(ts, (list, tuple)) and len(ts) >= 6:
            ts = time.mktime(tuple(ts[:9]) if len(ts) >= 9 else tuple(ts[:6]) + (0, 0, 0))
        ts = int(ts)
        if ts <= 0:
            return ""
        if ts > 10_000_000_000:
            ts = ts // 1000
        return datetime.fromtimestamp(ts, BJ_TZ).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def to_int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def to_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ============================================================
# 本地 Java 签名服务
# ============================================================
_sign_ready = [False]


def sign_service_ready() -> bool:
    """检测本地签名服务是否可用"""
    try:
        resp = requests.get(SIGN_HEALTH, timeout=5)
        ok = resp.status_code == 200 and "UP" in resp.text
        _sign_ready[0] = ok
        return ok
    except Exception:
        _sign_ready[0] = False
        return False


def sign_request(body: Dict) -> Optional[Dict]:
    """调用本地签名服务，返回含 fullUrl 的签名字段字典"""
    if not _sign_ready[0]:
        return None
    for attempt in range(2):
        try:
            resp = requests.post(SIGN_API, json=body, timeout=30)
            data = resp.json()
            if data and "fullUrl" in data:
                return data
        except Exception:
            time.sleep(1.0 * (attempt + 1))
    return None


def signed_get(body: Dict, referer: str = "") -> Optional[Any]:
    """用本地签名服务对指定接口签名后发起 GET，返回 JSON"""
    signed = sign_request(body)
    if not signed:
        return None
    signed = dict(signed)
    full_url = signed.pop("fullUrl")
    headers = dict(FQ_HEADERS)
    headers.update(signed)
    if referer:
        headers["referer"] = referer
    try:
        resp = requests.get(full_url, headers=headers, cookies=FQ_COOKIES, timeout=60)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


# ============================================================
# 接口请求
# ============================================================
def fetch_rank_list(gender: int, rank_mold: int, category_id: int,
                    limit: int = RANK_API_LIMIT) -> List[Dict]:
    """调用分类排行榜接口，返回 book_list"""
    params = {
        "app_id": "2503",
        "rank_list_type": "3",
        "offset": "0",
        "limit": str(limit),
        "category_id": str(category_id),
        "rank_version": "",
        "gender": str(gender),
        "rankMold": str(rank_mold),
    }
    for attempt in range(3):
        try:
            resp = requests.get(RANK_API_URL, params=params,
                                headers=RANK_HEADERS, timeout=30)
            data = resp.json()
            if data.get("code") == 0:
                return data.get("data", {}).get("book_list", []) or []
            print("    [榜单] 返回异常 code=%s" % data.get("code"))
            return []
        except Exception as exc:
            print("    [榜单] 请求失败(%d/3): %s" % (attempt + 1, exc))
            time.sleep(1.5 * (attempt + 1))
    return []


def fetch_detail_external(book_id: str) -> Optional[Dict]:
    """外部详情接口（首选）。

    该接口偶发高延迟（实测可到 100s+），这里限制在 20s 内，超时即交给
    本地 Java 签名包兜底，避免个别慢请求长时间占用线程。
    """
    try:
        resp = requests.get(DETAIL_API_URL + str(book_id),
                            headers=DETAIL_HEADERS, timeout=EXTERNAL_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") == 200 and data.get("data", {}).get("code") == 0:
            return data["data"]["data"]
        return None
    except Exception:
        return None


def fetch_detail_java(book_id: str) -> Optional[Dict]:
    """本地 Java 签名包（兜底）：multi-detail 接口"""
    j = signed_get({"url": FQ_MULTI_DETAIL_URL, "book_id": str(book_id)})
    if not j:
        return None
    arr = j.get("data") or []
    if isinstance(arr, list) and arr:
        return arr[0]
    return None


def fetch_book_detail(book_id: str) -> Tuple[Optional[Dict], str]:
    """详情抓取：外部接口优先，失败回退本地 Java 签名包。两者都失败则返回 (None, '')"""
    raw = fetch_detail_external(book_id)
    if raw:
        return raw, "external"
    if _sign_ready[0]:
        raw = fetch_detail_java(book_id)
        if raw:
            return raw, "java"
    return None, ""


# ---- 补充数据（作者开书 / 点评人数 / 催更 / 作者等级） ----
def fetch_author_level_books(uid: str) -> Tuple[str, int]:
    """作者等级（需签名）+ 作者开书本数（无需签名）"""
    if not uid or uid.startswith("-"):
        return "", 0
    level = ""
    books = 0
    # 作者开书：无需签名
    try:
        resp = requests.get(
            FQ_AUTHOR_BOOK_URL + "?aid=1967&iid=1&version_code=999&user_id=" + str(uid),
            headers=FQ_HEADERS, cookies=FQ_COOKIES, timeout=30)
        d = resp.json().get("data") or {}
        books = to_int(d.get("total"))
    except Exception:
        pass
    # 作者等级：需签名
    j = signed_get({"url": FQ_BASIC_INFO_URL, "user_id": str(uid)})
    if j:
        d = j.get("data") or {}
        infos = d.get("user_title_infos") or []
        if infos:
            level = infos[0].get("title_text", "") or ""
        if not books:
            books = to_int(d.get("author_book_num"))
    return level, books


def fetch_score_cnt(book_id: str) -> int:
    """点评人数（无需签名）"""
    url = (FQ_SCORE_CNT_URL + "?offset=0&need_hot_comment=true&count=3&source_type=10"
           "&book_id=" + str(book_id) +
           "&query_col=1&sort=smart_hot&iid=2244564251083337&aid=1967&gender=1&vip_state=0")
    try:
        resp = requests.get(url, headers=FQ_HEADERS, cookies=FQ_COOKIES, timeout=30)
        d = resp.json().get("data") or {}
        return to_int(d.get("score_cnt"))
    except Exception:
        return 0


def fetch_urge_count(book_id: str, item_id: str) -> int:
    """催更数（无需签名，必须带 item_id，否则接口 502）"""
    if not item_id:
        return 0
    url = (FQ_URGE_URL + "?aid=1967&iid=1&version_code=66732"
           "&book_id=" + str(book_id) + "&item_id=" + str(item_id))
    try:
        resp = requests.get(url, headers=FQ_HEADERS, cookies=FQ_COOKIES, timeout=30)
        d = resp.json().get("data") or {}
        return to_int(d.get("total_cnt"))
    except Exception:
        return 0


# ============================================================
# 数据规范化
# ============================================================
def build_rank_book(rec: Dict, pos: int) -> Dict:
    """榜单接口单条 -> 精简记录"""
    return {
        "bookId": str(rec.get("bookId", "")),
        "bookName": decrypt_font(rec.get("bookName", "")),
        "author": decrypt_font(rec.get("author", "")),
        "uid": str(rec.get("uid", "")),
        "cover": extract_cover_uri(rec.get("thumbUri", "")),
        "readCount": to_int(rec.get("read_count")),
        "wordNumber": to_int(rec.get("wordNumber")),
        "lastUpdate": timestamp_to_str(rec.get("lastChapterUpdateTime")),
        "pos": pos,
    }


def normalize_detail(raw: Dict, author_id: str = "",
                     author_level: str = "", author_book_count: int = 0,
                     score_cnt: int = 0, urge_count: int = 0) -> Dict:
    """详情接口原始数据 -> 精简字段"""
    rw_raw = raw.get("recent_update_word_number")
    recent_update = None if rw_raw is None or rw_raw == "" else to_int(rw_raw)
    if not author_id:
        author_id = str((raw.get("author_info") or {}).get("user_id", ""))
    return {
        "bookId": str(raw.get("book_id", "")),
        "bookName": raw.get("book_name", ""),
        "bookShortName": raw.get("book_short_name", "") or "",
        "originalBookName": raw.get("original_book_name", "") or "",
        "author": raw.get("author", ""),
        "authorId": author_id,
        "authorLevel": author_level or "",
        "authorBookCount": author_book_count or 0,
        "scoreCnt": score_cnt,
        "urgeCount": urge_count,
        "cover": extract_cover_uri(raw.get("thumb_uri", ""))
                 or extract_cover_uri(raw.get("expand_thumb_url", "")),
        "abstract": raw.get("abstract", ""),
        "category": raw.get("category", ""),
        "wordNumber": to_int(raw.get("word_number")),
        "tags": raw.get("tags", ""),
        "highQualityTags": raw.get("high_quality_tags", ""),
        "score": to_float(raw.get("score")),
        "readCount": to_int(raw.get("reader_uv_14day")),
        "readCount30d": to_int(raw.get("read_dcnt_30d")),
        "readCountAll": to_int(raw.get("reader_uv_sum_daily")),
        "addShelf14d": to_int(raw.get("add_shelf_count_14d")),
        "allBookshelf": to_int(raw.get("all_bookshelf_count")),
        "listenCount": to_int(raw.get("listen_count")),
        "keepUpdateDays": to_int(raw.get("keep_update_days")),
        "recentUpdateWord": recent_update,
        "ruleRankScore": to_float(raw.get("rule_rank_score")),
        "updateStatus": to_int(raw.get("update_status")),
        "createTime": timestamp_to_str(raw.get("create_time")),
        "lastChapterUpdateTime": timestamp_to_str(raw.get("last_chapter_update_time")),
        "lastChapterItemId": str(raw.get("last_chapter_item_id", "") or ""),
    }


# ============================================================
# 输出 / 缓存
# ============================================================
def write_json(path: str, obj: Any):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def update_index(data_dir: str, stats: Dict):
    """扫描 daily 目录重建日期索引"""
    daily_dir = os.path.join(data_dir, "daily")
    dates = []
    if os.path.isdir(daily_dir):
        for fn in os.listdir(daily_dir):
            if fn.endswith(".json"):
                dates.append(fn[:-5])
    dates.sort(reverse=True)
    index = {
        "dates": dates,
        "latest": dates[0] if dates else "",
        "lastUpdated": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "stats": stats,
    }
    write_json(os.path.join(data_dir, "index.json"), index)
    return dates


def prune_expired(data_dir: str, keep_days: int, today_str: str):
    """删除超过 keep_days 天的历史数据文件"""
    if keep_days <= 0:
        return
    try:
        cutoff = datetime.strptime(today_str, "%Y-%m-%d") - timedelta(days=keep_days)
    except ValueError:
        return
    removed = 0
    for sub in ("daily", "detail"):
        folder = os.path.join(data_dir, sub)
        if not os.path.isdir(folder):
            continue
        for fn in os.listdir(folder):
            if not fn.endswith(".json"):
                continue
            try:
                d = datetime.strptime(fn[:-5], "%Y-%m-%d")
            except ValueError:
                continue
            if d < cutoff:
                os.remove(os.path.join(folder, fn))
                removed += 1
    if removed:
        print("[清理] 已删除 %d 个超过 %d 天的历史数据文件" % (removed, keep_days))


def prune_series(series: Dict[str, List], cutoff: Optional[str], today: str):
    """按日期区间裁剪 {id: [[日期, 值], ...]} 序列"""
    for key in list(series.keys()):
        vals = series.get(key) or []
        kept = []
        for pair in vals:
            try:
                d = pair[0]
            except Exception:
                continue
            if cutoff and d < cutoff:
                continue
            if d <= today:
                kept.append(pair)
        if kept:
            kept.sort(key=lambda p: p[0])
            series[key] = kept
        else:
            del series[key]


# ============================================================
# 近 14 天「在读」历史
# ============================================================
def collect_today_reads(ranks: Dict) -> Dict[str, int]:
    """今日各榜单 {bookId: readCount}"""
    m: Dict[str, int] = {}
    for gender in ranks.values():
        for by_cat in gender.values():
            for books in by_cat.values():
                for b in books:
                    bid = b.get("bookId")
                    if bid:
                        m[bid] = b.get("readCount", 0)
    return m


def collect_author_ids(ranks: Dict) -> Dict[str, str]:
    """今日各榜单 {bookId: 作者uid}"""
    m: Dict[str, str] = {}
    for gender in ranks.values():
        for by_cat in gender.values():
            for books in by_cat.values():
                for b in books:
                    bid = b.get("bookId")
                    if bid and b.get("uid"):
                        m.setdefault(bid, b["uid"])
    return m


def build_read_history(data_dir: str, date_str: str, today_reads: Dict[str, int],
                       target_ids: List[str], days: int = 14) -> Dict[str, List]:
    """回溯历史每日榜单，生成 {bookId: [[日期, 在读], ...]}（升序，仅含有数据的日期）"""
    series: Dict[str, Dict[str, int]] = dict((bid, {}) for bid in target_ids)
    for bid in target_ids:
        if bid in today_reads:
            series[bid][date_str] = today_reads[bid]

    try:
        base = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        base = datetime.now(BJ_TZ)

    for i in range(1, days):
        d = (base - timedelta(days=i)).strftime("%Y-%m-%d")
        path = os.path.join(data_dir, "daily", "%s.json" % d)
        if not os.path.exists(path):
            continue
        j = read_json(path, None)
        if not j:
            continue
        for gender in (j.get("ranks") or {}).values():
            for by_cat in gender.values():
                for books in by_cat.values():
                    for b in books:
                        bid = b.get("bookId")
                        if bid in series and d not in series[bid]:
                            series[bid][d] = b.get("readCount", 0)

    out: Dict[str, List] = {}
    for bid, m in series.items():
        if m:
            out[bid] = [[d, m[d]] for d in sorted(m.keys())]
    return out


def resolve_effective_date() -> str:
    """自动推算本次采集的数据应归属的日期（北京时间）。

    番茄榜单每天中午 12:00 之后才更新为「前一天」的数据，所以：
      - < 12:00 运行时拿到的是「前天」的数据 -> 归属 = 今天 - 2
      - >= 12:00 运行时拿到的是「昨天」的数据 -> 归属 = 今天 - 1
    """
    now = datetime.now(BJ_TZ)
    offset = 1 if now.hour >= 12 else 2
    return (now - timedelta(days=offset)).strftime("%Y-%m-%d")


# ============================================================
# 主流程
# ============================================================
def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)  # 便于在 CI 日志里实时观察进度
    except Exception:
        pass

    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    date_str = os.environ.get("FANQIE_DATE", "").strip() or resolve_effective_date()
    save_top = to_int(os.environ.get("FANQIE_SAVE_TOP")) or SAVE_TOP_DEFAULT
    detail_override = to_int(os.environ.get("FANQIE_DETAIL_TOP"))
    detail_top_map = dict(DETAIL_TOP_DEFAULT)
    if detail_override > 0:
        detail_top_map = {"阅读榜": detail_override, "新书榜": detail_override}
    keep_days = os.environ.get("FANQIE_KEEP_DAYS")
    keep_days = KEEP_DAYS_DEFAULT if keep_days in (None, "") else to_int(keep_days)
    workers = to_int(os.environ.get("FANQIE_WORKERS")) or WORKERS_DEFAULT
    no_detail = os.environ.get("FANQIE_NO_DETAIL", "").strip().lower() in ("1", "true", "yes")
    skip_if_exists = os.environ.get("FANQIE_SKIP_IF_EXISTS", "").strip().lower() in ("1", "true", "yes")
    data_dir = os.environ.get("FANQIE_OUTPUT_DIR", "").strip() or \
        os.path.join(root_dir, "fanqie", "data")

    daily_path = os.path.join(data_dir, "daily", "%s.json" % date_str)
    detail_path = os.path.join(data_dir, "detail", "%s.json" % date_str)
    authors_path = os.path.join(data_dir, "authors.json")
    updates_path = os.path.join(data_dir, "updates.json")

    print("=" * 60)
    print("  番茄小说榜单每日采集")
    print("  数据归属日期: %s（北京时间 %s）"
          % (date_str, datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M")))
    print("  保存前 %d 本/榜  详情[阅读榜=%d 新书榜=%d]  保留 %d 天  线程 %d"
          % (save_top, detail_top_map["阅读榜"], detail_top_map["新书榜"], keep_days, workers))
    print("  输出目录: %s" % data_dir)
    print("=" * 60)

    # 兜底重跑：22:30 那次若已成功，23:00 这次直接跳过
    if skip_if_exists:
        has_daily = os.path.exists(daily_path) and os.path.getsize(daily_path) > 0
        has_detail = os.path.exists(detail_path) and os.path.getsize(detail_path) > 0
        if has_daily and (no_detail or has_detail):
            print("[跳过] %s 的榜单与详情数据均已存在，无需重复采集" % date_str)
            return
        if has_daily:
            print("[续采] %s 榜单已存在但缺少详情，重新采集以补齐详情" % date_str)

    # 检测本地 Java 签名服务（用于兜底详情 + 作者等级）
    if sign_service_ready():
        print("[签名] 本地 Java 签名服务可用（127.0.0.1:8082）")
    else:
        print("[签名] 未检测到本地签名服务：作者等级将为空，详情仅用外部接口")

    ranks: Dict[str, Dict[str, Dict[str, List[Dict]]]] = {"male": {}, "female": {}}
    catalog: Dict[str, Dict[str, List[str]]] = {"male": {}, "female": {}}

    detail_ids: List[str] = []
    seen_ids: Set[str] = set()

    total_books = 0
    gender_sources = [("male", "男频", MALE_CATEGORIES, 1),
                      ("female", "女频", FEMALE_CATEGORIES, 0)]

    for gender_key, gender_label, cats, gender_val in gender_sources:
        for rank_name, rank_mold in RANK_MOLD_MAP.items():
            ranks[gender_key][rank_name] = {}
            catalog[gender_key][rank_name] = []
            d_top = detail_top_map.get(rank_name, 0)
            for cat_name, cat_id in cats.items():
                book_list = fetch_rank_list(gender_val, rank_mold, cat_id)
                books = [build_rank_book(rec, i + 1)
                         for i, rec in enumerate(book_list)]
                books = [b for b in books if b["bookId"]]
                books = books[:save_top]
                ranks[gender_key][rank_name][cat_name] = books
                catalog[gender_key][rank_name].append(cat_name)
                total_books += len(books)

                for b in books[:d_top]:
                    if b["bookId"] not in seen_ids:
                        seen_ids.add(b["bookId"])
                        detail_ids.append(b["bookId"])

                print("  [%s_%s_%s] %d 本" % (gender_label, rank_name, cat_name, len(books)))
                time.sleep(random.uniform(0.3, 0.8))

    if total_books == 0:
        print("[错误] 未获取到任何榜单数据，终止")
        sys.exit(1)

    # 写入当日榜单
    write_json(daily_path, {
        "date": date_str,
        "generatedAt": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "saveTop": save_top,
        "detailTop": detail_top_map,
        "rankTypes": list(RANK_MOLD_MAP.keys()),
        "catalog": catalog,
        "ranks": ranks,
    })
    print("\n[榜单] 已写入 %s（共 %d 本，去重后详情待抓 %d 本）"
          % (daily_path, total_books, len(detail_ids)))

    uid_map = collect_author_ids(ranks)
    today_reads = collect_today_reads(ranks)

    authors = read_json(authors_path, {}) or {}
    detail_ok = 0

    if no_detail:
        print("[详情] 已跳过（FANQIE_NO_DETAIL=1）")
    else:
        print("\n[详情] 待抓取 %d 本，开始..." % len(detail_ids))
        raw_details: Dict[str, Dict] = {}
        lock = threading.Lock()
        counter = [0]
        src_stat = {"external": 0, "java": 0}

        def worker(book_id):
            raw, src = fetch_book_detail(book_id)
            with lock:
                counter[0] += 1
                n = counter[0]
            if not raw:
                with lock:
                    print("  [%d/%d] FAIL %s" % (n, len(detail_ids), book_id))
                return
            # 作者 ID：优先外部详情里的 author_info.user_id；榜单 uid 常缺失，用于补位
            uid = str((raw.get("author_info") or {}).get("user_id", "") or "") or uid_map.get(book_id, "")
            score_cnt = fetch_score_cnt(book_id)
            urge = fetch_urge_count(book_id, str(raw.get("last_chapter_item_id", "") or ""))
            with lock:
                raw_details[book_id] = {"raw": raw, "src": src, "authorId": uid,
                                        "scoreCnt": score_cnt, "urgeCount": urge}
                src_stat[src] = src_stat.get(src, 0) + 1
                print("  [%d/%d] OK(%s) %s" % (n, len(detail_ids), src,
                                               raw.get("book_name", book_id)))

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(worker, bid) for bid in detail_ids]
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as exc:
                    print("  [详情] 异常: %s" % exc)

        # ---- 作者等级/开书：按作者缓存，只刷新缺失或过期的 ----
        need_uids = set(u for u in uid_map.values() if u and not u.startswith("-"))
        for r in raw_details.values():
            u = r.get("authorId") or ""
            if u and not u.startswith("-"):
                need_uids.add(u)
        need_uids = sorted(need_uids)
        ttl_cutoff = datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=AUTHOR_TTL_DAYS)
        stale = []
        for uid in need_uids:
            rec = authors.get(uid)
            if not rec:
                stale.append(uid)
                continue
            try:
                ts = datetime.strptime(rec.get("ts", ""), "%Y-%m-%d")
            except ValueError:
                ts = None
            if ts is None or ts < ttl_cutoff:
                stale.append(uid)
        print("\n[作者] 需抓取 %d 位作者（共 %d 位，缓存命中 %d 位）"
              % (len(stale), len(need_uids), len(need_uids) - len(stale)))

        cnt_a = [0]

        def author_worker(uid):
            level, books_n = fetch_author_level_books(uid)
            with lock:
                if level or books_n:
                    authors[uid] = {"level": level, "books": books_n, "ts": date_str}
                cnt_a[0] += 1
                if cnt_a[0] % 100 == 0:
                    print("  [作者 %d/%d]" % (cnt_a[0], len(stale)))

        if stale:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                futs = [ex.submit(author_worker, u) for u in stale]
                for f in as_completed(futs):
                    try:
                        f.result()
                    except Exception:
                        pass
        write_json(authors_path, authors)

        # ---- 归一化 ----
        details: Dict[str, Dict] = {}
        for bid, r in raw_details.items():
            ac = authors.get(r["authorId"]) or {}
            details[bid] = normalize_detail(
                r["raw"], author_id=r["authorId"],
                author_level=ac.get("level", ""),
                author_book_count=ac.get("books", 0),
                score_cnt=r["scoreCnt"], urge_count=r["urgeCount"])

        detail_ok = len(details)
        history = build_read_history(data_dir, date_str, today_reads,
                                     list(today_reads.keys()))
        # 所有上榜书籍都写入近 14 天在读（未抓详情的只写历史），供前端展示
        for bid in today_reads.keys():
            rec = details.get(bid)
            if rec is None:
                rec = details[bid] = {}
            rec["read14"] = history.get(bid, [])
        write_json(detail_path, details)
        print("\n[详情] 成功 %d/%d 本（外部 %d / Java %d）；近14天在读 %d 本，已写入 %s"
              % (detail_ok, len(detail_ids), src_stat.get("external", 0),
                 src_stat.get("java", 0), len(history), detail_path))

    # ---- 跨天累积「最近更新字数」序列 ----
    updates = read_json(updates_path, {}) or {}
    series = updates.get("books") or {}
    if not isinstance(series, dict):
        series = {}
    added = 0
    if not no_detail:
        for bid, rec in (details or {}).items():
            rw = rec.get("recentUpdateWord")
            if rw is None:
                continue
            lst = series.get(bid) or []
            lst = [p for p in lst if not (isinstance(p, list) and p and p[0] == date_str)]
            lst.append([date_str, rw])
            series[bid] = lst
            added += 1
    cutoff = None
    if keep_days > 0:
        try:
            cutoff = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=keep_days)
                      ).strftime("%Y-%m-%d")
        except ValueError:
            cutoff = None
    prune_series(series, cutoff, date_str)
    write_json(updates_path, {
        "lastUpdated": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "books": series,
    })
    print("[更新字数] 本次记录 %d 本，累计覆盖 %d 本" % (added, len(series)))

    # ---- 作者缓存清理与落盘 ----
    if authors:
        if keep_days > 0:
            for uid in list(authors.keys()):
                try:
                    ts = datetime.strptime(authors[uid].get("ts", ""), "%Y-%m-%d")
                except ValueError:
                    del authors[uid]
                    continue
                if (datetime.strptime(date_str, "%Y-%m-%d") - ts).days > keep_days:
                    del authors[uid]
        write_json(authors_path, authors)
        print("[作者] 缓存已保存 %d 位 -> %s" % (len(authors), authors_path))

    prune_expired(data_dir, keep_days, date_str)
    dates = update_index(data_dir, {
        "books": total_books,
        "details": detail_ok,
        "rankLists": sum(len(v) for g in catalog.values() for v in g.values()),
        "authors": len(authors),
    })
    print("[索引] 当前可用日期 %d 个: %s" % (len(dates), ", ".join(dates[:7])))

    print("\n" + "=" * 60)
    print("  完成！日期 %s，榜单 %d 本，详情 %d 本" % (date_str, total_books, detail_ok))
    print("=" * 60)


if __name__ == "__main__":
    main()
# -*- coding: utf-8 -*-
"""
番茄小说榜单每日采集脚本（供 GitHub Actions 每日自动运行）

流程：
  1. 遍历 男频/女频 × 阅读榜/新书榜 × 各分类，调用「分类排行榜 API」获取当日榜单
     （简介/书名/作者为字体加密，需解密）
  2. 对每个榜单的前 N 本书，调用「书籍详情 API」逐本获取详细数据
  3. 输出 JSON 到 fanqie/data/：
       data/index.json              可用日期索引
       data/daily/YYYY-MM-DD.json   当日榜单（男/女频 × 榜单 × 分类）
       data/detail/YYYY-MM-DD.json  当日书籍详情（bookId -> 详情）

可用环境变量：
  FANQIE_DATE        指定采集日期归属（YYYY-MM-DD，默认自动推算，见下）
  FANQIE_SAVE_TOP    每个榜单保存前多少本（默认 30）
  FANQIE_DETAIL_TOP  每个榜单前多少本抓取详情（默认 20）
  FANQIE_KEEP_DAYS   历史数据保留天数，超期自动清理（默认 45，设 0 表示永久保留）
  FANQIE_WORKERS     详情抓取线程数（默认 4）
  FANQIE_NO_DETAIL   设为 1 则跳过详情抓取
  FANQIE_SKIP_IF_EXISTS 设为 1 时，若目标日期的数据已存在则跳过（用于定时任务的兜底重跑）
  FANQIE_OUTPUT_DIR  自定义数据输出目录（默认 <仓库根>/fanqie/data）

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
from typing import Any, Dict, List, Optional, Set

import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

# ============================================================
# 基础配置
# ============================================================
BJ_TZ = timezone(timedelta(hours=8))

RANK_API_URL = "https://fanqienovel.com/api/rank/category/list"
DETAIL_API_URL = "http://101.35.133.34:5000/api/detail?book_id="

RANK_API_LIMIT = 190  # 接口单次最大返回数量

RANK_MOLD_MAP = {"阅读榜": 2, "新书榜": 1}

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


def fetch_book_detail(book_id: str) -> Optional[Dict]:
    """调用书籍详情接口，带重试"""
    for attempt in range(3):
        try:
            resp = requests.get(DETAIL_API_URL + str(book_id),
                                headers=DETAIL_HEADERS, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 200 and data.get("data", {}).get("code") == 0:
                return data["data"]["data"]
            print("    [详情] %s 返回异常 code=%s" % (book_id, data.get("code")))
            return None
        except requests.exceptions.Timeout:
            print("    [详情] %s 超时(%d/3)" % (book_id, attempt + 1))
            time.sleep(4)
        except Exception as exc:
            print("    [详情] %s 失败(%d/3): %s" % (book_id, attempt + 1, exc))
            time.sleep(4)
    return None


# ============================================================
# 数据规范化
# ============================================================
def build_rank_book(rec: Dict, pos: int) -> Dict:
    """榜单接口单条 -> 精简记录"""
    try:
        read_count = int(rec.get("read_count") or 0)
    except (TypeError, ValueError):
        read_count = 0
    try:
        word_number = int(rec.get("wordNumber") or 0)
    except (TypeError, ValueError):
        word_number = 0
    return {
        "bookId": str(rec.get("bookId", "")),
        "bookName": decrypt_font(rec.get("bookName", "")),
        "author": decrypt_font(rec.get("author", "")),
        "uid": str(rec.get("uid", "")),
        "cover": extract_cover_uri(rec.get("thumbUri", "")),
        "readCount": read_count,
        "wordNumber": word_number,
        "lastUpdate": timestamp_to_str(rec.get("lastChapterUpdateTime")),
        "pos": pos,
    }


def normalize_detail(raw: Dict) -> Dict:
    """详情接口原始数据 -> 精简字段"""
    def _int(v):
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0

    def _float(v):
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    return {
        "bookId": str(raw.get("book_id", "")),
        "bookName": raw.get("book_name", ""),
        "originalBookName": raw.get("original_book_name", ""),
        "author": raw.get("author", ""),
        "authorId": str((raw.get("author_info") or {}).get("user_id", "")),
        "cover": extract_cover_uri(raw.get("thumb_uri", ""))
                 or extract_cover_uri(raw.get("expand_thumb_url", "")),
        "abstract": raw.get("abstract", ""),
        "category": raw.get("category", ""),
        "wordNumber": _int(raw.get("word_number")),
        "tags": raw.get("tags", ""),
        "highQualityTags": raw.get("high_quality_tags", ""),
        "score": _float(raw.get("score")),
        "readCount": _int(raw.get("reader_uv_14day")),
        "readCount30d": _int(raw.get("read_dcnt_30d")),
        "readCountAll": _int(raw.get("reader_uv_sum_daily")),
        "addShelf14d": _int(raw.get("add_shelf_count_14d")),
        "allBookshelf": _int(raw.get("all_bookshelf_count")),
        "listenCount": _int(raw.get("listen_count")),
        "keepUpdateDays": _int(raw.get("keep_update_days")),
        "recentUpdateWord": _int(raw.get("recent_update_word_number")),
        "ruleRankScore": _float(raw.get("rule_rank_score")),
        "updateStatus": _int(raw.get("update_status")),
        "createTime": timestamp_to_str(raw.get("create_time")),
        "lastChapterUpdateTime": timestamp_to_str(raw.get("last_chapter_update_time")),
    }


# ============================================================
# 输出
# ============================================================
def write_json(path: str, obj: Any):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


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
        try:
            with open(path, "r", encoding="utf-8") as f:
                j = json.load(f)
        except Exception:
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
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    date_str = os.environ.get("FANQIE_DATE", "").strip() or resolve_effective_date()
    save_top = int(os.environ.get("FANQIE_SAVE_TOP") or 30)
    detail_top = int(os.environ.get("FANQIE_DETAIL_TOP") or 20)
    keep_days = int(os.environ.get("FANQIE_KEEP_DAYS") or 45)
    workers = int(os.environ.get("FANQIE_WORKERS") or 4)
    no_detail = os.environ.get("FANQIE_NO_DETAIL", "").strip().lower() in ("1", "true", "yes")
    skip_if_exists = os.environ.get("FANQIE_SKIP_IF_EXISTS", "").strip().lower() in ("1", "true", "yes")
    data_dir = os.environ.get("FANQIE_OUTPUT_DIR", "").strip() or \
        os.path.join(root_dir, "fanqie", "data")

    daily_path = os.path.join(data_dir, "daily", "%s.json" % date_str)
    detail_path = os.path.join(data_dir, "detail", "%s.json" % date_str)

    print("=" * 60)
    print("  番茄小说榜单每日采集")
    print("  数据归属日期: %s（北京时间 %s）"
          % (date_str, datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M")))
    print("  保存前 %d 本/榜  详情前 %d 本/榜  保留 %d 天  线程 %d"
          % (save_top, detail_top, keep_days, workers))
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
            for cat_name, cat_id in cats.items():
                book_list = fetch_rank_list(gender_val, rank_mold, cat_id)
                books = [build_rank_book(rec, i + 1)
                         for i, rec in enumerate(book_list)]
                books = [b for b in books if b["bookId"]]
                books = books[:save_top]
                ranks[gender_key][rank_name][cat_name] = books
                catalog[gender_key][rank_name].append(cat_name)
                total_books += len(books)

                for b in books[:detail_top]:
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
        "detailTop": detail_top,
        "rankTypes": list(RANK_MOLD_MAP.keys()),
        "catalog": catalog,
        "ranks": ranks,
    })
    print("\n[榜单] 已写入 %s（共 %d 本）" % (daily_path, total_books))

    # 抓取详情
    detail_ok = 0
    if no_detail:
        print("[详情] 已跳过（FANQIE_NO_DETAIL=1）")
    else:
        print("\n[详情] 待抓取 %d 本，开始..." % len(detail_ids))
        details: Dict[str, Dict] = {}
        lock = threading.Lock()
        counter = [0]

        def worker(book_id):
            raw = fetch_book_detail(book_id)
            with lock:
                counter[0] += 1
                n = counter[0]
                if raw:
                    item = normalize_detail(raw)
                    details[book_id] = item
                    print("  [%d/%d] OK %s" % (n, len(detail_ids), item.get("bookName", book_id)))
                else:
                    print("  [%d/%d] FAIL %s" % (n, len(detail_ids), book_id))

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(worker, bid) for bid in detail_ids]
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as exc:
                    print("  [详情] 异常: %s" % exc)

        detail_ok = len(details)
        today_reads = collect_today_reads(ranks)
        history = build_read_history(data_dir, date_str, today_reads,
                                     list(today_reads.keys()))
        # 所有上榜书籍都写入近 14 天在读（未抓详情的只写历史），供前端展示
        for bid in today_reads.keys():
            rec = details.get(bid)
            if rec is None:
                rec = details[bid] = {}
            rec["read14"] = history.get(bid, [])
        write_json(detail_path, details)
        print("\n[详情] 成功抓取 %d/%d 本；近14天在读 %d 本，已写入 %s"
              % (detail_ok, len(detail_ids), len(history), detail_path))

    prune_expired(data_dir, keep_days, date_str)
    dates = update_index(data_dir, {
        "books": total_books,
        "details": detail_ok,
        "rankLists": sum(len(v) for g in catalog.values() for v in g.values()),
    })
    print("[索引] 当前可用日期 %d 个: %s" % (len(dates), ", ".join(dates[:7])))

    print("\n" + "=" * 60)
    print("  完成！日期 %s，榜单 %d 本，详情 %d 本" % (date_str, total_books, detail_ok))
    print("=" * 60)


if __name__ == "__main__":
    main()
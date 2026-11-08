"""국내 증시 과열 지표 수집기.

출처별로 따로 수집하고, 한 곳이 실패해도 나머지는 저장합니다.
결과는 docs/data/data.json 한 파일에 쌓이고, 웹앱이 이 파일을 읽습니다.

  - 한국거래소(pykrx, 로그인 필요): 코스피 PER·PBR, 코스피·코스닥 시가총액·거래대금, 투자자별 거래대금
  - 네이버 금융 '증시자금동향': 투자자예탁금(고객예탁금), 신용잔고
  - 38커뮤니케이션: 신규상장 공모주의 공모가·시초가·첫날 종가, 일반청약 경쟁률
"""

import datetime as dt
import io
import json
import os
import re
import ssl
import sys
import time
import traceback

import pandas as pd
import requests
from requests.adapters import HTTPAdapter

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "docs", "data", "data.json")
with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
    CFG = json.load(f)

KST = dt.timezone(dt.timedelta(hours=9))
TODAY = dt.datetime.now(KST).date()
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


# ---------- 공통 ----------

def load():
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save(data):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))


def merge(old, new, key):
    m = {r[key]: r for r in (old or [])}
    for r in new:
        m[r[key]] = {**m.get(r[key], {}), **r}
    return [m[k] for k in sorted(m)]


def num(x):
    """'1,234', '-', '+12.3%' 같은 값을 숫자로. 없으면 None."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return None if pd.isna(x) else float(x)
    s = re.sub(r"[^\d.\-]", "", str(x))
    if s in ("", "-", ".", "-."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def last_date(rows, key="d"):
    return dt.date.fromisoformat(rows[-1][key]) if rows else None


def start_from(rows, overlap_days, years):
    last = last_date(rows)
    if last:
        return last - dt.timedelta(days=overlap_days)
    return TODAY - dt.timedelta(days=int(365.25 * years))


def year_chunks(start, end):
    s = start
    while s <= end:
        e = min(end, s + dt.timedelta(days=364))
        yield s.strftime("%Y%m%d"), e.strftime("%Y%m%d")
        s = e + dt.timedelta(days=1)


def flat_cols(df):
    if isinstance(df.columns, pd.MultiIndex):
        cols = []
        for tup in df.columns:
            parts = []
            for p in tup:
                p = str(p)
                if p.startswith("Unnamed") or p in parts:
                    continue
                parts.append(p)
            cols.append(" ".join(parts))
        df.columns = cols
    else:
        df.columns = [str(c) for c in df.columns]
    return df


def find_col(df, *keys, exclude=("증감", "전일비")):
    for c in df.columns:
        if all(k in c for k in keys) and not any(x in c for x in exclude):
            return c
    return None


class LegacyTLS(HTTPAdapter):
    """오래된 암호화 방식을 쓰는 사이트(38커뮤니케이션 등)용 접속 설정. 인증서 검증은 그대로 합니다."""

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        ctx.minimum_version = ssl.TLSVersion.TLSv1
        ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


_legacy = requests.Session()
_legacy.mount("https://", LegacyTLS())


def decode(r, must=None):
    """응답을 한글이 깨지지 않게 풉니다. must(예: '예탁금')가 들어 있는 해석을 고릅니다."""
    raw = r.content
    tried = []
    for enc in (r.encoding, "utf-8", "cp949", "euc-kr"):
        if not enc or enc.lower() in tried:
            continue
        tried.append(enc.lower())
        try:
            text = raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        if must is None or must in text:
            return text
    return raw.decode("cp949", errors="replace")


def get_html(url, params=None, must=None):
    """https → 오래된 암호화 방식 허용 → http 순서로 시도합니다."""
    attempts = [
        ("https", lambda: requests.get(url, params=params, headers=UA, timeout=25)),
        ("https-legacy", lambda: _legacy.get(url, params=params, headers=UA, timeout=25)),
        ("http", lambda: requests.get(url.replace("https://", "http://", 1), params=params, headers=UA, timeout=25)),
    ]
    last = None
    for name, call in attempts:
        try:
            r = call()
            r.raise_for_status()
            text = decode(r, must)
            if must and must not in text:
                snippet = re.sub(r"\s+", " ", text[:300])
                raise RuntimeError(f"'{must}' 없음 (상태 {r.status_code}, 주소 {r.url}, 앞부분: {snippet})")
            return text
        except Exception as e:  # noqa: BLE001
            print(f"    {name} 실패: {str(e)[:200]}", flush=True)
            last = e
    raise last


# ---------- 1. 한국거래소 ----------

def krx_login_check():
    if not (os.getenv("KRX_ID") and os.getenv("KRX_PW")):
        raise RuntimeError(
            "KRX_ID / KRX_PW 가 설정되지 않았습니다. 저장소 Settings > Secrets and variables > Actions 에 추가하세요."
        )


def collect_market(old):
    """코스피 PER·PBR, 코스피·코스닥 시가총액(조원)·거래대금(조원), 일별."""
    krx_login_check()
    from pykrx import stock

    start = start_from(old, 14, CFG.get("backfill_years", 10))
    rows = {}
    for s, e in year_chunks(start, TODAY):
        f = stock.get_index_fundamental_by_date(s, e, "1001")
        for d, r in f.iterrows():
            x = rows.setdefault(d.strftime("%Y-%m-%d"), {})
            x["kospi"] = num(r.get("종가"))
            per, pbr = num(r.get("PER")), num(r.get("PBR"))
            x["per"] = per if per else None
            x["pbr"] = pbr if pbr else None
        time.sleep(0.7)
        for tk, nm in (("1001", "k"), ("2001", "q")):
            o = stock.get_index_ohlcv_by_date(s, e, tk, name_display=False)
            for d, r in o.iterrows():
                x = rows.setdefault(d.strftime("%Y-%m-%d"), {})
                cap, trd = num(r.get("상장시가총액")), num(r.get("거래대금"))
                if nm == "q":
                    x["kosdaq"] = num(r.get("종가"))
                x["cap_" + nm] = round(cap / 1e12, 1) if cap else None
                x["trd_" + nm] = round(trd / 1e12, 2) if trd else None
            time.sleep(0.7)
        print(f"  KRX 지수 {s}~{e}: 누적 {len(rows)}일")
    new = [{"d": d, **v} for d, v in sorted(rows.items()) if v.get("kospi")]
    if not new:
        raise RuntimeError("한국거래소에서 받은 행이 없습니다(로그인 실패 또는 차단 가능성).")
    return merge(old, new, "d")


def collect_retail(old):
    """시장별 개인 거래대금 비중(매수+매도 기준), 월별."""
    krx_login_check()
    from pykrx import stock

    last = old[-1]["m"] if old else None
    start = (dt.date.fromisoformat(last + "-01") if last
             else TODAY - dt.timedelta(days=365 * 3)).replace(day=1)
    acc = {}
    for mk in ("KOSPI", "KOSDAQ"):
        for s, e in year_chunks(start, TODAY):
            parts = []
            for side in ("매수", "매도"):
                df = stock.get_market_trading_value_by_date(s, e, mk, on=side)
                parts.append(df)
                time.sleep(0.7)
            for df in parts:
                total_col = "전체" if "전체" in df.columns and df["전체"].abs().sum() > 0 else None
                for d, r in df.iterrows():
                    m = d.strftime("%Y-%m")
                    a = acc.setdefault(m, {}).setdefault(mk, [0.0, 0.0])
                    ind = float(r.get("개인", 0) or 0)
                    tot = float(r[total_col]) if total_col else float(
                        sum(abs(float(v)) for k, v in r.items() if k != "전체"))
                    a[0] += abs(ind)
                    a[1] += abs(tot)
        print(f"  KRX 투자자별 {mk}: {len(acc)}개월")
    new = []
    for m in sorted(acc):
        row = {"m": m}
        for mk, key in (("KOSPI", "kospi"), ("KOSDAQ", "kosdaq")):
            ind, tot = acc[m].get(mk, [0, 0])
            row[key] = round(ind / tot * 100, 2) if tot else None
        new.append(row)
    if not new:
        raise RuntimeError("투자자별 거래대금을 받지 못했습니다.")
    return merge(old, new, "m")


# ---------- 2. 네이버 증시자금동향 ----------

DATE_RE = re.compile(r"(\d{2,4})\.(\d{1,2})\.(\d{1,2})")


def parse_deposit_table(t):
    """표 하나에서 (날짜, 예탁금, 신용잔고) 행을 뽑습니다. 날짜 열은 값 모양으로 찾습니다."""
    pcol = find_col(t, "예탁금")
    ccol = find_col(t, "신용")
    if not pcol:
        return []
    dcol = max(t.columns, key=lambda c: t[c].astype(str).str.match(DATE_RE).sum())
    rows = []
    for _, r in t.iterrows():
        m = DATE_RE.match(str(r[dcol]).strip())
        if not m:
            continue
        y = int(m.group(1))
        y = y + 2000 if y < 100 else y
        try:
            d = dt.date(y, int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        dep = num(r[pcol])
        cr = num(r[ccol]) if ccol else None
        if dep is None:
            continue
        rows.append({"d": d.isoformat(), "deposit": round(dep / 1e4, 2),
                     "credit": round(cr / 1e4, 2) if cr else None})
    return rows


def collect_deposits(old):
    """투자자예탁금·신용잔고(조원), 일별. 네이버 표의 단위는 억원."""
    stop = (last_date(old) - dt.timedelta(days=10)) if old else (TODAY - dt.timedelta(days=365 * 3))
    new = []
    for page in range(1, 400):
        html = get_html("https://finance.naver.com/sise/sise_deposit.naver", {"page": page}, must="예탁금")
        tables = [flat_cols(t) for t in pd.read_html(io.StringIO(html))]
        best = max((parse_deposit_table(t) for t in tables), key=len, default=[])
        if not best:
            if page == 1:
                print("    네이버 표 진단:", flush=True)
                for i, t in enumerate(tables):
                    print(f"      표{i}: 열={list(t.columns)[:8]} 첫 행={t.head(2).astype(str).values.tolist()}", flush=True)
                raise RuntimeError("네이버 표에서 날짜·예탁금 행을 찾지 못했습니다(위 진단 참고).")
            break
        new += best
        oldest = min(dt.date.fromisoformat(r["d"]) for r in best)
        if oldest < stop:
            break
        time.sleep(0.4)
    print(f"  네이버 증시자금: {len(new)}일", flush=True)
    if not new:
        raise RuntimeError("네이버에서 예탁금을 읽지 못했습니다.")
    return merge(old, new, "d")


# ---------- 3. 38커뮤니케이션 공모주 ----------

def clean_name(s):
    s = re.sub(r"\(.*?\)", "", str(s))
    return re.sub(r"\s+", "", s).strip()


def collect_ipo(old):
    pages = 3 if old else 12
    base = "https://www.38.co.kr/html/fund/index.htm"

    comps = {}
    for p in range(1, pages + 1):
        html = get_html(base, {"o": "k", "page": p}, must="경쟁률")
        for t in pd.read_html(io.StringIO(html), match="경쟁률"):
            t = flat_cols(t)
            ncol, ccol = t.columns[0], find_col(t, "경쟁률")
            if not ccol:
                continue
            for _, r in t.iterrows():
                m = re.search(r"([\d,]+(?:\.\d+)?)\s*:\s*1", str(r[ccol]))
                if m:
                    comps[clean_name(r[ncol])] = float(m.group(1).replace(",", ""))
        time.sleep(0.5)

    new = []
    for p in range(1, pages + 1):
        html = get_html(base, {"o": "nw", "page": p}, must="공모가")
        tables = [flat_cols(t) for t in pd.read_html(io.StringIO(html), match="공모가")]
        t = next((t for t in tables if find_col(t, "상장일")), None)
        if t is None:
            continue
        ncol = t.columns[0]
        dcol = find_col(t, "상장일")
        ocol = find_col(t, "공모가", exclude=("대비", "증감"))
        scol = find_col(t, "시초가", exclude=("/", "대비"))
        ccol = find_col(t, "첫날")
        for _, r in t.iterrows():
            name = clean_name(r[ncol])
            if not name or "스팩" in name:
                continue
            m = re.search(r"(\d{4})[./-](\d{1,2})[./-](\d{1,2})", str(r[dcol]))
            offer = num(r[ocol]) if ocol else None
            if not m or not offer:
                continue
            opn = num(r[scol]) if scol else None
            cls = num(r[ccol]) if ccol else None
            new.append({
                "k": f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}_{name}",
                "d": f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}",
                "name": name,
                "offer": offer,
                "open_pct": round((opn / offer - 1) * 100, 1) if opn else None,
                "close_pct": round((cls / offer - 1) * 100, 1) if cls else None,
                "comp": comps.get(name),
            })
        time.sleep(0.5)
    print(f"  38커뮤니케이션: 상장 {len(new)}건, 경쟁률 {len(comps)}건")
    if not new:
        raise RuntimeError("38커뮤니케이션 신규상장 표를 읽지 못했습니다.")
    merged = merge(old, new, "k")
    # 경쟁률은 상장 뒤에 목록에서 빠질 수 있으니, 기존 값을 지우지 않습니다.
    return merged


# ---------- 실행 ----------

def main():
    data = load()
    errors, ok = [], 0
    jobs = [
        ("market", "한국거래소 지수·PER·시가총액", collect_market),
        ("retail", "한국거래소 투자자별 거래대금", collect_retail),
        ("deposits", "네이버 예탁금·신용잔고", collect_deposits),
        ("ipo", "38커뮤니케이션 공모주", collect_ipo),
    ]
    for key, label, fn in jobs:
        print(f"[{label}]", flush=True)
        try:
            data[key] = fn(data.get(key, []))
            ok += 1
        except Exception as e:  # noqa: BLE001 — 출처 하나가 실패해도 나머지는 저장
            traceback.print_exc(file=sys.stdout)
            errors.append({"source": label, "message": str(e)[:300]})
    data["meta"] = {
        "updated": dt.datetime.now(KST).isoformat(timespec="minutes"),
        "errors": errors,
        "gdp": CFG.get("gdp", {}),
        "rules": CFG.get("rules", {}),
    }
    save(data)
    print(f"완료: 성공 {ok} / 실패 {len(errors)}")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()

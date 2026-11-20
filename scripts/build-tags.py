#!/usr/bin/env python3
"""public/tags/*.tsv (자동완성 데이터)를 다시 만든다.

입력:
  --danbooru  NAIS3 resources/tags.json            [{value, count, type}]
  --e621      e621 db_export 의 tags.csv.gz          (https://e621.net/db_exports)
  --kr-danbooru / --kr-e621  NAIA2.0 data/KR_tags.parquet, e621_KR_tags.parquet (한국어 키워드, 선택)

출력 형식 (게시물 수 내림차순): 태그 \\t 게시물 수 \\t 분류 \\t 한국어 키워드
분류: g 일반, a 작가, c 캐릭터, s 작품, m 메타, p 종(e621), l 설정(e621)
"""
import argparse, csv, gzip, json, os, re

MIN_COUNT = 30
DAN_TYPES = {"general": "g", "artist": "a", "character": "c", "copyright": "s", "meta": "m"}
E6_CATS = {"0": "g", "1": "a", "3": "s", "4": "c", "5": "p", "7": "m", "8": "l"}


def keywords(path):
    if not path:
        return {}
    import pyarrow.parquet as pq

    out = {}
    for row in pq.read_table(path).to_pylist():
        raw = re.sub(r"<[^>]*>", "", row.get("keywords") or "")
        words = ", ".join(w.strip() for w in raw.split(",") if w.strip())
        if words:
            out[row["tag"].replace("_", " ").lower()] = words.replace("\t", " ")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--danbooru", required=True)
    ap.add_argument("--e621", required=True)
    ap.add_argument("--kr-danbooru")
    ap.add_argument("--kr-e621")
    ap.add_argument("--out", default="public/tags")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    kr = keywords(a.kr_danbooru)
    rows = [t for t in json.load(open(a.danbooru)) if t["count"] >= MIN_COUNT and "\t" not in t["value"]]
    rows.sort(key=lambda t: -t["count"])
    with open(os.path.join(a.out, "danbooru.tsv"), "w", encoding="utf-8") as f:
        for t in rows:
            name = t["value"].lower()
            f.write(f"{name}\t{t['count']}\t{DAN_TYPES.get(t['type'], 'g')}\t{kr.get(name, '')}\n")

    kr = keywords(a.kr_e621)
    with gzip.open(a.e621, "rt", encoding="utf-8") as src:
        rows = [r for r in csv.DictReader(src) if int(r["post_count"]) >= MIN_COUNT and r["category"] in E6_CATS]
    rows.sort(key=lambda r: -int(r["post_count"]))
    with open(os.path.join(a.out, "e621.tsv"), "w", encoding="utf-8") as f:
        for r in rows:
            name = r["name"].replace("_", " ").lower()
            if "\t" not in name:
                f.write(f"{name}\t{r['post_count']}\t{E6_CATS[r['category']]}\t{kr.get(name, '')}\n")


if __name__ == "__main__":
    main()

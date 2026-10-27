# -*- coding: utf-8 -*-
"""study-ops — DDT 逐试次质检。

从 stdin 读 {"codesDir": "...", "files": ["...csv", ...]}，
用项目里已经验证过的 ddt_extract_rt.parse_file 解析，向 stdout 写 JSON。

不重新实现 RT / 超时折叠 / 金额解析的口径：那是 ddt_extract_rt 的职责。
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def cell_counts(df):
    """每个金额档内，按延迟文本的连续段切格，返回每格的试次数。"""
    counts = []
    for _, g in df.groupby("block", sort=False):
        g = g.sort_values("trial_in_block")
        seg = (g["delay_text"] != g["delay_text"].shift()).cumsum()
        counts.extend(int(v) for v in g.groupby(seg).size().tolist())
    return counts


def check_file(ex, path):
    d = ex.parse_file(path)
    if d is None or len(d) == 0:
        return {"path": path, "ok": False, "error": "没有解析出有效试次"}

    trials = int(len(d))
    counts = cell_counts(d)
    bad_cells = sum(1 for c in counts if c != 6)
    ip_cells = sum(1 for c in counts if c == 6)

    timed_out = int(d["timed_out"].sum()) if "timed_out" in d.columns else 0
    n_timeouts = int(d["n_timeouts"].sum()) if "n_timeouts" in d.columns else 0

    rt = d["rt"]
    rt = rt[rt.notna()]
    rt_median = float(rt.median()) if len(rt) else None
    # 只标两种值得人看一眼的试次：快到像误触，以及慢到像被打断。
    # 4 s 限时是 2026-10-21 才加的，之前的长 RT 是真实犹豫，不能按 4 s 判。
    if len(rt):
        fast_share = float((rt < 0.2).sum() / len(rt))
        slow_share = float((rt > 10.0).sum() / len(rt))
        rt_max = float(rt.max())
    else:
        fast_share = 0.0
        slow_share = 0.0
        rt_max = None

    ll_rate = float(d["choice_LL"].mean()) if "choice_LL" in d.columns else None

    return {
        "path": path,
        "ok": True,
        "participant": str(d["subject"].iloc[0]),
        "session": str(d["session"].iloc[0]),
        "date": str(d["date"].iloc[0])[:10] if "date" in d.columns else "",
        "trials": trials,
        "cells": len(counts),
        "badCells": bad_cells,
        "ipCells": ip_cells,
        "timeouts": timed_out,
        "nTimeouts": n_timeouts,
        "timeoutShare": round(timed_out / trials, 4) if trials else 0.0,
        "rtMedian": round(rt_median, 3) if rt_median is not None else None,
        "rtMax": round(rt_max, 2) if rt_max is not None else None,
        "fastShare": round(fast_share, 4),
        "slowShare": round(slow_share, 4),
        "llRate": round(ll_rate, 4) if ll_rate is not None else None,
    }


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "--json":
            with open(sys.argv[2], "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.load(sys.stdin)
    except Exception as error:
        print(json.dumps({"ok": False, "error": "读不到输入 JSON：%s" % error}, ensure_ascii=False))
        return

    codes_dir = payload.get("codesDir") or ""
    files = payload.get("files") or []
    if not os.path.isdir(codes_dir):
        print(json.dumps({"ok": False, "error": "找不到解析脚本目录：%s" % codes_dir}, ensure_ascii=False))
        return
    sys.path.insert(0, codes_dir)
    try:
        import ddt_extract_rt as ex  # noqa: F401
    except Exception as error:
        print(json.dumps({"ok": False, "error": "导入 ddt_extract_rt 失败：%s" % error}, ensure_ascii=False))
        return

    results = []
    for path in files:
        try:
            results.append(check_file(ex, path))
        except Exception as error:
            results.append({"path": path, "ok": False, "error": "%s: %s" % (type(error).__name__, error)})

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()

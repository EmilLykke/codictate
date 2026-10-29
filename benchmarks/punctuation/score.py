# Punctuation metric vs FLEURS raw_transcription, on word-aligned matches only,
# so WER differences don't leak in. Variants: own, ekko-pnc(own), ekko-pnc(strip(own)).
import json, re, sys
from ekko.artifacts import ensure_pnc_directory
from ekko.pnc import Punctuator

MARKS = ",.?!"  # ekko-pnc's label set
def norm(t): return re.sub(r"[^\w]", "", t.lower())
def strip_marks(text):
    out = [re.sub(r"[,.?!]+$", "", w) for w in text.split()]
    return " ".join(w for w in out if w)
def end_kind(t):
    t = t.rstrip('"\')»”')
    if t.endswith(("?", "!")) or (t.endswith(".") and not re.search(r"\w\.\w", t)): return "end"
    if t.endswith(","): return "comma"
    return None
def is_cap(t):
    for c in t:
        if c.isalpha(): return c.isupper()
    return None

def align(h, r):
    hn = [norm(x) for x in h]; rn = [norm(x) for x in r]
    hi = [i for i, x in enumerate(hn) if x]; ri = [i for i, x in enumerate(rn) if x]
    n, m = len(hi), len(ri)
    D = [[0]*(m+1) for _ in range(n+1)]
    for i in range(n+1): D[i][0] = i
    for j in range(m+1): D[0][j] = j
    for i in range(1, n+1):
        for j in range(1, m+1):
            D[i][j] = min(D[i-1][j]+1, D[i][j-1]+1, D[i-1][j-1] + (hn[hi[i-1]] != rn[ri[j-1]]))
    pairs, i, j = [], n, m
    while i > 0 and j > 0:
        same = hn[hi[i-1]] == rn[ri[j-1]]
        if D[i][j] == D[i-1][j-1] + (not same):
            if same: pairs.append((hi[i-1], ri[j-1]))
            i, j = i-1, j-1
        elif D[i][j] == D[i-1][j]+1: i -= 1
        else: j -= 1
    return pairs, (m and ri[-1])

def score(rows, key):
    c = {k: [0,0,0] for k in ("end", "endmid", "comma")}  # tp, fp, fn
    cap_ok = cap_n = cap_tp = cap_fp = cap_fn = words = doubled = 0
    for row in rows:
        h, r = row[key].split(), row["ref"].split()
        words += len(h)
        doubled += sum(1 for w in h if re.search(r"[,.?!]{2,}$", w) and not re.search(r"\w\.\w", w))
        pairs, last = align(h, r)
        for hi, ri in pairs:
            hk, rk = end_kind(h[hi]), end_kind(r[ri])
            for k, kind, mid_only in (("end","end",False), ("endmid","end",True), ("comma","comma",False)):
                if mid_only and ri == last: continue
                if hk == kind and rk == kind: c[k][0] += 1
                elif hk == kind: c[k][1] += 1
                elif rk == kind: c[k][2] += 1
            hc, rc = is_cap(h[hi]), is_cap(r[ri])
            if hc is None or rc is None: continue
            cap_n += 1; cap_ok += hc == rc
            cap_tp += hc and rc; cap_fp += hc and not rc; cap_fn += rc and not hc
    f1 = lambda tp, fp, fn: (2*tp/(2*tp+fp+fn) if tp+fp+fn else 0, tp/(tp+fp) if tp+fp else 0, tp/(tp+fn) if tp+fn else 0)
    return {
        "endF1": f1(*c["end"]), "midEndF1": f1(*c["endmid"]), "commaF1": f1(*c["comma"]),
        "capAcc": cap_ok/cap_n, "capF1": f1(cap_tp, cap_fp, cap_fn), "doubledPer100": 100*doubled/max(words,1),
        "counts": c,
    }

if __name__ == "__main__":
    pnc = Punctuator(ensure_pnc_directory())
    out = {}
    for path in sys.argv[1:]:
        rows = [json.loads(l) for l in open(path)]
        rows = [r for r in rows if r["status"] == "ok" and r["hyp"] is not None]
        for r in rows:
            r["own"] = r["hyp"]
            r["pnc"] = pnc(r["hyp"]) if r["hyp"].strip() else ""
            r["pncStrip"] = pnc(strip_marks(r["hyp"])) if strip_marks(r["hyp"]) else ""
        with open(path.replace(".jsonl", ".scored.jsonl"), "w") as f:
            for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
        out[path.rsplit("/",1)[-1]] = {"n": len(rows), **{k: score(rows, k) for k in ("own", "pnc", "pncStrip")}}
    print(json.dumps(out, indent=1))

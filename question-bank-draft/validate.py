"""Validate every bank file. Usage: python validate.py [path ...]  (no args = whole bank)"""
import json, os, re, sys, glob, itertools
from difflib import SequenceMatcher
ROOT = os.path.dirname(os.path.abspath(__file__))
SPEC = {
 "investment_banking": ["M&A Advisory","Leveraged Finance","Equity Capital Markets (ECM)","Debt Capital Markets (DCM)","Restructuring","TMT Coverage","Healthcare Coverage","Energy & Power Coverage","Consumer & Retail Coverage","Financial Institutions (FIG) Coverage","Industrials Coverage","Real Estate Coverage","Media & Telecom","Natural Resources"],
 "private_equity": ["Buyout / LBO","Distressed / Special Situations","Infrastructure","Secondaries","Fund of Funds"],
 "venture_capital": ["Seed & Early Stage","Growth Stage","Growth Equity","Corporate Venture Capital"],
 "private_credit": ["Direct Lending","Mezzanine & Structured Credit","Distressed & Special Situations Credit","Asset-Based Lending"],
 "real_estate": ["Real Estate Private Equity","REIT Investing","Real Estate Investment Banking","Real Estate Debt / Lending","Real Estate Development","Real Estate Brokerage"],
 "hedge_fund": ["Long/Short Equity","Global Macro","Quantitative / Systematic","Credit & Distressed","Event-Driven / Merger Arb","Multi-Strategy","Commodities Trading"],
 "sales_trading": ["Equities Trading","Fixed Income Trading","FX Trading","Commodities Trading","Derivatives / Structured Products","Electronic / Algo Trading"],
 "asset_wealth_management": ["Public Equities AM","Fixed Income AM","Multi-Asset / Allocation","Private Wealth Management","Institutional Client Coverage"],
 "commercial_banking": ["Corporate & Middle-Market Lending","Credit Analysis & Underwriting","Treasury & Cash Management","Commercial Real Estate Lending"],
 "insurance": ["Underwriting","Actuarial","Insurance Investment Management","Reinsurance"],
 "fintech": ["Payments","Digital Lending","Wealthtech & Brokerage","Crypto & Digital Assets"],
 "market_infrastructure": ["Exchanges & Trading Venues","Clearing & Settlement","Market Data & Indices","Custody & Securities Services"],
 "consulting": ["Strategy Consulting","Management Consulting (generalist)","Operations & Performance Improvement","Restructuring & Turnaround","Deals / Transaction Services","Economic & Financial Consulting","Actuarial & Risk Consulting","Technology & Digital Consulting"],
 "other_finance": ["Corporate Finance / FP&A","Corporate Development","Treasury","Credit Ratings & Research"],
}
CATS = {"Motivation","Fit","Teamwork","Leadership","Challenges","Integrity","Commercial Awareness","Curveball"}
DIFFS = ["foundational","intermediate","advanced"]
# Targets (brief scaled ~22% to reach 8,000+)
T_GEN, B_GEN, T_SPEC, B_SPEC, B_UNIV, B_UNIV_CAT = 37, 37, 19, 18, 184, 23
def slug(s): return re.sub(r"[^a-z0-9]+","-",s.lower()).strip("-")
def norm(s): return re.sub(r"[^a-z0-9 ]"," ",s.lower()).split()

def check_file(p, errs, warns):
    try: d = json.load(open(p))
    except Exception as e: errs.append(f"{p}: JSON error {e}"); return None
    rel = os.path.relpath(p, ROOT); sec, spec = d.get("sector"), d.get("specialty")
    if set(d) != {"sector","specialty","technical","behavioral"}: errs.append(f"{rel}: top-level keys {sorted(d)}")
    universal = rel.startswith("_universal")
    if universal:
        if sec is not None or spec is not None: errs.append(f"{rel}: universal must have null sector/specialty")
    else:
        if sec not in SPEC: errs.append(f"{rel}: bad sector {sec}")
        elif spec is not None and spec not in SPEC[sec]: errs.append(f"{rel}: specialty '{spec}' not in table")
        exp = "_general.json" if spec is None else slug(spec or "")+".json"
        if os.path.basename(p) != exp or os.path.basename(os.path.dirname(p)) != sec: errs.append(f"{rel}: path doesn't match sector/specialty")
    T, B = d["technical"], d["behavioral"]
    for q in T:
        for k in ("id","topic","difficulty","prompt","expectedPoints","choices"):
            if k not in q: errs.append(f"{q.get('id')}: missing {k}")
        if q.get("difficulty") not in DIFFS: errs.append(f"{q['id']}: bad difficulty")
        if not 3 <= len(q["expectedPoints"]) <= 6: errs.append(f"{q['id']}: {len(q['expectedPoints'])} expectedPoints")
        c = q["choices"]
        if c is not None:
            ds = c.get("distractors", [])
            if len(ds) != 3 or len({c["answer"].strip().lower(), *[x.strip().lower() for x in ds]}) != 4:
                errs.append(f"{q['id']}: choices need 3 distinct distractors different from answer")
            L = [len(c["answer"])] + [len(x) for x in ds]
            if max(L) > 2.2*min(L) and max(L) - min(L) > 20: warns.append(f"{q['id']}: option lengths uneven {L}")
    for q in B:
        if q.get("category") not in CATS: errs.append(f"{q['id']}: bad category {q.get('category')}")
        if q.get("difficulty") not in DIFFS: errs.append(f"{q['id']}: bad difficulty")
        if not 3 <= len(q["expectedPoints"]) <= 6: errs.append(f"{q['id']}: {len(q['expectedPoints'])} expectedPoints")
        if "choices" in q: errs.append(f"{q['id']}: behavioral must not have choices")
    # counts
    cnt = {df: sum(q["difficulty"]==df for q in T) for df in DIFFS}
    if universal:
        if len(B) < B_UNIV: errs.append(f"{rel}: behavioral {len(B)} < {B_UNIV}")
        for c in CATS:
            n = sum(q["category"]==c for q in B)
            if n < B_UNIV_CAT: errs.append(f"{rel}: {c} has {n} < {B_UNIV_CAT}")
    else:
        tt, bt = (T_GEN, B_GEN) if spec is None else (T_SPEC, B_SPEC)
        for df in DIFFS:
            if cnt[df] < tt: errs.append(f"{rel}: {df} {cnt[df]} < {tt}")
        if len(B) < bt: errs.append(f"{rel}: behavioral {len(B)} < {bt}")
        if T:
            share = sum(q["choices"] is not None for q in T)/len(T)
            if share < 2/3: errs.append(f"{rel}: only {share:.0%} technical have choices")
    # within-file near duplicates
    ps = [(q["id"], q["prompt"]) for q in T+B]
    for (i1,p1),(i2,p2) in itertools.combinations(ps,2):
        if SequenceMatcher(None,p1.lower(),p2.lower()).ratio() > 0.85: errs.append(f"near-duplicate: {i1} ~ {i2}")
    return d, cnt

def main():
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT,"**","*.json"), recursive=True))
    all_files = sorted(glob.glob(os.path.join(ROOT,"**","*.json"), recursive=True))
    errs, warns = [], []; rows = []
    for p in files:
        r = check_file(p, errs, warns)
        if r: d, cnt = r; T = d["technical"]; rows.append((os.path.relpath(p,ROOT), cnt, len(d["behavioral"]), (sum(q["choices"] is not None for q in T)/len(T)) if T else None))
    # global id uniqueness + cross-file duplicate prompts
    ids, prompts = {}, []
    for p in all_files:
        try: d = json.load(open(p))
        except Exception: continue
        for q in d["technical"]+d["behavioral"]:
            if q["id"] in ids: errs.append(f"duplicate id {q['id']} in {p} and {ids[q['id']]}")
            ids[q["id"]] = p; prompts.append((q["id"], set(norm(q["prompt"]))))
    for (i1,s1),(i2,s2) in itertools.combinations(prompts,2):
        if i1.rsplit(".",1)[0]==i2.rsplit(".",1)[0]: continue
        if len(s1)>=6 and len(s2)>=6 and len(s1&s2)/len(s1|s2) >= 0.8: errs.append(f"cross-file near-duplicate: {i1} ~ {i2}")
    for f,cnt,b,share in rows:
        print(f"{f:60s} F{cnt['foundational']:>3} I{cnt['intermediate']:>3} A{cnt['advanced']:>3}  B{b:>3}  options {'' if share is None else f'{share:.0%}'}")
    for w in warns: print("WARN", w)
    for e in errs: print("ERROR", e)
    print(f"\n{len(errs)} errors, {len(warns)} warnings, {len(ids)} questions in bank")
    sys.exit(1 if errs else 0)
if __name__ == "__main__": main()

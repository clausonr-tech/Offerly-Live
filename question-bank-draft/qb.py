"""Helper for appending question batches to bank files. Skips prompts already present (safe to re-run)."""
import json, os, re
ROOT = os.path.dirname(os.path.abspath(__file__))
DIFF = {"F": "foundational", "I": "intermediate", "A": "advanced"}
CAT = {"Mo": "Motivation", "Fi": "Fit", "Te": "Teamwork", "Le": "Leadership", "Ch": "Challenges",
       "In": "Integrity", "Co": "Commercial Awareness", "Cu": "Curveball"}

def slug(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def path_for(sector, specialty):
    if sector is None: return os.path.join(ROOT, "_universal", "behavioral.json")
    return os.path.join(ROOT, sector, "_general.json" if specialty is None else slug(specialty) + ".json")

def base_id(sector, specialty):
    if sector is None: return "universal.behavioral"
    return f"{sector}.{'general' if specialty is None else slug(specialty)}"

def _load(sector, specialty):
    p = path_for(sector, specialty)
    if os.path.exists(p):
        with open(p) as f: return json.load(f)
    return {"sector": sector, "specialty": specialty, "technical": [], "behavioral": []}

def dumps(d):
    """A bank file as JSON with one question per line, so a diff of the bank
    shows one line per question changed rather than sixteen."""
    parts = []
    for k, v in d.items():
        if isinstance(v, list) and v:
            rows = ",\n".join("    " + json.dumps(q, ensure_ascii=False) for q in v)
            parts.append(f"  {json.dumps(k)}: [\n{rows}\n  ]")
        else:
            parts.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}")
    return "{\n" + ",\n".join(parts) + "\n}\n"

def _save(sector, specialty, d):
    p = path_for(sector, specialty); os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f: f.write(dumps(d))

def add_technical(sector, specialty, items):
    """items: (topic, F/I/A, prompt, [points], answer or None, [3 distractors] or None)"""
    d = _load(sector, specialty); have = {q["prompt"] for q in d["technical"]}; b = base_id(sector, specialty); n = 0
    for topic, df, prompt, pts, ans, dis in items:
        if prompt in have: continue
        i = len(d["technical"]) + 1
        d["technical"].append({"id": f"{b}.t{i:03d}", "topic": topic, "difficulty": DIFF[df], "prompt": prompt,
            "expectedPoints": pts, "choices": None if ans is None else {"answer": ans, "distractors": dis}}); n += 1
    _save(sector, specialty, d); print(f"+{n} technical -> {len(d['technical'])} total")

def add_behavioral(sector, specialty, items):
    """items: (category code, F/I/A, prompt, [points])"""
    d = _load(sector, specialty); have = {q["prompt"] for q in d["behavioral"]}; b = base_id(sector, specialty); n = 0
    for cat, df, prompt, pts in items:
        if prompt in have: continue
        i = len(d["behavioral"]) + 1
        d["behavioral"].append({"id": f"{b}.b{i:03d}", "category": CAT[cat], "difficulty": DIFF[df],
            "prompt": prompt, "expectedPoints": pts}); n += 1
    _save(sector, specialty, d); print(f"+{n} behavioral -> {len(d['behavioral'])} total")

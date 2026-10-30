"""Rewrite every bank file with one question per line (see qb.dumps).

Run after editing a file by hand or with json.dump(indent=2):
    python3 format.py
The content is unchanged - only the layout - and the result is still plain JSON.
"""
import glob, json, os
from qb import ROOT, dumps

changed = 0
for p in sorted(glob.glob(os.path.join(ROOT, "*", "*.json"))):
    with open(p) as f: raw = f.read()
    out = dumps(json.loads(raw))
    assert json.loads(out) == json.loads(raw), p
    if out != raw:
        with open(p, "w") as f: f.write(out)
        changed += 1
print(f"formatted {changed} file(s)")

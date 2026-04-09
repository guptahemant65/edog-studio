"""Analyze notebook network capture results."""
import json
from pathlib import Path

data = json.loads((Path(__file__).parent.parent / "docs" / "notebook-editor-network-calls.json").read_text())
unique = data["unique"]
print(f"Total unique patterns: {len(unique)}")
print()

cats = {"Notebook/Item": [], "Capacity/Compute": [], "OneLake": [], "Metadata": [], "Token": [], "Other": []}
for ep in sorted(unique, key=lambda x: x["pattern"]):
    p = ep["pattern"]
    line = f"{ep['method']:>5} x{ep['count']:<3} {p[:110]}"
    bd = ep.get("post_data", "")
    if bd:
        line += f"\n              body: {bd[:150]}"

    if any(k in p for k in ["artifact", "notebook", "item", "definition", "synapse"]):
        cats["Notebook/Item"].append(line)
    elif any(k in p for k in ["capacity", "webapi", "pbidedicated"]):
        cats["Capacity/Compute"].append(line)
    elif "onelake" in p or "dfs" in p:
        cats["OneLake"].append(line)
    elif "mwctoken" in p or "msal" in p:
        cats["Token"].append(line)
    elif "metadata" in p:
        cats["Metadata"].append(line)
    else:
        cats["Other"].append(line)

for cat, lines in cats.items():
    if lines:
        print(f"=== {cat} ({len(lines)}) ===")
        for l in lines:
            print(f"  {l}")
        print()

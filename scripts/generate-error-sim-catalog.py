"""Generate error-sim-catalog.js from EdogErrorCodeCatalog.cs."""
import json
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
CS_FILE = REPO / "src" / "backend" / "DevMode" / "EdogErrorCodeCatalog.cs"
JS_OUT = REPO / "src" / "frontend" / "js" / "error-sim-catalog.js"


def main():
    cs = CS_FILE.read_text(encoding="utf-8")

    pattern = re.compile(
        r"Code\s*=\s*\"([^\"]+)\".*?"
        r"Phase\s*=\s*\"([^\"]+)\".*?"
        r"Channel\s*=\s*(\d+).*?"
        r"ErrorSource\s*=\s*\"([^\"]+)\".*?"
        r"Category\s*=\s*\"([^\"]+)\".*?"
        r"NodeKinds\s*=\s*new\[\]\s*\{([^}]*)\}.*?"
        r"Description\s*=\s*\"([^\"]+)\".*?"
        r"HttpStatus\s*=\s*(\d+).*?"
        r"FltCodePath\s*=\s*\"([^\"]+)\"",
        re.DOTALL,
    )

    entries = []
    for m in pattern.finditer(cs):
        kinds_raw = m.group(6)
        kinds = [k.strip().strip('"').strip() for k in kinds_raw.split(",") if k.strip().strip('"').strip()]
        entries.append({
            "code": m.group(1),
            "phase": m.group(2),
            "channel": int(m.group(3)),
            "errorSource": m.group(4),
            "category": m.group(5),
            "nodeKinds": kinds,
            "description": m.group(7),
            "httpStatus": int(m.group(8)),
            "fltCodePath": m.group(9),
        })

    print(f"Extracted {len(entries)} entries from {CS_FILE.name}")

    js = "// AUTO-GENERATED from EdogErrorCodeCatalog.cs \u2014 do not edit manually\n"
    js += f"// Error codes: {len(entries)}\n"
    js += "var ERROR_SIM_CATALOG = " + json.dumps(entries, indent=2) + ";\n"

    JS_OUT.write_text(js, encoding="utf-8")
    print(f"Written to {JS_OUT}")


if __name__ == "__main__":
    main()

"""Capture all network calls from Fabric Notebook Editor page.

Navigates to a specific notebook, captures API calls, then clicks
around to discover content/execution/definition endpoints.
"""
import asyncio
import contextlib
import json
import re
import time
from pathlib import Path

USERNAME = "Admin1CBA@FabricFMLV08PPE.ccsctp.net"
NOTEBOOK_URL = "https://powerbi-df.analysis-df.windows.net/groups/1b20c810-b067-4b98-b418-935456c1256f/synapsenotebooks/e1952851-641f-4dc6-8fae-3ac5a67aa3e4?experience=power-bi"

PROJECT_DIR = Path(__file__).parent.parent
captured = []


async def main():
    from playwright.async_api import async_playwright

    cert_subject = USERNAME.replace("@", ".")
    cert_policy = f'{{"pattern":"*","filter":{{"SUBJECT":{{"CN":"{cert_subject}"}}}}}}'

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            channel="msedge",
            headless=False,
            args=[
                f"--auto-select-certificate-for-urls={cert_policy}",
                "--ignore-certificate-errors",
            ],
        )
        context = await browser.new_context()
        page = await context.new_page()

        async def on_request(request):
            url = request.url
            method = request.method
            if any(skip in url for skip in [".js", ".css", ".png", ".svg", ".woff", ".ico", "webpack", "chunk", ".map", "fonts.", "clarity", "browser/idle"]):
                return
            if any(host in url for host in ["analysis-df.windows", "fabric.microsoft", "pbidedicated", "onelake"]):
                path = url.split("?")[0]
                for host in ["https://biazure-int-edog-redirect.analysis-df.windows.net",
                             "https://powerbi-df.analysis-df.windows.net",
                             "https://api.fabric.microsoft.com",
                             "https://pbilheedog.analysis-df.windows.net"]:
                    if path.startswith(host):
                        path = path[len(host):]
                        break
                # Capture request body for POST/PUT/PATCH
                post_data = None
                if method in ("POST", "PUT", "PATCH"):
                    with contextlib.suppress(Exception):
                        post_data = request.post_data[:500] if request.post_data else None
                captured.append({
                    "method": method,
                    "path": path,
                    "full_url": url[:250],
                    "post_data": post_data,
                    "timestamp": time.time(),
                })
                print(f"  [{method:>5}] {path[:120]}")

        page.on("request", on_request)

        # Login
        print("Navigating to Power BI portal for login...")
        with contextlib.suppress(Exception):
            await page.goto("https://powerbi-df.analysis-df.windows.net/", wait_until="domcontentloaded", timeout=60000)

        try:
            email = await page.wait_for_selector('input[type="email"], input[name="loginfmt"]', timeout=5000)
            if email:
                await email.fill(USERNAME)
                await page.keyboard.press("Enter")
                await asyncio.sleep(3)
        except Exception:
            pass

        try:
            yes = await page.wait_for_selector('#idSIButton9, input[value="Yes"]', timeout=5000)
            if yes:
                await yes.click()
                await asyncio.sleep(2)
        except Exception:
            pass

        print("Waiting for portal to load...")
        await asyncio.sleep(8)

        # Navigate to notebook
        print(f"\nNavigating to notebook: {NOTEBOOK_URL}")
        with contextlib.suppress(Exception):
            await page.goto(NOTEBOOK_URL, wait_until="domcontentloaded", timeout=60000)

        print("Waiting for notebook to load (20s)...")
        await asyncio.sleep(20)

        # Interact with notebook UI
        print("\nExploring notebook page...")

        # Try common notebook buttons/interactions
        interactions = [
            ("button:has-text('Run all')", "Run all button"),
            ("button:has-text('Run')", "Run button"),
            ("button:has-text('Stop')", "Stop button"),
            ("button:has-text('Publish')", "Publish button"),
            ("button:has-text('Schedule')", "Schedule button"),
            ("[aria-label*='cell']", "Cell element"),
            ("[aria-label*='Code']", "Code cell"),
            ("button:has-text('Properties')", "Properties"),
            ("[data-testid*='notebook']", "Notebook testid"),
            ("button:has-text('Share')", "Share button"),
            ("button:has-text('Git')", "Git integration"),
            ("button:has-text('Variables')", "Variables"),
            ("button:has-text('Resources')", "Resources"),
        ]

        for selector, label in interactions:
            try:
                el = await page.query_selector(selector)
                if el:
                    is_visible = await el.is_visible()
                    if is_visible:
                        print(f"  Found: {label} — clicking")
                        await el.click()
                        await asyncio.sleep(3)
                    else:
                        print(f"  Found but hidden: {label}")
            except Exception:
                pass

        # Wait for any lazy API calls
        await asyncio.sleep(5)

        # Also try right-clicking for context menu
        try:
            cells = await page.query_selector_all("[class*='cell'], [class*='Cell'], [role='textbox']")
            if cells:
                print(f"\n  Found {len(cells)} cell-like elements")
                # Click into first cell
                await cells[0].click()
                await asyncio.sleep(2)
        except Exception:
            pass

        await asyncio.sleep(3)
        await browser.close()

    # Deduplicate
    unique = {}
    for c in captured:
        generic = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "{guid}", c["path"])
        key = f"{c['method']} {generic}"
        if key not in unique:
            unique[key] = {"method": c["method"], "pattern": generic, "example": c["path"],
                          "post_data": c.get("post_data"), "count": 0}
        unique[key]["count"] += 1

    print("\n" + "=" * 100)
    print(f"CAPTURED {len(captured)} total calls, {len(unique)} unique patterns")
    print("=" * 100)

    # Group by category
    categories = {
        "Notebook/Item": [], "Metadata": [], "Capacity/Workspace": [],
        "Session/Compute": [], "OneLake": [], "Other": [],
    }
    for key in sorted(unique.keys()):
        ep = unique[key]
        line = f"  {ep['method']:>5} x{ep['count']:<3} | {ep['pattern'][:90]}"
        if ep.get("post_data"):
            line += f"\n              body: {ep['post_data'][:150]}"

        if any(kw in ep["pattern"] for kw in ["notebook", "item", "getDefinition", "updateDefinition", "artifact"]):
            categories["Notebook/Item"].append(line)
        elif any(kw in ep["pattern"] for kw in ["session", "spark", "livy", "compute", "kernel"]):
            categories["Session/Compute"].append(line)
        elif any(kw in ep["pattern"] for kw in ["onelake", "dfs"]):
            categories["OneLake"].append(line)
        elif "metadata" in ep["pattern"]:
            categories["Metadata"].append(line)
        elif any(kw in ep["pattern"] for kw in ["capacity", "workspace", "group"]):
            categories["Capacity/Workspace"].append(line)
        else:
            categories["Other"].append(line)

    for cat, lines in categories.items():
        if lines:
            print(f"\n--- {cat} ({len(lines)}) ---")
            for line in lines:
                print(line)

    # Save
    out = PROJECT_DIR / "docs" / "notebook-editor-network-calls.json"
    out.write_text(json.dumps({"raw": captured, "unique": list(unique.values())}, indent=2, default=str))
    print(f"\nSaved to: {out}")


if __name__ == "__main__":
    asyncio.run(main())

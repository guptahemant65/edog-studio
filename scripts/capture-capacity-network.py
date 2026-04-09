"""Capture all network calls from the Power BI Admin Capacity Management portal.

Uses Playwright (same as edog.py auth) to:
1. Navigate to the capacity management page
2. Capture all API calls (URLs, methods, response codes)
3. Save unique API endpoints for documentation

Run: python scripts/capture-capacity-network.py
"""
import asyncio
import json
import re
import time
from pathlib import Path

USERNAME = "Admin1CBA@FabricFMLV08PPE.ccsctp.net"
PORTAL_URL = "https://powerbi-df.analysis-df.windows.net/admin-portal/manageCapacities/gridView?experience=power-bi"

PROJECT_DIR = Path(__file__).parent.parent
captured_calls = []


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

        # Capture ALL network requests
        async def on_request(request):
            url = request.url
            method = request.method
            # Filter to API calls only (skip static assets, fonts, etc.)
            if any(skip in url for skip in [".js", ".css", ".png", ".svg", ".woff", ".ico", "webpack", "chunk"]):
                return
            if "analysis-df.windows" in url or "fabric.microsoft.com" in url or "pbidedicated" in url:
                # Parse just the path
                path = url.split("?")[0]
                # Remove the host
                for host in ["https://biazure-int-edog-redirect.analysis-df.windows.net",
                             "https://powerbi-df.analysis-df.windows.net",
                             "https://api.fabric.microsoft.com"]:
                    if path.startswith(host):
                        path = path[len(host):]
                        break
                captured_calls.append({
                    "method": method,
                    "path": path,
                    "full_url": url[:200],
                    "timestamp": time.time(),
                })
                print(f"  [{method:>4}] {path[:100]}")

        async def on_response(response):
            url = response.url
            if any(skip in url for skip in [".js", ".css", ".png", ".svg", ".woff", ".ico"]):
                return
            if "analysis-df.windows" in url or "fabric.microsoft.com" in url:
                status = response.status
                path = url.split("?")[0]
                for host in ["https://biazure-int-edog-redirect.analysis-df.windows.net",
                             "https://powerbi-df.analysis-df.windows.net"]:
                    if path.startswith(host):
                        path = path[len(host):]
                        break
                # Update the captured call with status
                for call in reversed(captured_calls):
                    if call["path"] == path:
                        call["status"] = status
                        break

        page.on("request", on_request)
        page.on("response", on_response)

        # Login flow
        print("Navigating to Power BI portal...")
        try:
            await page.goto("https://powerbi-df.analysis-df.windows.net/", wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass

        print("Handling login...")
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

        # Wait for portal to load
        print("Waiting for portal to load...")
        await asyncio.sleep(8)

        # Navigate to capacity management
        print(f"\nNavigating to: {PORTAL_URL}")
        try:
            await page.goto(PORTAL_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass

        print("Waiting for capacity page to load (15s)...")
        await asyncio.sleep(15)

        # Try clicking around to trigger more API calls
        print("\nExploring capacity page interactions...")

        # Look for capacity rows and click them
        try:
            rows = await page.query_selector_all("tr, [role='row'], .capacity-row, [data-testid]")
            print(f"Found {len(rows)} potential rows/elements")
            if len(rows) > 2:
                await rows[1].click()  # Click first capacity row (skip header)
                await asyncio.sleep(5)
        except Exception as e:
            print(f"  Row click: {e}")

        # Look for common admin buttons
        for selector in ["button:has-text('Settings')", "button:has-text('Notifications')",
                         "button:has-text('Refresh')", "[aria-label*='capacity']",
                         "button:has-text('View')", "button:has-text('Details')"]:
            try:
                btn = await page.query_selector(selector)
                if btn:
                    print(f"  Clicking: {selector}")
                    await btn.click()
                    await asyncio.sleep(3)
            except Exception:
                pass

        # Wait a bit more for any lazy-loaded calls
        await asyncio.sleep(5)

        await browser.close()

    # Deduplicate and summarize
    unique_paths = {}
    for call in captured_calls:
        key = f"{call['method']} {call['path']}"
        # Generalize GUIDs in paths
        generic_path = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "{guid}", call["path"])
        generic_key = f"{call['method']} {generic_path}"
        if generic_key not in unique_paths:
            unique_paths[generic_key] = {
                "method": call["method"],
                "pattern": generic_path,
                "example": call["path"],
                "status": call.get("status", "?"),
                "count": 0,
            }
        unique_paths[generic_key]["count"] += 1

    print("\n" + "=" * 100)
    print(f"CAPTURED {len(captured_calls)} total calls, {len(unique_paths)} unique patterns")
    print("=" * 100)

    for key in sorted(unique_paths.keys()):
        ep = unique_paths[key]
        print(f"  {ep['method']:>4} {ep['status']:>3} x{ep['count']:<3} | {ep['pattern'][:80]}")

    # Save results
    out = PROJECT_DIR / "docs" / "capacity-portal-network-calls.json"
    out.write_text(json.dumps({
        "raw_calls": captured_calls,
        "unique_patterns": list(unique_paths.values()),
    }, indent=2, default=str))
    print(f"\nSaved to: {out}")


if __name__ == "__main__":
    asyncio.run(main())

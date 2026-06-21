"""Make stdout/stderr safe for the skill's Unicode TUI on every platform.

The renderer (`qa_render`) emits Unicode marks (◆ ▸ ✓ ▲ ▣ ◌). Windows' default
console is cp1252 and raises ``UnicodeEncodeError`` on them, so any script that
prints rendered output must use UTF-8. ``ensure_utf8`` reconfigures the streams
to UTF-8 — idempotent, a no-op where already UTF-8, and never raises (so it is
safe to call unconditionally at import or at the top of a CLI ``main``).
"""

from __future__ import annotations

import contextlib
import sys


def ensure_utf8() -> None:
    """Reconfigure stdout/stderr to UTF-8 so Unicode TUI output never crashes."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # e.g. a non-TextIO stream
            continue
        enc = (getattr(stream, "encoding", "") or "").lower()
        if enc in ("utf-8", "utf8"):
            continue
        with contextlib.suppress(ValueError, OSError):  # already detached / not reconfigurable
            reconfigure(encoding="utf-8")

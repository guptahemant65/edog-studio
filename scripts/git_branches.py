"""Pure git operations for the FLT branch switcher.

No HTTP, no studio state. Every git call is best-effort with a timeout and
never raises. The HTTP layer (dev-server.py) owns the phase guard and config
resolution; this module owns the git mechanics.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

# Phases during which the working tree is bound to a running/deploying FLT
# build. Switching the branch under it would make the displayed branch lie
# about what is executing, so we refuse.
LOCKED_PHASES = frozenset({"deploying", "running"})
# Phases where switching is safe (pre-deploy or torn down).
ALLOWED_PHASES = frozenset({"idle", "stopped", "crashed"})


def phase_allows_switch(phase: str | None) -> bool:
    """True only for explicitly-allowed pre-deploy phases. Fails closed."""
    return phase in ALLOWED_PHASES

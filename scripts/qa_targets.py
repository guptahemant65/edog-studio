"""Enriched Fabric target menu + locked-target record.

Risk drives posture: a 'safe' empty lakehouse = full freedom; 'prod_like' or a
has-data lakehouse is gated. The locked tuple stores GUIDs
(workspaceId/lakehouseId/capacityId), NEVER display names -- FLT's name-based
resolution fallback can silently resolve the wrong lakehouse, so addressability
is checked by GUID only.
"""

from __future__ import annotations

_PROD = ("prod", "live", "mirror")


def _risk(name: str, has_data: bool) -> str:
    if any(h in name.lower() for h in _PROD):
        return "prod_like"
    return "has_data" if has_data else "safe"


def build_menu(raw: dict, *, fetch_lakehouses=None) -> list[dict]:
    """Build the target menu from the workspaces response.

    ``/api/fabric/workspaces`` returns workspaces WITHOUT inline lakehouses, so
    pass ``fetch_lakehouses(workspace_id) -> {"value": [...]}`` (a call to
    ``/api/fabric/workspaces/{id}/lakehouses``) to enrich each one. When a
    workspace already carries an inline ``lakehouses`` list it is used as-is.
    """
    out = []
    for ws in raw.get("value", []):
        lakehouses = ws.get("lakehouses")
        if lakehouses is None and fetch_lakehouses is not None:
            try:
                lakehouses = (fetch_lakehouses(ws["id"]) or {}).get("value", [])
            except Exception:
                lakehouses = []
        for lh in lakehouses or []:
            out.append(
                {
                    "workspace": ws["displayName"],
                    "workspaceId": ws["id"],
                    "lakehouse": lh["displayName"],
                    "lakehouseId": lh["id"],
                    "sku": ws.get("capacitySku", ""),
                    "hasData": bool(lh.get("hasData")),
                    "risk": _risk(ws["displayName"], bool(lh.get("hasData"))),
                }
            )
    return out


def lock_target(*, workspace: str, lakehouse: str, capacity: str, created: bool) -> dict:
    # workspace/lakehouse/capacity MUST be GUIDs (workspaceId/lakehouseId from
    # build_menu), never display names -- name-based resolution can mis-target.
    return {"workspace": workspace, "lakehouse": lakehouse, "capacity": capacity, "created": created}


def is_addressable(locked: dict, workspace: str, lakehouse: str) -> bool:
    return locked["workspace"] == workspace and locked["lakehouse"] == lakehouse

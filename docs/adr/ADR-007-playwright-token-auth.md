# ADR-007: Playwright + Aggressive Caching for Token Acquisition

## Status: ACCEPTED (2026-04-09)

## Context
EDOG Playground needs bearer tokens (PBI audience: `analysis.windows-int.net/powerbi/api`)
for `Admin1CBA@FabricFMLV08PPE.ccsctp.net`. The user cert is a CBA (Certificate-Based
Authentication) cert — it authenticates via browser TLS client certificate negotiation.

## Options Evaluated

| Approach | Result | Reason |
|---|---|---|
| MSAL ConfidentialClient (C#) | FAIL | Cert not registered on any app registration |
| MSAL ConfidentialClient (Python) | FAIL | Private key non-exportable (CNG key store) |
| MSAL WAM Broker (pymsalruntime) | FAIL | PPE authority not supported by WAM |
| Key Vault cert (ppe-ephemeral-admin-kv) | FAIL | Same cert/thumbprint — it's a user CBA cert |
| Device Code Flow | FAIL | Still needs browser for code entry |
| Playwright + auto-select-certificate | WORKS | Browser handles TLS CBA natively |

## Decision
**Keep Playwright for authentication, optimize for speed and invisibility.**

## Implementation

### First-Time Auth (visible, ~5 seconds)
1. Launch Edge with `--auto-select-certificate-for-urls` matching cert CN
2. Navigate to Power BI PPE
3. pywinauto auto-selects cert if dialog appears
4. Capture bearer from first `Authorization: Bearer ey*` request header
5. Auto-close browser window immediately after capture

### Subsequent Auth (invisible, <1 second)
1. Check `.edog-bearer-cache` file (base64-encoded token + expiry)
2. If token valid for >10 minutes: use cached token (no browser)
3. If expired: launch Playwright headless attempt first, fall back to visible

### Token Lifecycle
- Bearer token TTL: ~60 minutes
- Cache location: `.edog-bearer-cache` (disk, survives restarts)
- Auto-refresh: 10 minutes before expiry
- Re-auth notification: "Token expiring — refreshing..." toast in UI

### Optimization Details
- `--auto-select-certificate-for-urls={"pattern":"*","filter":{"SUBJECT":{"CN":"..."}}}`
- `--ignore-certificate-errors` for PPE self-signed certs
- pywinauto background thread for Windows Security dialog (auto-clicks matching cert)
- Browser closes immediately after token capture (no lingering windows)
- Retry: 3 attempts with 5-second delays

## Key Discovery
The FabricSparkCST repo (tenants.json) stores the Edog app registration:
- ClientId: `24d73e6d-ee5d-4924-8fbf-f0ee10667199`
- TenantId: `a0bbeea9-41a0-40b2-b21e-6df95f51e86f`
- AuthClientId: `ea0616ba-638b-4df5-95b9-636659ae5121`

These apps have KEY VAULT certs registered (not local CBA certs).
If we ever get a cert registered on an app, we can switch to pure MSAL.
The Key Vault is `ppe-ephemeral-admin-kv`, cert name `Admin1CBA-FabricFMLV08PPE-Cert`.

## Consequences
- First auth per session: ~5 second visible browser flash
- Subsequent auths: invisible (<1 second from cache)
- Depends on Playwright + pywinauto packages
- Works for any CBA user, any PPE tenant (configurable)
- Future: if cert is registered on app → switch to pure MSAL (zero browser)

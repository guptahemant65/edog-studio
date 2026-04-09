# ADR-007: Silent CBA for Fully Automated Token Acquisition

## Status: ACCEPTED (2026-04-09) — UPGRADED from Playwright to Silent CBA

## Context
EDOG Playground needs bearer tokens (PBI audience: `analysis.windows-int.net/powerbi/api`)
for `Admin1CBA@FabricFMLV08PPE.ccsctp.net`. The user cert is a CBA (Certificate-Based
Authentication) cert stored in the Windows cert store with a non-exportable private key.

## Options Evaluated (Exhaustive)

| Approach | Result | Reason |
|---|---|---|
| MSAL ConfidentialClient (C#) | FAIL | Cert not registered on any app registration |
| MSAL ConfidentialClient (Python) | FAIL | Private key non-exportable (CNG key store) |
| MSAL WAM Broker (pymsalruntime) | FAIL | PPE authority not supported by WAM |
| Key Vault cert + Playwright clientCertificates | FAIL | "No certificate detected" — PPE rejects non-enrolled certs |
| Playwright headless + auto-select flag | FAIL | No TLS cert negotiation in headless |
| pywinauto cert dialog automation | FAIL | OS crypto dialog invisible to UI automation |
| Playwright visible + manual cert click | WORKS | But requires user interaction |
| Device Code Flow | FAIL | Still needs browser for code entry |
| **Silent CBA (TestOnlySilentCBA)** | **WORKS** | **Zero browser, zero dialog, ~5 seconds** |

## Decision
**Silent CBA via `Microsoft.Identity.Client.TestOnlySilentCBA` NuGet package.**

This is the same mechanism used by FabricSparkCST CI/CD pipelines. It performs
a 3-phase HTTP flow that replaces the browser entirely:

1. `GET /authorize` → Extract login context (ctx, flowToken)
2. `POST /GetCredentialType` → Get CertAuthUrl → `POST` with TLS mutual auth → certificatetoken
3. `POST /login` → Exchange for auth code → MSAL converts to bearer token

The certificate is presented at the TLS layer via `HttpClientHandler.ClientCertificates`,
which supports non-exportable CNG keys from the Windows cert store.

## Implementation
- C# helper: `scripts/token-helper/Program.cs` (93 lines)
- NuGet: `Microsoft.Identity.Client.TestOnlySilentCBA` v0.10.6
- NuGet: `Microsoft.Identity.Client` v4.73.0
- Target: .NET Framework 4.7.2
- Python calls via `subprocess.run([token-helper.exe, thumbprint, username])`
- Token output to stdout, errors to stderr

## Auth Config (from FabricSparkCST app.config)
- ClientId: `ea0616ba-638b-4df5-95b9-636659ae5121`
- Authority: `https://login.windows-ppe.net/organizations`
- Resource: `https://analysis.windows-int.net/powerbi/api`
- RedirectUri: `https://login.microsoftonline.com/common/oauth2/nativeclient`

## Performance
- Fresh token (Silent CBA): ~5-7 seconds
- Cached token (disk): ~30ms
- Token TTL: ~60 minutes
- Cache: `.edog-bearer-cache` file (base64-encoded timestamp|token)

## Consequences
- Playwright and pywinauto dependencies REMOVED
- Requires .NET Framework 4.7.2 runtime (pre-installed on Windows dev machines)
- First `dotnet build` of token-helper takes ~5s (cached after that)
- Works for any CBA user cert in the Windows cert store
- Note: `TestOnlySilentCBA` is deprecated in favor of User FIC via MISE 1.35+
  (upgrade path documented, current package works fine for PPE)

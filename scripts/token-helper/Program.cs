using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Extensibility;
using Microsoft.IdentityModel.Abstractions;

/// <summary>
/// Acquires a user-delegated bearer token via Silent CBA (Certificate-Based Auth).
/// Uses the same mechanism as FabricSparkCST CI/CD — zero browser interaction.
///
/// Usage: token-helper.exe &lt;thumbprint&gt; &lt;username&gt; [clientId] [authority] [resource] [redirectUri]
/// Outputs the bearer token to stdout (for Python to capture via subprocess).
/// </summary>
class Program
{
    // Defaults from FabricSparkCST app.config "edog" section
    const string DefaultClientId = "ea0616ba-638b-4df5-95b9-636659ae5121";
    const string DefaultAuthority = "https://login.windows-ppe.net/organizations";
    const string DefaultResource = "https://analysis.windows-int.net/powerbi/api";
    const string DefaultRedirectUri = "https://login.microsoftonline.com/common/oauth2/nativeclient";

    static async Task Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--list-certs")
        {
            using var store = new X509Store(StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly);
            var certs = new System.Collections.Generic.List<object>();
            foreach (var c in store.Certificates)
            {
                if (c.Subject.Contains("CBA"))
                {
                    certs.Add(new
                    {
                        thumbprint = c.Thumbprint,
                        subject = c.Subject,
                        cn = c.GetNameInfo(X509NameType.SimpleName, false),
                        notAfter = c.NotAfter.ToString("o"),
                        notBefore = c.NotBefore.ToString("o"),
                    });
                }
            }
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(certs));
            return;
        }

        if (args.Length < 2)
        {
            Console.Error.WriteLine("Usage: token-helper <thumbprint> <username> [clientId] [authority] [resource] [redirectUri]");
            Console.Error.WriteLine("       token-helper --list-certs");
            Console.Error.WriteLine("Example: token-helper 6921EC59... Admin1CBA@FabricFMLV08PPE.ccsctp.net");
            Environment.Exit(1);
        }

        string thumbprint = args[0];
        string username = args[1];
        string clientId = args.Length > 2 ? args[2] : DefaultClientId;
        string authority = args.Length > 3 ? args[3] : DefaultAuthority;
        string resource = args.Length > 4 ? args[4] : DefaultResource;
        string redirectUri = args.Length > 5 ? args[5] : DefaultRedirectUri;

        // Load certificate from Windows cert store (supports non-exportable CNG keys)
        X509Certificate2 cert = null;
        using (var store = new X509Store(StoreLocation.CurrentUser))
        {
            store.Open(OpenFlags.ReadOnly);
            var certs = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false);
            if (certs.Count == 0)
            {
                Console.Error.WriteLine($"ERROR: Certificate with thumbprint {thumbprint} not found");
                Environment.Exit(1);
            }
            cert = certs[0];
        }
        Console.Error.WriteLine($"Cert: {cert.Subject}");

        // Build MSAL Public Client with our robust CBA implementation
        string[] scopes = new[] { resource + "/.default" };

        var app = PublicClientApplicationBuilder
            .Create(clientId)
            .WithAuthority(authority)
            .WithRedirectUri(redirectUri)
            .Build();

        try
        {
            // RobustSilentCba reimplements the 3-phase CBA flow with robust HTML parsing
            // that handles PPE login page format changes (fixes "Index out of range" crash)
            var cbaFlow = new RobustSilentCba(authority, username, cert);
            var result = await app
                .AcquireTokenInteractive(scopes)
                .WithLoginHint(username)
                .WithCustomWebUi(cbaFlow)
                .ExecuteAsync();

            Console.WriteLine(result.AccessToken);
            Console.Error.WriteLine($"Token: {result.AccessToken.Length} chars, expires: {result.ExpiresOn}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR: {ex.Message}");
            if (ex.InnerException != null)
                Console.Error.WriteLine($"Inner: {ex.InnerException.Message}");
            Environment.Exit(1);
        }
    }
}

/// <summary>
/// Robust reimplementation of the 3-phase Silent CBA flow.
/// Replaces TestOnlySilentCBA.SilentCbaWebUI which crashes when PPE login page changes.
/// Uses regex-based HTML parsing instead of brittle IndexOf($Config=).
/// </summary>
class RobustSilentCba : ICustomWebUi
{
    private readonly string _authority;
    private readonly string _username;
    private readonly X509Certificate2 _cert;

    public RobustSilentCba(string authority, string username, X509Certificate2 cert)
    {
        _authority = authority;
        _username = username;
        _cert = cert;
    }

    public async Task<Uri> AcquireAuthorizationCodeAsync(Uri authorizationUri, Uri redirectUri, CancellationToken ct)
    {
        using var handler = new HttpClientHandler { AllowAutoRedirect = false };
        using var http = new HttpClient(handler);
        http.DefaultRequestHeaders.Add("User-Agent", "EDOG-TokenHelper/2.0");

        string authorityBase = GetAuthorityBase(authorizationUri);

        // Phase 1: GET /authorize → extract $Config JSON with sCtx, sFT
        Console.Error.WriteLine("  Phase 1: GET authorize...");
        var loginHtml = await http.GetStringAsync(authorizationUri);
        var config = ParseConfig(loginHtml);

        if (!config.ContainsKey("sCtx") || !config.ContainsKey("sFT"))
            throw new Exception($"Login page missing sCtx/sFT. Keys found: {string.Join(", ", config.Keys)}");

        string ctx = config["sCtx"];
        string flowToken = config["sFT"];
        string country = config.ContainsKey("country") ? config["country"] : null;
        Console.Error.WriteLine($"  Phase 1: OK — got sCtx ({ctx.Length} chars) + sFT");

        // Phase 2: POST /GetCredentialType → get CertAuthUrl
        Console.Error.WriteLine("  Phase 2: POST GetCredentialType...");
        var credBody = JsonSerializer.Serialize(new
        {
            flowToken,
            originalRequest = ctx,
            country,
            isSignup = "false",
            checkPhones = "false",
            sc = "GetCredentialType",
            username = _username
        });
        var credResp = await http.PostAsync(
            authorityBase + "GetCredentialType?mkt=en-US",
            new StringContent(credBody, Encoding.UTF8, "application/json"));
        var credJson = JsonDocument.Parse(await credResp.Content.ReadAsStringAsync());

        string certAuthUrl = credJson.RootElement
            .GetProperty("Credentials")
            .GetProperty("CertAuthParams")
            .GetProperty("CertAuthUrl")
            .GetString();

        if (string.IsNullOrEmpty(certAuthUrl))
            throw new Exception("CertAuthUrl not found in GetCredentialType response");

        string newFlowToken = credJson.RootElement.GetProperty("FlowToken").GetString() ?? flowToken;
        Console.Error.WriteLine($"  Phase 2: OK — CertAuthUrl: {certAuthUrl.Substring(0, Math.Min(60, certAuthUrl.Length))}...");

        // Phase 3a: POST CertAuthUrl with TLS client cert → get certificatetoken
        Console.Error.WriteLine("  Phase 3a: POST CertAuth (TLS mutual auth)...");
        using var certHandler = new HttpClientHandler
        {
            ClientCertificateOptions = ClientCertificateOption.Manual,
            UseDefaultCredentials = true
        };
        certHandler.ClientCertificates.Add(_cert);
        using var certHttp = new HttpClient(certHandler);

        var certFormData = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("ctx", ctx),
            new KeyValuePair<string, string>("flowToken", newFlowToken),
        });
        var certResp = await certHttp.PostAsync(certAuthUrl, certFormData);
        var certHtml = await certResp.Content.ReadAsStringAsync();

        var hiddenFields = ParseHiddenFields(certHtml);
        if (!hiddenFields.ContainsKey("certificatetoken"))
            throw new Exception($"certificatetoken not found. Fields: {string.Join(", ", hiddenFields.Keys)}");

        string certificateToken = hiddenFields["certificatetoken"];
        string certCtx = hiddenFields.ContainsKey("ctx") ? hiddenFields["ctx"] : ctx;
        string certFlowToken = hiddenFields.ContainsKey("flowtoken") ? hiddenFields["flowtoken"] : newFlowToken;
        Console.Error.WriteLine($"  Phase 3a: OK — certificatetoken ({certificateToken.Length} chars)");

        // Phase 3b: POST /login → 302 redirect with auth code
        Console.Error.WriteLine("  Phase 3b: POST login...");
        var loginFormData = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("ctx", certCtx),
            new KeyValuePair<string, string>("flowtoken", certFlowToken),
            new KeyValuePair<string, string>("certificatetoken", certificateToken),
        });
        var loginResp = await http.PostAsync(authorityBase + "login", loginFormData);
        Console.Error.WriteLine($"  Phase 3b: {loginResp.StatusCode}");

        if (loginResp.StatusCode == HttpStatusCode.Found)
        {
            var location = loginResp.Headers.Location;
            Console.Error.WriteLine($"  Redirect: {location}");

            // The redirect URL already contains code + state in fragment or query
            // MSAL needs the full URL to validate state — pass it through as-is
            string raw = location.ToString();

            // If code is in fragment (#code=...), convert to query (?code=...) for MSAL
            if (raw.Contains("#code="))
            {
                raw = raw.Replace("#", "?");
            }

            // Ensure it starts with the expected redirect URI base
            if (!raw.StartsWith(redirectUri.ToString(), StringComparison.OrdinalIgnoreCase))
            {
                // Rewrite to use the expected redirectUri but keep all params
                string paramsStr = "";
                int qIdx = raw.IndexOf('?');
                int fIdx = raw.IndexOf('#');
                int paramStart = qIdx >= 0 ? qIdx : fIdx;
                if (paramStart >= 0)
                    paramsStr = raw.Substring(paramStart);
                raw = redirectUri.ToString().TrimEnd('/') + paramsStr;
            }

            return new Uri(raw);
        }

        var loginBody = await loginResp.Content.ReadAsStringAsync();
        var loginConfig = ParseConfig(loginBody);
        if (loginConfig.ContainsKey("strServiceExceptionMessage"))
            throw new Exception("Login failed: " + loginConfig["strServiceExceptionMessage"]);

        throw new Exception($"Login returned {loginResp.StatusCode} instead of redirect.");
    }

    private static string GetAuthorityBase(Uri authUri)
    {
        return $"{authUri.Scheme}://{authUri.Authority}/{authUri.Segments[1]}";
    }

    /// <summary>
    /// Robust parser for $Config JSON in PPE login page HTML.
    /// Tries multiple patterns to handle format changes.
    /// </summary>
    private static Dictionary<string, string> ParseConfig(string html)
    {
        var result = new Dictionary<string, string>();
        string jsonStr = null;

        // Try multiple start/end patterns
        string[] startPatterns = { "$Config=", "var $Config=", "Config=" };
        string[] endPatterns = { ";\n", ";\r\n", ";//", "};" };

        foreach (var startPat in startPatterns)
        {
            int startIdx = html.IndexOf(startPat, StringComparison.OrdinalIgnoreCase);
            if (startIdx < 0) continue;
            startIdx += startPat.Length;

            // Find matching closing brace if we start with {
            if (startIdx < html.Length && html[startIdx] == '{')
            {
                int depth = 0;
                for (int i = startIdx; i < html.Length; i++)
                {
                    if (html[i] == '{') depth++;
                    else if (html[i] == '}') { depth--; if (depth == 0) { jsonStr = html.Substring(startIdx, i - startIdx + 1); break; } }
                }
            }
            else
            {
                foreach (var endPat in endPatterns)
                {
                    int endIdx = html.IndexOf(endPat, startIdx, StringComparison.OrdinalIgnoreCase);
                    if (endIdx > startIdx) { jsonStr = html.Substring(startIdx, endIdx - startIdx); break; }
                }
            }
            if (jsonStr != null) break;
        }

        // Fallback regex
        if (jsonStr == null)
        {
            var match = Regex.Match(html, @"\bConfig\s*=\s*(\{[\s\S]*?\});", RegexOptions.IgnoreCase);
            if (match.Success) jsonStr = match.Groups[1].Value;
        }

        if (jsonStr == null) return result;

        try
        {
            using var doc = JsonDocument.Parse(jsonStr);
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                if (prop.Value.ValueKind == JsonValueKind.String)
                    result[prop.Name] = prop.Value.GetString();
                else if (prop.Value.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                    result[prop.Name] = prop.Value.GetRawText();
            }
        }
        catch (JsonException ex)
        {
            Console.Error.WriteLine($"  WARNING: Config parse error: {ex.Message}");
        }
        return result;
    }

    private static Dictionary<string, string> ParseHiddenFields(string html)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in Regex.Matches(html, @"<input[^>]+type=[""']hidden[""'][^>]*>", RegexOptions.IgnoreCase))
        {
            var nameMatch = Regex.Match(m.Value, @"name=[""']([^""']+)[""']", RegexOptions.IgnoreCase);
            var valueMatch = Regex.Match(m.Value, @"value=[""']([^""']*)[""']", RegexOptions.IgnoreCase);
            if (nameMatch.Success && valueMatch.Success)
                result[nameMatch.Groups[1].Value] = WebUtility.HtmlDecode(valueMatch.Groups[1].Value);
        }
        return result;
    }
}

class NullIdentityLogger : IIdentityLogger
{
    public bool IsEnabled(EventLogLevel eventLogLevel) => false;
    public void Log(LogEntry entry) { }
}

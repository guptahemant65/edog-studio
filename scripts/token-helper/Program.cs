using System;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Tasks;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Extensibility;
using Microsoft.Identity.Client.TestOnlySilentCBA;
using Microsoft.IdentityModel.Abstractions;

/// <summary>
/// Acquires a user-delegated bearer token via Silent CBA (Certificate-Based Auth).
/// Uses the same mechanism as FabricSparkCST CI/CD — zero browser interaction.
///
/// Usage: token-helper.exe &lt;thumbprint&gt; &lt;username&gt; [clientId] [authority] [resource]
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
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Usage: token-helper <thumbprint> <username> [clientId] [authority] [resource]");
            Console.Error.WriteLine("Example: token-helper 6921EC59... Admin1CBA@FabricFMLV08PPE.ccsctp.net");
            Environment.Exit(1);
        }

        string thumbprint = args[0];
        string username = args[1];
        string clientId = args.Length > 2 ? args[2] : DefaultClientId;
        string authority = args.Length > 3 ? args[3] : DefaultAuthority;
        string resource = args.Length > 4 ? args[4] : DefaultResource;

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

        // Build MSAL Public Client with Silent CBA custom web UI
        string[] scopes = new[] { resource + "/.default" };

        var app = PublicClientApplicationBuilder
            .Create(clientId)
            .WithAuthority(authority)
            .WithRedirectUri(DefaultRedirectUri)
            .Build();

        try
        {
            // SilentCbaWebUI performs the 3-phase CBA flow:
            // 1. GET /authorize → extract ctx + flowToken
            // 2. POST /GetCredentialType → get CertAuthUrl → POST with TLS cert → certificatetoken
            // 3. POST /login → 302 redirect with auth code → MSAL exchanges for token
            var result = await app
                .AcquireTokenInteractive(scopes)
                .WithLoginHint(username)
                .WithCustomWebUi(new SilentCbaWebUI(username, cert, new NullIdentityLogger()))
                .ExecuteAsync();

            // Output ONLY the token to stdout (Python captures this)
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

class NullIdentityLogger : IIdentityLogger
{
    public bool IsEnabled(EventLogLevel eventLogLevel) => false;
    public void Log(LogEntry entry) { }
}

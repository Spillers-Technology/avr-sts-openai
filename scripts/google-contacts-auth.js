const crypto = require("crypto");
const http = require("http");

const clientId = process.env.GOOGLE_CONTACTS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CONTACTS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_CONTACTS_CLIENT_ID and GOOGLE_CONTACTS_CLIENT_SECRET for a Google OAuth Desktop client first."
  );
  process.exit(1);
}

const port = Number(process.env.GOOGLE_CONTACTS_AUTH_PORT || 53682);
const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const state = crypto.randomBytes(24).toString("hex");
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorize.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/contacts.readonly",
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
});

const server = http.createServer(async (req, res) => {
  const callback = new URL(req.url, redirectUri);
  if (callback.pathname !== "/oauth2/callback") {
    res.writeHead(404).end();
    return;
  }
  if (callback.searchParams.get("state") !== state) {
    res.writeHead(400).end("OAuth state mismatch.");
    return;
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`Google authorization failed: ${callback.searchParams.get("error") || "missing code"}`);
    server.close();
    return;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.refresh_token) {
      throw new Error(data.error_description || data.error || "Google did not return a refresh token");
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Google Contacts read-only authorization complete. You can close this tab.");
    console.log("\nAuthorization complete. Store these three values in the avr-secrets SOPS secret:\n");
    console.log(`GOOGLE_CONTACTS_CLIENT_ID=${clientId}`);
    console.log(`GOOGLE_CONTACTS_CLIENT_SECRET=${clientSecret}`);
    console.log(`GOOGLE_CONTACTS_REFRESH_TOKEN=${data.refresh_token}`);
  } catch (error) {
    res.writeHead(500).end("Token exchange failed. Check the terminal.");
    console.error(`Token exchange failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve read-only Contacts access:\n");
  console.log(authorize.toString());
  console.log(`\nWaiting for Google's callback on ${redirectUri} ...`);
});

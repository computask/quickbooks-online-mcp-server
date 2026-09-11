import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "./env";
import {
  exchangeIntuitCode,
  getCompanyInfoWithToken,
  saveInitialTokenState,
  QboError,
} from "./qbo";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
const app = new Hono<{ Bindings: AuthEnv }>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function redirectUri(request: Request, env: AuthEnv): string {
  return env.QUICKBOOKS_REDIRECT_URI || `${new URL(request.url).origin}/callback`;
}

app.get("/authorize", async (c) => {
  const oauthReqInfo: AuthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) return c.text("Invalid client_id", 400);
  if (!c.env.QUICKBOOKS_CLIENT_ID) return c.text("QBO OAuth is not configured", 503);

  const state = crypto.randomUUID();
  await c.env.OAUTH_KV.put(
    `intuit:state:${state}`,
    JSON.stringify({ oauthReqInfo, createdAt: Date.now() }),
    { expirationTtl: 600 },
  );
  const uri = new URL("https://appcenter.intuit.com/connect/oauth2");
  uri.search = new URLSearchParams({
    client_id: c.env.QUICKBOOKS_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirectUri(c.req.raw, c.env),
    state,
  }).toString();
  return c.redirect(uri.toString(), 302);
});

app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const realmId = c.req.query("realmId");
  if (!code || !state || !realmId) return c.text("Incomplete QuickBooks authorization", 400);

  const saved = await c.env.OAUTH_KV.get(`intuit:state:${state}`, "json") as
    | { oauthReqInfo?: AuthRequest }
    | null;
  if (!saved?.oauthReqInfo) return c.text("Authorization expired", 400);
  await c.env.OAUTH_KV.delete(`intuit:state:${state}`);

  try {
    const tokens = await exchangeIntuitCode(c.env, code, redirectUri(c.req.raw, c.env));
    const company = await getCompanyInfoWithToken(c.env, realmId, tokens.accessToken);
    const companyName = String(company.CompanyName || "");
    if (companyName.trim().toLowerCase() !== c.env.EXPECTED_COMPANY_NAME.trim().toLowerCase()) {
      return c.text("The authorized QuickBooks company is not the configured company", 403);
    }
    await saveInitialTokenState(c.env, {
      realmId,
      companyName,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    });
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: saved.oauthReqInfo,
      userId: `qbo:${realmId}`,
      metadata: { label: companyName, clientName: "QBO Invoice MCP" },
      scope: saved.oauthReqInfo.scope,
      props: { realmId, companyName },
    });
    return c.redirect(redirectTo, 302);
  } catch (error) {
    const code = error instanceof QboError ? error.code : "qbo_authorization_failed";
    return new Response(code, { status: error instanceof QboError ? error.status : 502 });
  }
});

app.get("/", (c) => c.html(`<!doctype html><meta charset="utf-8"><title>QBO Invoice MCP</title><h1>QBO Invoice MCP</h1><p>OAuth-protected QuickBooks invoice tools are available at <code>/mcp</code>.</p><p>Only ${escapeHtml(c.env.EXPECTED_COMPANY_NAME)} is accepted.</p>`));

export { app as AuthHandler };

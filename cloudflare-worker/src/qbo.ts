import type { Env } from "./env";

export type QboInvoice = {
  Id?: string;
  SyncToken?: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  EmailStatus?: string;
  TxnStatus?: string;
  CustomerRef?: { value?: string; name?: string };
  BillEmail?: { Address?: string };
  [key: string]: unknown;
};

type TokenState = {
  realmId: string;
  companyName: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
};

export class QboError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 502) {
    super(code);
    this.name = "QboError";
    this.code = code;
    this.status = status;
  }
}

function apiBase(environment: string): string {
  return environment === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
    : "https://quickbooks.api.intuit.com/v3/company";
}

function tokenKey(realmId: string): string {
  return `qbo:token:${realmId}`;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

async function readState(env: Env, realmId: string): Promise<TokenState | undefined> {
  const value = await env.QBO_TOKEN_KV.get(tokenKey(realmId), "json");
  return value && typeof value === "object" ? (value as TokenState) : undefined;
}

async function refreshToken(env: Env, realmId: string, state: TokenState): Promise<TokenState> {
  const clientId = env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new QboError("qbo_oauth_not_configured", 503);

  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
    }),
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new QboError("qbo_reauthorization_required", 401);
    }
    throw new QboError("qbo_token_refresh_failed", 502);
  }

  const token = (await response.json()) as TokenResponse;
  if (!token.access_token) throw new QboError("qbo_token_response_invalid", 502);

  const next: TokenState = {
    ...state,
    refreshToken: token.refresh_token || state.refreshToken,
    accessToken: token.access_token,
    accessTokenExpiresAt: Date.now() + Math.max(60, token.expires_in || 3600) * 1000,
  };
  await env.QBO_TOKEN_KV.put(tokenKey(realmId), JSON.stringify(next));
  return next;
}

export async function saveInitialTokenState(
  env: Env,
  state: TokenState,
): Promise<void> {
  await env.QBO_TOKEN_KV.put(tokenKey(state.realmId), JSON.stringify(state));
}

export async function getAccessToken(env: Env, realmId: string): Promise<string> {
  let state = await readState(env, realmId);
  if (!state && env.QUICKBOOKS_REFRESH_TOKEN) {
    state = {
      realmId,
      companyName: env.EXPECTED_COMPANY_NAME,
      refreshToken: env.QUICKBOOKS_REFRESH_TOKEN,
    };
  }
  if (!state) throw new QboError("qbo_not_connected", 401);
  if (state.accessToken && (state.accessTokenExpiresAt || 0) > Date.now() + 120_000) {
    return state.accessToken;
  }
  return (await refreshToken(env, realmId, state)).accessToken!;
}

export async function qboFetch(
  env: Env,
  realmId: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const accessToken = await getAccessToken(env, realmId);
  const response = await fetch(`${apiBase(env.QUICKBOOKS_ENVIRONMENT)}/${realmId}/${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new QboError("qbo_access_denied", 401);
    if (response.status === 404) throw new QboError("qbo_not_found", 404);
    throw new QboError("qbo_api_error", 502);
  }
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function getCompanyInfo(env: Env, realmId: string): Promise<Record<string, unknown>> {
  const payload = (await qboFetch(env, realmId, `companyinfo/${realmId}`)) as {
    CompanyInfo?: Record<string, unknown>;
  };
  return payload.CompanyInfo || {};
}

export async function getInvoice(env: Env, realmId: string, invoiceId: string): Promise<QboInvoice> {
  const payload = (await qboFetch(env, realmId, `invoice/${encodeURIComponent(invoiceId)}`)) as {
    Invoice?: QboInvoice;
  };
  if (!payload.Invoice) throw new QboError("qbo_invoice_not_found", 404);
  return payload.Invoice;
}

export async function sendInvoice(
  env: Env,
  realmId: string,
  invoiceId: string,
  sendTo?: string,
): Promise<{ emailStatus?: string; syncToken?: string; billingEmail?: string }> {
  const query = sendTo ? `?sendTo=${encodeURIComponent(sendTo)}` : "";
  const payload = (await qboFetch(
    env,
    realmId,
    `invoice/${encodeURIComponent(invoiceId)}/send${query}`,
    { method: "POST" },
  )) as { Invoice?: QboInvoice };
  return {
    emailStatus: payload.Invoice?.EmailStatus,
    syncToken: payload.Invoice?.SyncToken,
    billingEmail: payload.Invoice?.BillEmail?.Address,
  };
}

export async function restoreInvoiceBillingEmail(
  env: Env,
  realmId: string,
  invoiceId: string,
  syncToken: string,
  billingEmail: string,
): Promise<QboInvoice> {
  const payload = (await qboFetch(env, realmId, "invoice", {
    method: "POST",
    body: JSON.stringify({
      Id: invoiceId,
      SyncToken: syncToken,
      sparse: true,
      BillEmail: { Address: billingEmail },
    }),
  })) as { Invoice?: QboInvoice };
  if (!payload.Invoice) throw new QboError("qbo_invoice_restore_failed", 502);
  return payload.Invoice;
}

export async function exchangeIntuitCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const clientId = env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new QboError("qbo_oauth_not_configured", 503);
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new QboError("qbo_authorization_exchange_failed", 502);
  const token = (await response.json()) as TokenResponse;
  if (!token.access_token || !token.refresh_token) {
    throw new QboError("qbo_authorization_response_invalid", 502);
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: Math.max(60, token.expires_in || 3600),
  };
}

export async function getCompanyInfoWithToken(
  env: Env,
  realmId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${apiBase(env.QUICKBOOKS_ENVIRONMENT)}/${realmId}/companyinfo/${realmId}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new QboError("qbo_company_lookup_failed", 502);
  const payload = (await response.json()) as { CompanyInfo?: Record<string, unknown> };
  if (!payload.CompanyInfo) throw new QboError("qbo_company_response_invalid", 502);
  return payload.CompanyInfo;
}

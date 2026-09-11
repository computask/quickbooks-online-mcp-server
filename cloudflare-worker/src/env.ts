export interface Env {
  OAUTH_KV: KVNamespace;
  QBO_TOKEN_KV: KVNamespace;
  AUDIT_DB: D1Database;
  OAUTH_PROVIDER: Record<string, unknown>;
  QUICKBOOKS_CLIENT_ID?: string;
  QUICKBOOKS_CLIENT_SECRET?: string;
  QUICKBOOKS_REFRESH_TOKEN?: string;
  QUICKBOOKS_REALM_ID?: string;
  QUICKBOOKS_REDIRECT_URI?: string;
  QUICKBOOKS_ENVIRONMENT: "production" | "sandbox" | string;
  EXPECTED_COMPANY_NAME: string;
  QBO_SEND_ENABLED: string;
  QBO_RECIPIENT_ALLOWLIST?: string;
}

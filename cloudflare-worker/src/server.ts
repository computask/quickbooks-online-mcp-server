import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { AuthHandler } from "./auth-handler";
import type { Env } from "./env";
import { getCompanyInfo, getInvoice, sendInvoice, QboError } from "./qbo";

const SEALED_INVOICE_IDS = new Set(["57664", "109720"]);

function resultText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function authRealmId(): string {
  const auth = getMcpAuthContext();
  const realmId = auth?.props?.realmId;
  if (typeof realmId !== "string" || !realmId) throw new QboError("qbo_not_authorized", 401);
  return realmId;
}

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  return `${(local?.slice(0, 1) || "*")}***@${domain || "unknown"}`;
}

function parseAllowlist(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : [],
    ]));
  } catch {
    return {};
  }
}

function safeInvoiceId(invoiceId: string): void {
  if (SEALED_INVOICE_IDS.has(invoiceId)) throw new QboError("sealed_test_invoice_blocked", 403);
}

async function createServer(env: Env) {
  const server = new McpServer({ name: "QBO Invoice MCP", version: "1.0.0" });

  server.registerTool("qbo_company_info", {
    description: "Read the connected QuickBooks company identity. Read-only.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const realmId = authRealmId();
    const company = await getCompanyInfo(env, realmId);
    return resultText({ companyName: company.CompanyName, realmId });
  });

  server.registerTool("qbo_get_invoice", {
    description: "Read one QuickBooks invoice by immutable transaction ID. Read-only.",
    inputSchema: { invoice_id: z.string().regex(/^\d+$/) },
    annotations: { readOnlyHint: true },
  }, async ({ invoice_id }) => {
    const realmId = authRealmId();
    const invoice = await getInvoice(env, realmId, invoice_id);
    return resultText({
      id: invoice.Id,
      docNumber: invoice.DocNumber,
      customerId: invoice.CustomerRef?.value,
      total: invoice.TotalAmt,
      balance: invoice.Balance,
      emailStatus: invoice.EmailStatus,
      billingEmail: invoice.BillEmail?.Address ? maskEmail(invoice.BillEmail.Address) : null,
    });
  });

  server.registerTool("qbo_send_invoice", {
    description: "Send one normal QBO invoice PDF by email. This is an external write and never handles Direct Debit. The invoice ID, destination email, and idempotency key must be explicitly verified; the sealed TEST - DO NOT SEND invoice is always blocked. QBO acceptance is not proof of inbox delivery.",
    inputSchema: {
      invoice_id: z.string().regex(/^\d+$/),
      send_to: z.string().email(),
      idempotency_key: z.string().min(8).max(128),
      recipient_verified: z.literal(true),
      override_reason: z.string().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ invoice_id, send_to, idempotency_key, override_reason }) => {
    if (env.QBO_SEND_ENABLED !== "true") throw new QboError("qbo_send_disabled", 503);
    safeInvoiceId(invoice_id);
    const realmId = authRealmId();
    const company = await getCompanyInfo(env, realmId);
    const companyName = String(company.CompanyName || "");
    if (companyName.trim().toLowerCase() !== env.EXPECTED_COMPANY_NAME.trim().toLowerCase()) {
      throw new QboError("qbo_company_mismatch", 403);
    }
    const invoice = await getInvoice(env, realmId, invoice_id);
    if (!invoice.TotalAmt || invoice.TotalAmt <= 0) throw new QboError("zero_value_invoice_blocked", 403);
    if (String(invoice.EmailStatus || "").toLowerCase() === "emailsent") {
      throw new QboError("qbo_invoice_already_marked_sent", 409);
    }
    const sendTo = send_to.trim().toLowerCase();
    const invoiceEmail = invoice.BillEmail?.Address?.trim().toLowerCase();
    const allowlist = parseAllowlist(env.QBO_RECIPIENT_ALLOWLIST);
    const invoiceAllowlist = allowlist[invoice_id] || allowlist[invoice.CustomerRef?.value || ""] || [];
    if (!invoiceEmail) throw new QboError("qbo_invoice_has_no_billing_email", 409);
    if (sendTo !== invoiceEmail && (!override_reason || !invoiceAllowlist.includes(sendTo))) {
      throw new QboError("recipient_mismatch_requires_allowlist", 403);
    }

    const operationKey = `send:${idempotency_key}`;
    const now = Date.now();
    await env.AUDIT_DB.prepare(`INSERT OR IGNORE INTO send_operations (operation_key, invoice_id, send_to, status, created_at, updated_at) VALUES (?, ?, ?, 'started', ?, ?)`)
      .bind(operationKey, invoice_id, sendTo, now, now).run();
    const existing = await env.AUDIT_DB.prepare(`SELECT invoice_id, send_to, status, qbo_email_status FROM send_operations WHERE operation_key = ?`)
      .bind(operationKey).first<{ invoice_id: string; send_to: string; status: string; qbo_email_status?: string }>();
    if (!existing) throw new QboError("idempotency_record_unavailable", 503);
    if (existing.invoice_id !== invoice_id || existing.send_to !== sendTo) throw new QboError("idempotency_key_reused", 409);
    if (existing.status !== "started") throw new QboError(existing.status === "sent" ? "already_sent_for_idempotency_key" : "manual_review_required_after_prior_attempt", 409);

    try {
      const sent = await sendInvoice(env, realmId, invoice_id, sendTo);
      await env.AUDIT_DB.prepare(`UPDATE send_operations SET status = 'sent', qbo_email_status = ?, updated_at = ? WHERE operation_key = ?`)
        .bind(sent.emailStatus || null, Date.now(), operationKey).run();
      return resultText({ invoiceId: invoice_id, recipient: maskEmail(sendTo), qboEmailStatus: sent.emailStatus || "accepted", idempotencyKey: idempotency_key });
    } catch (error) {
      await env.AUDIT_DB.prepare(`UPDATE send_operations SET status = 'failed', error_code = ?, updated_at = ? WHERE operation_key = ?`)
        .bind(error instanceof QboError ? error.code : "qbo_send_failed", Date.now(), operationKey).run();
      throw error instanceof QboError ? error : new QboError("qbo_send_failed", 502);
    }
  });

  return server;
}

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return AuthHandler.fetch(request, env, ctx);
    },
  },
});

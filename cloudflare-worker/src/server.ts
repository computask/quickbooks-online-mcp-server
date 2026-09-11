import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { AuthHandler } from "./auth-handler";
import type { Env } from "./env";
import {
  getCompanyInfo,
  getInvoice,
  restoreInvoiceBillingEmail,
  sendInvoice,
  QboError,
} from "./qbo";
import { isSealedInvoice, maskEmail, normalizeEmail, parseAllowlist, sha256Hex } from "./safety";

type SendOperation = {
  operation_key: string;
  invoice_id: string;
  send_to: string;
  status: "pending" | "sending" | "sent" | "failed" | "unknown";
  claim_token?: string;
  qbo_email_status?: string;
};

function resultText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function authRealmId(): string {
  const auth = getMcpAuthContext();
  const realmId = auth?.props?.realmId;
  if (typeof realmId !== "string" || !realmId) throw new QboError("qbo_not_authorized", 401);
  return realmId;
}

function safeInvoiceId(invoiceId: string): void {
  if (isSealedInvoice(invoiceId)) throw new QboError("sealed_test_invoice_blocked", 403);
}

async function reserveSendOperation(
  db: D1Database,
  invoiceId: string,
  sendTo: string,
  idempotencyKey: string,
): Promise<{ operationKey: string; claimToken: string }> {
  const operationKey = `send:${await sha256Hex(idempotencyKey)}`;
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT OR IGNORE INTO send_operations
       (operation_key, invoice_id, send_to, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(operationKey, invoiceId, sendTo, now, now).run();

    const existing = await db.prepare(
      `SELECT operation_key, invoice_id, send_to, status, claim_token, qbo_email_status
       FROM send_operations WHERE operation_key = ?`,
    ).bind(operationKey).first<SendOperation>();

    if (existing && (existing.invoice_id !== invoiceId || existing.send_to !== sendTo)) {
      throw new QboError("idempotency_key_reused", 409);
    }

    const prior = await db.prepare(
      `SELECT operation_key FROM send_operations
       WHERE invoice_id = ? AND operation_key <> ?
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(invoiceId, operationKey).first<{ operation_key: string }>();
    if (prior) throw new QboError("invoice_has_prior_send_attempt", 409);

    if (!existing) {
      throw new QboError("idempotency_record_unavailable", 503);
    }

    if (existing.status === "sent") throw new QboError("already_sent_for_idempotency_key", 409);
    if (existing.status !== "pending") throw new QboError("manual_review_required_after_prior_attempt", 409);

    const claimToken = crypto.randomUUID();
    const claim = await db.prepare(
      `UPDATE send_operations
       SET status = 'sending', claim_token = ?, updated_at = ?
       WHERE operation_key = ? AND status = 'pending' AND claim_token IS NULL`,
    ).bind(claimToken, now, operationKey).run();

    if (claim.meta.changes !== 1) throw new QboError("send_operation_claim_lost", 409);
    return { operationKey, claimToken };
  } catch (error) {
    if (error instanceof QboError) throw error;
    throw new QboError("idempotency_store_unavailable", 503);
  }
}

async function markOperation(
  db: D1Database,
  operationKey: string,
  claimToken: string,
  status: "sent" | "failed" | "unknown",
  errorCode: string | null,
  qboEmailStatus: string | null,
): Promise<boolean> {
  try {
    const result = await db.prepare(
      `UPDATE send_operations
       SET status = ?, error_code = ?, qbo_email_status = ?, updated_at = ?
       WHERE operation_key = ? AND claim_token = ?`,
    ).bind(status, errorCode, qboEmailStatus, Date.now(), operationKey, claimToken).run();
    return result.meta.changes === 1;
  } catch {
    // Never expose an audit-store fault or encourage a retry after an external call.
    return false;
  }
}

async function createServer(env: Env) {
  const server = new McpServer({ name: "QBO Invoice MCP", version: "1.1.0" });

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
    description: "Send one normal QBO invoice PDF by email. This is an external write and never handles Direct Debit. The invoice ID, destination email, idempotency key, and recipient verification must be explicit. The sealed TEST - DO NOT SEND invoice is always blocked. If routing to an allowlisted alternate address, QBO temporarily changes BillEmail; this server restores the original value with SyncToken protection and verifies it. A QBO EmailSent response is acceptance, not inbox delivery proof, and any uncertain attempt requires manual review rather than retry.",
    inputSchema: {
      invoice_id: z.string().regex(/^\d+$/),
      send_to: z.string().email(),
      idempotency_key: z.string().min(8).max(128),
      recipient_verified: z.literal(true),
      override_reason: z.string().trim().min(1).max(500).optional(),
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

    const sendTo = normalizeEmail(send_to);
    const originalBillingEmail = invoice.BillEmail?.Address?.trim() || "";
    const invoiceEmail = normalizeEmail(originalBillingEmail);
    if (!invoiceEmail) throw new QboError("qbo_invoice_has_no_billing_email", 409);

    const allowlist = parseAllowlist(env.QBO_RECIPIENT_ALLOWLIST);
    const invoiceAllowlist = allowlist[invoice_id] || allowlist[invoice.CustomerRef?.value || ""] || [];
    const isAlternateRecipient = sendTo !== invoiceEmail;
    if (isAlternateRecipient && (!override_reason || !invoiceAllowlist.includes(sendTo))) {
      throw new QboError("recipient_mismatch_requires_allowlist", 403);
    }

    const operation = await reserveSendOperation(env.AUDIT_DB, invoice_id, sendTo, idempotency_key);
    let sendAccepted = false;

    try {
      // Omitting sendTo is important: QBO uses the stored BillEmail without rewriting it.
      const sent = await sendInvoice(env, realmId, invoice_id, isAlternateRecipient ? sendTo : undefined);
      sendAccepted = true;

      if (isAlternateRecipient) {
        const afterSend = await getInvoice(env, realmId, invoice_id);
        const routedEmail = afterSend.BillEmail?.Address ? normalizeEmail(afterSend.BillEmail.Address) : "";
        if (routedEmail !== sendTo || !afterSend.SyncToken) {
          throw new QboError("qbo_send_succeeded_recipient_restore_required", 502);
        }

        await restoreInvoiceBillingEmail(
          env,
          realmId,
          invoice_id,
          afterSend.SyncToken,
          originalBillingEmail,
        );
        const restored = await getInvoice(env, realmId, invoice_id);
        const restoredEmail = restored.BillEmail?.Address ? normalizeEmail(restored.BillEmail.Address) : "";
        if (restoredEmail !== invoiceEmail) {
          throw new QboError("qbo_send_succeeded_recipient_restore_required", 502);
        }
      }

      const auditRecorded = await markOperation(env.AUDIT_DB, operation.operationKey, operation.claimToken, "sent", null, sent.emailStatus || null);
      if (!auditRecorded) throw new QboError("qbo_send_succeeded_audit_unconfirmed", 503);
      return resultText({
        invoiceId: invoice_id,
        recipient: maskEmail(sendTo),
        qboEmailStatus: sent.emailStatus || "accepted",
        idempotencyKey: idempotency_key,
      });
    } catch (error) {
      const safeError = error instanceof QboError ? error : new QboError("qbo_send_failed", 502);
      await markOperation(
        env.AUDIT_DB,
        operation.operationKey,
        operation.claimToken,
        sendAccepted ? "unknown" : "failed",
        safeError.code,
        null,
      );
      throw safeError;
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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { restoreInvoiceBillingEmail, sendInvoice } from "../src/qbo";

const env = {
  QBO_TOKEN_KV: {
    get: vi.fn(async () => ({
      realmId: "123",
      companyName: "CompuTask Ltd",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessTokenExpiresAt: Date.now() + 300_000,
    })),
  },
  QUICKBOOKS_ENVIRONMENT: "production",
} as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe("QBO invoice send requests", () => {
  it("omits sendTo for the stored billing address so QBO does not rewrite BillEmail", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ Invoice: { EmailStatus: "EmailSent" } }), { status: 200 }),
    );

    await sendInvoice(env, "123", "700");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://quickbooks.api.intuit.com/v3/company/123/invoice/700/send");
  });

  it("uses sendTo only for an explicitly authorized alternate route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ Invoice: { EmailStatus: "EmailSent", SyncToken: "4" } }), { status: 200 }),
    );

    await sendInvoice(env, "123", "700", "alternate@example.com");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://quickbooks.api.intuit.com/v3/company/123/invoice/700/send?sendTo=alternate%40example.com");
  });

  it("restores only the sparse BillEmail field with the latest SyncToken", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ Invoice: { Id: "700", SyncToken: "5", BillEmail: { Address: "original@example.com" } } }), { status: 200 }),
    );

    await restoreInvoiceBillingEmail(env, "123", "700", "4", "original@example.com");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://quickbooks.api.intuit.com/v3/company/123/invoice");
    expect(JSON.parse(String(init.body))).toEqual({
      Id: "700",
      SyncToken: "4",
      sparse: true,
      BillEmail: { Address: "original@example.com" },
    });
  });
});

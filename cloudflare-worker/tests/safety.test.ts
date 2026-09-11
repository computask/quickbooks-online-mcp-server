import { describe, expect, it } from "vitest";
import { isSealedInvoice, maskEmail, normalizeEmail, parseAllowlist, sha256Hex } from "../src/safety";

describe("send safety helpers", () => {
  it("normalizes and masks recipients without exposing the full address", () => {
    expect(normalizeEmail("  Billing@Example.com ")).toBe("billing@example.com");
    expect(maskEmail("Billing@Example.com")).toBe("b***@example.com");
  });

  it("accepts only a JSON object of recipient arrays", () => {
    expect(parseAllowlist('{"57665":["Alt@Example.com", 7], "608":["ops@example.com"]}')).toEqual({
      "57665": ["alt@example.com"],
      "608": ["ops@example.com"],
    });
    expect(parseAllowlist("[]")).toEqual({});
    expect(parseAllowlist("not-json")).toEqual({});
  });

  it("keeps both sealed identifiers blocked", () => {
    expect(isSealedInvoice("57664")).toBe(true);
    expect(isSealedInvoice("109720")).toBe(true);
    expect(isSealedInvoice("109721")).toBe(false);
  });

  it("hashes idempotency material without returning it", async () => {
    expect(await sha256Hex("invoice-send-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("invoice-send-key")).toBe(await sha256Hex("invoice-send-key"));
  });
});

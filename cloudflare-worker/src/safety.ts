export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function maskEmail(value: string): string {
  const [local, domain] = normalizeEmail(value).split("@", 2);
  return `${(local?.slice(0, 1) || "*")}***@${domain || "unknown"}`;
}

export function parseAllowlist(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").map(normalizeEmail)
        : [],
    ]));
  } catch {
    return {};
  }
}

export function isSealedInvoice(invoiceId: string): boolean {
  return invoiceId === "57664" || invoiceId === "109720";
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

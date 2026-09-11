# QBO Invoice MCP Worker

This is the remote Cloudflare Worker companion to the upstream QuickBooks MCP
server. It ports the invoice-PDF send operation from PR #46 into a remote
Streamable HTTP MCP endpoint without deploying the upstream stdio process.

Safety boundaries:

- Only the configured `CompuTask Ltd` company is accepted during OAuth.
- The sealed test invoice IDs `57664` and `109720` are hard-blocked.
- Zero-value invoices are hard-blocked.
- Sending requires an explicit destination, a caller-supplied idempotency key,
  and `recipient_verified: true`.
- A destination different from QBO's billing email needs an explicit
  `QBO_RECIPIENT_ALLOWLIST` entry and override reason. QBO temporarily changes
  `BillEmail` for that override; the Worker restores the original address with
  the current `SyncToken` and verifies it before reporting success.
- D1 atomically claims a send attempt before the QBO call. A retry with the
  same key, a different key for the same invoice, or any uncertain prior
  attempt is blocked for manual review; it is never sent a second time
  automatically.
- The endpoint only sends the normal QBO invoice PDF. Direct Debit/GoCardless
  collection is not implemented here.

Required Wrangler secrets:

```text
QUICKBOOKS_CLIENT_ID
QUICKBOOKS_CLIENT_SECRET
```

Optional alternate-recipient authorization is configured as a secret JSON
object keyed by immutable invoice ID or customer ID, for example
`{"12345":["accounts@example.com"]}`:

```text
QBO_RECIPIENT_ALLOWLIST
```

After deploying, register this callback in the Intuit production app:

```text
https://qbo-invoice-mcp.sam-c6d.workers.dev/callback
```

Then set the two secrets with `npx wrangler secret put`, connect the ChatGPT
custom app to:

```text
https://qbo-invoice-mcp.sam-c6d.workers.dev/mcp
```

The custom app must use OAuth. Complete the Intuit authorization once; the
Worker verifies the company name and stores the rotated refresh token. Keep
`QBO_SEND_ENABLED` false while checking the company and invoice read tools,
then set it to true and redeploy only after that read-back is correct.

The initial Intuit authorization is completed through `/authorize`; the Worker
stores the rotated QBO refresh token in `QBO_TOKEN_KV`. Register the Worker's
`/callback` URL in the Intuit production app before authorizing. Keep
`QBO_SEND_ENABLED` set to `false` until the company and read-only tools have
been verified, then change it to `true` and redeploy.

CREATE TABLE IF NOT EXISTS send_operations (
  operation_key TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  send_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'sent', 'failed')),
  qbo_email_status TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_operations_invoice
  ON send_operations(invoice_id);

CREATE TABLE send_operations_v2 (
  operation_key TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  send_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  claim_token TEXT,
  qbo_email_status TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO send_operations_v2 (
  operation_key,
  invoice_id,
  send_to,
  status,
  qbo_email_status,
  error_code,
  created_at,
  updated_at
)
SELECT
  operation_key,
  invoice_id,
  send_to,
  CASE status
    WHEN 'started' THEN 'unknown'
    ELSE status
  END,
  qbo_email_status,
  error_code,
  created_at,
  updated_at
FROM send_operations;

DROP TABLE send_operations;
ALTER TABLE send_operations_v2 RENAME TO send_operations;

CREATE INDEX idx_send_operations_invoice
  ON send_operations(invoice_id);

CREATE UNIQUE INDEX idx_send_operations_active_invoice
  ON send_operations(invoice_id)
  WHERE status IN ('pending', 'sending', 'sent', 'unknown');

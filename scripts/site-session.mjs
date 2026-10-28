import { parseLine } from "../remote/transcript.mjs";
import { call, message, result, user } from "./watch-fixture.mjs";

const step = (after, ...lines) => ({
  after,
  entries: lines.flatMap((line) => parseLine("claude", line, "/workspace") ?? [line]),
});
const failure = (id, content) => JSON.stringify({
  type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] },
});
const edit = (id, file, before, after) => call(id, "Edit", {
  file_path: "/workspace/" + file, old_string: before, new_string: after,
});

const original = [
  "if (await receipts.exists(event.id)) return;",
  "await invoices.apply(event);",
  "await receipts.record(event.id);",
  "await outbox.enqueue(event);",
].join("\n");
const claimed = [
  "const receipt = await db.query(`",
  "  INSERT INTO webhook_receipts (event_id)",
  "  VALUES ($1) ON CONFLICT DO NOTHING",
  "  RETURNING event_id",
  "`, [event.id]);",
  "if (!receipt.rowCount) return;",
  "await invoices.apply(db, event);",
  "await outbox.enqueue(db, event);",
].join("\n");
const atomic = [
  "await db.transaction(async (tx) => {",
  "  const receipt = await tx.query(`",
  "    INSERT INTO webhook_receipts (event_id)",
  "    VALUES ($1) ON CONFLICT DO NOTHING",
  "    RETURNING event_id",
  "  `, [event.id]);",
  "  if (!receipt.rowCount) return;",
  "  await invoices.apply(tx, event);",
  "  await outbox.enqueue(tx, event);",
  "});",
].join("\n");
const integrationCommand = "npm run test:integration -- invoice-webhook";
const green = [
  "PASS tests/invoice-webhook.test.ts",
  "  ✓ rejects an invalid signature",
  "  ✓ applies a valid invoice event",
  "  ✓ acknowledges a repeated delivery",
  "  ✓ deduplicates concurrent deliveries",
  "  ✓ processes distinct event IDs",
  "  ✓ rolls back a failed invoice write",
  "  ✓ retries after an outbox failure",
  "",
  "Test files  1 passed (1)",
  "Tests       7 passed (7)",
].join("\n");

const timeline = [
  step(0,
    user("Stripe retries are creating duplicate invoices. Make the webhook safe to retry, including concurrent deliveries and failures halfway through."),
    message("The handler checks for a receipt before writing the invoice. Two deliveries can both pass that check. I’m tracing the write path and the retry tests."),
    call("read-handler", "Read", { file_path: "/workspace/src/webhooks/invoice.ts" })),
  step(2400, result("read-handler", original)),
  step(1200, call("reproduce", "Bash", { command: integrationCommand })),
  step(3800, failure("reproduce", [
    "FAIL tests/invoice-webhook.test.ts",
    "  ✕ deduplicates concurrent deliveries",
    "",
    "Expected invoice count: 1",
    "Received invoice count: 2",
    "",
    "Two requests accepted the same event ID.",
  ].join("\n"))),
  step(1600, message("The existence check races. I’ll let PostgreSQL claim the event ID with a unique constraint, then check what happens when an invoice write fails.")),
  step(1800, edit("migration", "migrations/018_webhook_receipts.sql", "", [
    "CREATE TABLE webhook_receipts (",
    "  event_id text PRIMARY KEY,",
    "  received_at timestamptz NOT NULL DEFAULT now()",
    ");",
  ].join("\n"))),
  step(1200, result("migration", "Created migrations/018_webhook_receipts.sql")),
  step(1700, edit("claim-event", "src/webhooks/invoice.ts", original, claimed)),
  step(1200, result("claim-event", "Updated src/webhooks/invoice.ts")),
  step(1800, edit("retry-tests", "tests/invoice-webhook.test.ts", "", [
    'it("retries after an outbox failure", async () => {',
    "  outbox.failNextWrite();",
    "  expect((await deliver(event)).status).toBe(500);",
    "  expect((await deliver(event)).status).toBe(200);",
    "  expect(await invoiceCount()).toBe(1);",
    "  expect(await outboxCount()).toBe(1);",
    "});",
  ].join("\n"))),
  step(1200, result("retry-tests", "Added concurrent-delivery, invoice rollback, and outbox retry cases.")),
  step(1000, call("rollback-check", "Bash", { command: integrationCommand })),
  step(4000, failure("rollback-check", [
    "FAIL tests/invoice-webhook.test.ts",
    "  ✓ deduplicates concurrent deliveries",
    "  ✕ rolls back a failed invoice write",
    "  ✕ retries after an outbox failure",
    "",
    "Expected outbox count: 1",
    "Received outbox count: 0",
    "",
    "The retry returned 200, but the receipt already existed.",
    "Tests  5 passed | 2 failed (7)",
  ].join("\n"))),
  step(1600, message("The claim survives when the invoice or outbox write fails. The retry then returns early. The receipt, invoice, and outbox entry need to commit in one transaction.")),
  step(1800, edit("atomic-write", "src/webhooks/invoice.ts", claimed, atomic)),
  step(1500, result("atomic-write", "Moved all three writes into the transaction. Duplicate deliveries still return successfully; failed writes leave the event available for retry.")),
  step(1400, call("integration-green", "Bash", { command: integrationCommand })),
  step(4400, result("integration-green", green)),
  step(1200, call("static-checks", "Bash", { command: "npm run typecheck && npm run lint" })),
  step(3000, result("static-checks", [
    "> tsc --noEmit",
    "Typecheck passed.",
    "",
    "> eslint src tests",
    "0 errors, 0 warnings.",
  ].join("\n"))),
  step(1400, message([
    "## Webhook retries are safe",
    "Concurrent deliveries claim the same event ID once. The receipt, invoice, and outbox entry commit together.",
    "A failed write rolls back the receipt, so the next delivery can retry. Duplicate deliveries return `200` without another invoice.",
    "All seven integration tests pass. Typecheck and lint pass.",
  ].join("\n\n"))),
];

const retryReply = {
  match: "test|retry|retrie|fail|rollback|transaction|concurr|duplic|outbox",
  steps: [
    step(900, message("I’ll check the failure between the invoice write and the outbox write, then retry the same event ID.")),
    step(1000, call("follow-retry", "Bash", { command: 'npm run test:integration -- invoice-webhook -t "retries after an outbox failure"' })),
    step(2600, result("follow-retry", [
      "PASS retries after an outbox failure",
      "First delivery: 500",
      "After rollback: 0 receipts, 0 invoices, 0 outbox entries",
      "Retry: 200",
      "After retry:    1 receipt, 1 invoice, 1 outbox entry",
    ].join("\n"))),
    step(1000, message("The failed delivery leaves no receipt behind. Retrying the same event writes one invoice and one outbox entry.")),
  ],
};

export const session = {
  title: "Make invoice webhooks safe to retry",
  timeline,
  followUps: [
    {
      match: "signatur|secur|auth|invalid|payload",
      steps: [
        step(900, message("I’ll check that signature validation rejects the request before any database write.")),
        step(1000, call("follow-signature", "Bash", { command: 'npm run test:integration -- invoice-webhook -t "rejects an invalid signature"' })),
        step(2200, result("follow-signature", "PASS rejects an invalid signature\nHTTP 400\nDatabase writes: 0")),
        step(1000, message("An invalid signature returns `400` before the transaction starts. No receipt, invoice, or outbox entry is written.")),
      ],
    },
    retryReply,
    {
      match: "migration|deploy|schema|table",
      steps: [
        step(900, message("The new receipt table is additive. I’ll check the migration and the handler’s write boundary.")),
        step(1000, call("follow-migration", "Read", { file_path: "/workspace/migrations/018_webhook_receipts.sql" })),
        step(1800, result("follow-migration", "CREATE TABLE webhook_receipts (\n  event_id text PRIMARY KEY,\n  received_at timestamptz NOT NULL DEFAULT now()\n);")),
        step(1000, message("Apply the migration before deploying the handler. Existing invoice rows are unchanged; new event IDs are claimed inside the invoice transaction.")),
      ],
    },
  ],
  fallback: {
    steps: [
      step(1200, message("The current change covers duplicate deliveries, failed invoice writes, and outbox retries. Which case do you want me to check next?")),
    ],
  },
};

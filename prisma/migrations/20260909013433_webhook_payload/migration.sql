-- CreateTable
CREATE TABLE "WebhookPayload" (
    "webhookId" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bytes" INTEGER NOT NULL,
    "body" BLOB NOT NULL
);

-- CreateIndex
CREATE INDEX "WebhookPayload_receivedAt_idx" ON "WebhookPayload"("receivedAt");

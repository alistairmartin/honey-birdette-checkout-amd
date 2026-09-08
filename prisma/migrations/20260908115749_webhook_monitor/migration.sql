-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT,
    "triggeredAt" DATETIME,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceUpdatedAt" DATETIME,
    "classification" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "repeatOfPrev" BOOLEAN NOT NULL DEFAULT false,
    "payloadBytes" INTEGER NOT NULL,
    "source" TEXT,
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "apiVersion" TEXT
);

-- CreateTable
CREATE TABLE "WebhookQueueSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "files" INTEGER NOT NULL,
    "oldestAge" INTEGER,
    "sampledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookHourly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "hour" DATETIME NOT NULL,
    "count" INTEGER NOT NULL,
    "repeats" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_receivedAt_idx" ON "WebhookEvent"("shop", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_topic_receivedAt_idx" ON "WebhookEvent"("shop", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_resourceType_resourceId_receivedAt_idx" ON "WebhookEvent"("shop", "resourceType", "resourceId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookQueueSample_shop_sampledAt_idx" ON "WebhookQueueSample"("shop", "sampledAt");

-- CreateIndex
CREATE INDEX "WebhookHourly_shop_hour_idx" ON "WebhookHourly"("shop", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookHourly_shop_topic_classification_hour_key" ON "WebhookHourly"("shop", "topic", "classification", "hour");

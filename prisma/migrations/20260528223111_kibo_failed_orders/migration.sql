-- CreateTable
CREATE TABLE "KiboFailedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "orderCreatedAt" DATETIME NOT NULL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "kiboOrderId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT
);

-- CreateIndex
CREATE INDEX "KiboFailedOrder_shop_status_idx" ON "KiboFailedOrder"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KiboFailedOrder_shop_shopifyOrderId_key" ON "KiboFailedOrder"("shop", "shopifyOrderId");

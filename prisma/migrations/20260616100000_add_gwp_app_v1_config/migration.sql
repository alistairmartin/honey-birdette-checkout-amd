-- CreateTable
CREATE TABLE "GwpAppV1Config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GwpAppV1Config_shop_idx" ON "GwpAppV1Config"("shop");

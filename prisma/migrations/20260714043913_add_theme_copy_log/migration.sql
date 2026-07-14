-- CreateTable
CREATE TABLE "ThemeCopyLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceShop" TEXT NOT NULL,
    "sourceThemeId" TEXT NOT NULL,
    "sourceThemeName" TEXT NOT NULL,
    "targetShop" TEXT NOT NULL,
    "targetThemeId" TEXT NOT NULL,
    "targetThemeName" TEXT NOT NULL,
    "targetThemeRole" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "filesJson" TEXT NOT NULL,
    "error" TEXT,
    "copiedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ThemeCopyLog_sourceShop_createdAt_idx" ON "ThemeCopyLog"("sourceShop", "createdAt");

-- CreateIndex
CREATE INDEX "ThemeCopyLog_targetShop_createdAt_idx" ON "ThemeCopyLog"("targetShop", "createdAt");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ThemeCopyLog" (
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
    "imagesJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "copiedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ThemeCopyLog" ("copiedBy", "createdAt", "error", "fileCount", "filesJson", "id", "sourceShop", "sourceThemeId", "sourceThemeName", "status", "successCount", "targetShop", "targetThemeId", "targetThemeName", "targetThemeRole") SELECT "copiedBy", "createdAt", "error", "fileCount", "filesJson", "id", "sourceShop", "sourceThemeId", "sourceThemeName", "status", "successCount", "targetShop", "targetThemeId", "targetThemeName", "targetThemeRole" FROM "ThemeCopyLog";
DROP TABLE "ThemeCopyLog";
ALTER TABLE "new_ThemeCopyLog" RENAME TO "ThemeCopyLog";
CREATE INDEX "ThemeCopyLog_sourceShop_createdAt_idx" ON "ThemeCopyLog"("sourceShop", "createdAt");
CREATE INDEX "ThemeCopyLog_targetShop_createdAt_idx" ON "ThemeCopyLog"("targetShop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

import { PrismaClient } from "@prisma/client";

const prisma = global.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  if (!global.prisma) {
    global.prisma = new PrismaClient();
  }
}

// SQLite's default rollback journal lets one long read block every write, so
// a dashboard or rollup query could hold webhook inserts out. WAL lets readers
// and the writer run side by side. The mode is stored in the database file,
// so this is a no-op after the first boot.
prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL").catch((err) => {
  console.error("[db] could not enable WAL:", err?.message || err);
});

export default prisma;

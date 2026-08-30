import "dotenv/config";
import app from "./app";
import { pool } from "./db";

const port = Number(process.env.PORT) || 4000;

const server = app.listen(port, () => {
  console.log(`OSU Fleet API listening on port ${port}`);
});

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  server.close(async (serverError) => {
    if (serverError) {
      console.error("Error closing HTTP server:", serverError);
      process.exitCode = 1;
    }
    try {
      await pool.end();
      console.log("PostgreSQL pool closed.");
    } catch (databaseError) {
      console.error("Error closing PostgreSQL pool:", databaseError);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
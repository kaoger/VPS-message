import fs from "node:fs";

export function logEvent(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;
  try {
    if (process.env.LOG_PATH) fs.appendFileSync(process.env.LOG_PATH, line);
  } catch {
    /* ignore */
  }
  console.log(...parts);
}

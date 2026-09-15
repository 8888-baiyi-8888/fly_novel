import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "../config/paths";

mkdirSync(APP_HOME, { recursive: true });
writeFileSync(join(APP_HOME, ".encryption-key"), randomBytes(32).toString("hex") + "\n", {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

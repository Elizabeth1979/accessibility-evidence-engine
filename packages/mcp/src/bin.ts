#!/usr/bin/env node

import { startServer } from "./index";

void startServer().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

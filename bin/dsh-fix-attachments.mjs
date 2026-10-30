#!/usr/bin/env node
/** Entry point. Keep this thin: everything lives in src/. */

import { main } from "../src/cli.mjs";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
}

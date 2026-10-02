#!/usr/bin/env node

import { getQuotaWindows } from "../server/quota.js";

// The normal collector makes one read-only RPC attempt. Never dump local auth
// or probe the undocumented WHAM endpoint from this diagnostic command.
if (process.argv.includes("--wham-only")) {
  console.error("Direct WHAM probing is unsupported. Use the app-server quota collector.");
  process.exitCode = 1;
} else {
  const result = await getQuotaWindows();
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

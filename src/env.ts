import { resolve } from 'node:path';
import { config } from 'dotenv';

export function loadEnv(): void {
  // Snapshot real env vars so they always take precedence
  const realEnv = { ...process.env };

  // quiet, because dotenv otherwise writes an "injecting env" banner to stdout, and stdout is
  // the JSON-RPC channel when the server runs over stdio.
  const quiet = true;

  // Load .env (base defaults)
  config({ path: resolve(process.cwd(), '.env'), quiet });

  // Load .env.local (local overrides, takes precedence over .env)
  config({ path: resolve(process.cwd(), '.env.local'), override: true, quiet });

  // Restore real env vars (they always win)
  Object.assign(process.env, realEnv);
}

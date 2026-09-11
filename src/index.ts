#!/usr/bin/env node
import { loadEnv } from './env.js';
import { runServer } from './runtime.js';

loadEnv();

runServer().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

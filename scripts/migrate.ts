import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
if (existsSync('.env')) loadEnvFile('.env');
const store = await openStore(loadConfig(process.env));
await store.close();

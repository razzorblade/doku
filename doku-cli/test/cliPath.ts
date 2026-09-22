import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_CLI_DIR = fileURLToPath(new URL('../node_modules/.cache/doku-test-cli', import.meta.url));
export const TEST_CLI = path.join(TEST_CLI_DIR, 'cli.js');

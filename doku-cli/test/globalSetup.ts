import { build } from 'tsup';
import { TEST_CLI_DIR } from './cliPath.js';

/** Build the CLI once into node_modules/.cache, never over the dist/ that `npm link` uses. */
export default async function setup(): Promise<void> {
  await build({
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    outDir: TEST_CLI_DIR,
    clean: true,
    silent: true,
    config: false,
    banner: { js: '#!/usr/bin/env node' },
  });
}

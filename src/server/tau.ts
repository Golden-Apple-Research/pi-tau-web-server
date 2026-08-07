#!/usr/bin/env node

import * as tau from './server-main.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ESM equivalent of the old `require.main === module` check: run the CLI when
// this file is the entry point. Paths are compared through realpath because
// npm installs bin entries as symlinks — argv[1] keeps the symlink path while
// the module URL resolves to the real file.
const isMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  tau.startCli();
}

// Preserve both consumption shapes of the old `module.exports = tau`:
// named imports (`import { server } from 'pi-tau-web-server'`) via the
// re-export, and the aggregate default (`import tau from ...`) via the
// namespace object.
export * from './server-main.js';
export default tau;

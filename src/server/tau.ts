#!/usr/bin/env node

import * as tau from './server-main.js';

// Run the CLI whenever Node selected this module as the entry point, including
// package-directory (`node .`) and symlinked npm-bin invocations.
if (import.meta.main) {
  tau.startCli();
}

// Preserve both consumption shapes of the old `module.exports = tau`:
// named imports (`import { server } from 'pi-tau-web-server'`) via the
// re-export, and the aggregate default (`import tau from ...`) via the
// namespace object.
export * from './server-main.js';
export default tau;

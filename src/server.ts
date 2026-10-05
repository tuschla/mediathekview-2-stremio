import { createServer } from 'node:http';
import { Addon } from './addon.ts';
import { loadConfig } from './config.ts';
import { createHandler } from './http.ts';
import { MvwClient } from './mvw.ts';

const cfg = loadConfig();
const addon = new Addon(cfg, new MvwClient(cfg.maxConcurrentRequests));

createServer(createHandler(addon, cfg.publicUrl)).listen(cfg.port, cfg.host, () => {
  console.log(`Mediathek add-on for ${cfg.channels.join(', ')}: http://${cfg.host}:${cfg.port}/manifest.json`);
});

// As PID 1 in a container, Node does not exit on SIGTERM/SIGINT by default.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));

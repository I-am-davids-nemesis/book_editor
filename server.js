import { createApp } from './server/app.js';
import { AutoCommitter, DEFAULT_INTERVAL_MS } from './server/autocommit.js';
import { configPath, loadConfig } from './server/config.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;

const config = await loadConfig();
// AUTOCOMMIT_MINUTES=0 turns the timed commit off (switching files still commits).
const minutes = Number(process.env.AUTOCOMMIT_MINUTES);
const intervalMs = Number.isFinite(minutes) && process.env.AUTOCOMMIT_MINUTES !== '' && minutes >= 0
  ? minutes * 60000
  : DEFAULT_INTERVAL_MS;
const app = createApp({ autoCommitter: new AutoCommitter({ intervalMs }) });

const server = app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use; set PORT to use another.` : err.message);
    process.exit(1);
  }
  console.log(`Book editor running at http://localhost:${PORT}`);
  console.log(`Library: ${config.libraryRoot}`);
  console.log(`Config:  ${configPath()}`);
});

// Commit pending edits before exiting, so Ctrl-C never strands work uncommitted.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    server.close();
    await app.locals.autoCommitter.flush();
    process.exit(0);
  });
}

import { createApp } from './server/app.js';
import { configPath, loadConfig } from './server/config.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;

const config = await loadConfig();
const app = createApp();

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use; set PORT to use another.` : err.message);
    process.exit(1);
  }
  console.log(`Book editor running at http://localhost:${PORT}`);
  console.log(`Library: ${config.libraryRoot}`);
  console.log(`Config:  ${configPath()}`);
});

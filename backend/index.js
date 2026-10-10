import 'dotenv/config';
import { closeAll } from './lib/browser.js';
import { reconcileAccountStates } from './lib/db.js';
import { createApp } from './app.js';

const PORT = process.env.APP_PORT || process.env.DEFAULT_APP_PORT || (process.env.PORT && process.env.PORT !== '8080' ? process.env.PORT : 3000);
const HOST = process.env.HOST || '0.0.0.0';

const reconciled = reconcileAccountStates();
if (reconciled > 0) {
  console.log(`[boot] Reset ${reconciled} orphaned account state(s) back to ready`);
}

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  console.log(`aliwebdesign running -> {{http://${HOST}}}:${PORT}`);
});
server.on('error', (err) => {
  console.error('Server listen error:', err.message);
});
server.setTimeout(600000);

async function shutdown() {
  console.log('[server] Shutting down gracefully, closing all browser contexts...');
  try {
    await closeAll();
  } catch (err) {
    console.error('[server] Error closing browser contexts during shutdown:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server };

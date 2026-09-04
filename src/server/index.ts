import { buildApp } from './app.js';
import { config } from './config.js';
import { startUpdateScheduler } from './services/updater.js';

const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  startUpdateScheduler((msg) => app.log.info(msg));
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}

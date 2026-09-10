import { buildApp } from './app.js';

const app = await buildApp();
try {
  await app.listen({ port: app.config.PORT, host: '0.0.0.0' });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

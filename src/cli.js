// Runs FeedSwitch as a local website, without the desktop window.
import { startServer } from './server.js';

try {
  const app = await startServer({
    port: process.env.PORT === undefined ? 4173 : Number(process.env.PORT),
    host: process.env.HOST || '127.0.0.1',
  });
  console.log(`FeedSwitch est prêt : ${app.url}`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  console.error(
    err.code === 'EADDRINUSE'
      ? 'Ce port est déjà utilisé. FeedSwitch tourne peut-être déjà ; sinon choisis un autre port avec PORT=…'
      : err.message,
  );
  process.exit(1);
}

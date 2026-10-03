import { createApp } from './app.js';
import { AppService } from '../app/service.js';
import { MongoStore } from '../infra/mongoStore.js';

/**
 * 环境变量：
 *   MONGO_URL   默认 mongodb://mongo:27017
 *   MONGO_DB    默认 ae_bvalue
 *   PORT        默认 8080
 */
async function main(): Promise<void> {
  const mongoUrl = process.env.MONGO_URL ?? 'mongodb://mongo:27017';
  const dbName = process.env.MONGO_DB ?? 'ae_bvalue';
  const port = Number(process.env.PORT ?? 8080);

  const store = new MongoStore(mongoUrl, dbName);
  await store.connect();

  const service = new AppService(store, store);
  // 重启后从已存数据恢复所有试验的窗口与预警状态，再开始接收
  await service.restoreAll();

  const app = createApp(service);
  const server = app.listen(port, () => {
    console.log(`[ae-bvalue] listening on :${port}, mongo=${mongoUrl}/${dbName}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[ae-bvalue] ${signal} received, shutting down`);
    server.close();
    await store.close?.();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[ae-bvalue] fatal:', err);
  process.exit(1);
});

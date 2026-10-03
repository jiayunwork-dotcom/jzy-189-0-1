import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { MongoRepository } from './repo/mongo.js';
import { EngineRegistry } from './service/registry.js';
import { createApp } from './http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // 重启场景：Mongo 可能比后启动的容器晚就绪，循环等待并重连
  const client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5_000,
  });

  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect();
      await client.db(config.mongoDbName).command({ ping: 1 });
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.warn(`等待 MongoDB 就绪（第 ${attempt} 次）...`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  const db = client.db(config.mongoDbName);
  const repo = new MongoRepository(db);
  await repo.ensureIndexes();

  // 从已存数据恢复全部进行中试验；恢复后窗口/预警与未中断完全一致
  const registry = await EngineRegistry.create(repo);
  const app = createApp({ repo, registry });

  const server = app.listen(config.port, () => {
    console.log(`声发射 b 值后端监听 :${config.port}`);
  });

  const shutdown = async () => {
    server.close(() => {
      void client.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('启动失败', err);
  process.exit(1);
});

export interface Config {
  mongoUri: string;
  mongoDbName: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mongoUri: env.MONGO_URI ?? 'mongodb://mongo:27017',
    mongoDbName: env.MONGO_DB ?? 'ae_bvalue',
    port: Number(env.PORT ?? 3000),
  };
}

import { createServer } from 'node:http';
import { createApp } from './src/app.js';
import { connectDatabase } from './src/config/database.js';
import { env } from './src/config/env.js';
import { connectRedis, getRedisStatus } from './src/infrastructure/redis/redisClient.js';
import { configureTaxiSocketServer } from './src/modules/taxi/socket/index.js';
import { User } from './src/modules/taxi/user/models/User.js';
import { restoreScheduledDispatches, startDispatchRecoveryLoop } from './src/modules/taxi/services/dispatchService.js';
import { startDriverSubscriptionExpiryLoop } from './src/modules/taxi/driver/services/driverSubscriptionExpiryService.js';
import { startOutstationAdvanceLoop } from './src/modules/taxi/outstation/services/outstationService.js';

const bootstrap = async () => {
  await connectDatabase();
  if (!env.redis.enabled || !env.redis.url) {
    console.warn('[redis] disabled or not configured, falling back to in-memory rate limiting');
  } else {
    const redisClient = await connectRedis();
    if (!redisClient?.isReady) {
      console.warn('[redis] startup connect did not complete; app will continue and fall back to in-memory rate limiting until Redis is ready');
    }
  }

  const app = createApp();
  const httpServer = createServer(app);

  await configureTaxiSocketServer(httpServer);
  await restoreScheduledDispatches();
  startDispatchRecoveryLoop();
  startDriverSubscriptionExpiryLoop();
  startOutstationAdvanceLoop();

  // Loopback by default: nginx is the only thing that should reach these
  // processes, and with several instances on 5000-5003 a public bind would let
  // a client pin one instance and skip the load balancer entirely. Set HOST to
  // override where the proxy lives elsewhere (containers, another box).
  const host = process.env.HOST || '127.0.0.1';

  httpServer.listen(env.port, host, () => {
    const redisStatus = getRedisStatus();
    console.log(`Taxi backend listening on ${host}:${env.port}`);
    console.log('[redis] status', redisStatus);
  });
};

bootstrap().catch((error) => {
  console.error('Failed to start taxi backend', error);
  process.exit(1);
});

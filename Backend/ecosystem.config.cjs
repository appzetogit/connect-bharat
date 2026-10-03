/**
 * Connect Bharat on the shared VPS (bharat.buytogetherindia.com).
 *
 * One fork-mode instance on 5150. The box hosts many other apps, and Redis is
 * left off there (REDIS_ENABLED=false) so this app cannot share keys with
 * them - which makes a single instance a requirement, not just a choice:
 * Socket.IO without the Redis adapter only works while one process holds every
 * connection.
 *
 * To scale out later, enable a dedicated Redis, then run several apps on their
 * own ports behind an nginx upstream with ip_hash. Use separate apps rather
 * than pm2 cluster mode: cluster round-robins every request, which breaks
 * Socket.IO's polling handshake.
 *
 * PORT is set here rather than in .env: dotenv does not override a variable
 * that is already present in the environment, so this value wins.
 */
module.exports = {
  apps: [
    {
      name: 'bharat-api',
      script: 'server.js',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 5150,
      },
      max_memory_restart: '600M',
      time: true,
      kill_timeout: 8000,
    },
  ],
};

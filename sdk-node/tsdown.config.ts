import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/http/express": "src/adapters/http/express.ts",
    "adapters/http/koa": "src/adapters/http/koa.ts",
    "adapters/http/strapi": "src/adapters/http/strapi.ts",
    "adapters/socket/socketio": "src/adapters/socket/socketio.ts",
    "adapters/cron/node-cron": "src/adapters/cron/node-cron.ts",
    "outbound/index": "src/outbound/index.ts",
    "hermetic/index": "src/hermetic/index.ts",
    "db/postgres": "src/db/postgres.ts",
    "db/prisma": "src/db/prisma.ts",
    "adapters/http/fastify": "src/adapters/http/fastify.ts",
    "adapters/queue/bullmq": "src/adapters/queue/bullmq.ts",
    "auto": "src/auto.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
  // Never bundle the SDK's own runtime deps or peer deps — users install them.
  external: [
    "@grpc/grpc-js",
    "@bufbuild/protobuf",
    "express",
    "koa",
    "socket.io",
    "node-cron",
    "pg",
    "fastify",
    "bullmq",
    "@prisma/client",
  ],
});

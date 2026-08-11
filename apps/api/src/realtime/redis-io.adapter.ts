import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub.
 *
 * Without this, `server.to(room).emit()` only reaches clients connected to the
 * *same* API container — so the moment we scale to two replicas, half the
 * dispatchers stop seeing half the trucks. With it, room membership and
 * broadcasts are cluster-wide and the API stays stateless (ADR-004, ADR-012).
 *
 * The pub/sub connections must NOT carry the application key prefix; the
 * adapter manages its own channel namespace.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private connections: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    const pubClient = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    const subClient = pubClient.duplicate();
    this.connections = [pubClient, subClient];

    await Promise.all([pubClient.ping(), subClient.ping()]);
    this.adapterConstructor = createAdapter(pubClient, subClient, {
      key: 'kh-socket',
    });
    this.logger.log('Socket.IO Redis adapter connected');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.corsOrigins.length ? this.corsOrigins : true,
        credentials: true,
      },
      // Dispatchers on factory Wi-Fi reconnect constantly; a generous recovery
      // window means they resume their rooms instead of re-subscribing.
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      },
      maxHttpBufferSize: 1e6,
    } as ServerOptions);

    if (this.adapterConstructor) {
      (server as { adapter: (a: unknown) => void }).adapter(this.adapterConstructor);
    }
    return server;
  }

  async close(server: unknown): Promise<void> {
    await super.close(server as never);
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}

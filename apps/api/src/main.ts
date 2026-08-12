import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('Bootstrap');

  const adapter = new FastifyAdapter({
    // Decompressed bodies can be large; the guard-level limits are the real
    // control, this is just a backstop against a hostile client.
    bodyLimit: Math.max(config.ingest.maxBodyBytes, 16 * 1024 * 1024),
    trustProxy: config.trustProxy,
    // Coolify's proxy already logs access; Nest logs what matters to us.
    logger: false,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  const fastify = adapter.getInstance();

  // ---------------------------------------------------------------------------
  // Request decompression.
  //
  // A truck emerging from a 12-hour dead zone uploads ~8,600 points ≈ 2.4 MB of
  // JSON. Gzipped that is ~250 KB — the difference between a 90-second upload
  // on a 2G edge cell and a 9-second one, and the difference between succeeding
  // and timing out before the truck loses signal again (ADR-010).
  // ---------------------------------------------------------------------------
  fastify.addHook('preParsing', async (request, _reply, payload: Readable) => {
    const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase();
    if (!encoding || encoding === 'identity') return payload;

    const decompressor =
      encoding === 'gzip' ? createGunzip()
      : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress()
      : null;

    if (!decompressor) return payload;

    const out = payload.pipe(decompressor) as unknown as Readable & {
      receivedEncodedLength: number;
    };

    // Fastify matches Content-Length against the *encoded* byte count, so we
    // keep counting the compressed bytes as they arrive and expose the running
    // total on the stream it will inspect.
    out.receivedEncodedLength = 0;
    payload.on('data', (chunk: Buffer) => {
      out.receivedEncodedLength += chunk.length;
    });
    payload.on('error', (err) => decompressor.destroy(err));

    // The body downstream of this hook is plain JSON. Neutralising the header
    // stops any later preParsing hook (@fastify/compress ships one of its own)
    // from trying to inflate it a second time and failing on plain text.
    request.headers['content-encoding'] = 'identity';

    return out;
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    // ---------------------------------------------------------------------
    // Raw-body preservation, required for HMAC verification.
    //
    // The signature covers sha256(rawBody); re-serialising the parsed object
    // would produce different bytes (key order, number formatting, whitespace)
    // and every driver request would fail.
    //
    // This is Nest's own flag rather than a hand-rolled content-type parser:
    // the adapter registers its JSON parser with `parseAs: 'buffer'` during
    // init(), so adding our own beforehand throws
    // FST_ERR_CTP_ALREADY_PRESENT.
    // ---------------------------------------------------------------------
    rawBody: true,
    logger: config.isProd
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.enableShutdownHooks();

  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: false, // API only; the dashboard sets its own CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(import('@fastify/compress'), {
    global: true,
    threshold: 2048,
    encodings: ['gzip', 'deflate', 'br'],
  });

  app.enableCors({
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    credentials: true,
    // The three signature headers must be allow-listed or browsers strip them.
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Content-Encoding',
      'X-KH-Timestamp', 'X-KH-Nonce', 'X-KH-Signature', 'X-KH-Device-Id',
    ],
    exposedHeaders: ['X-KH-Server-Time'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix(config.globalPrefix, {
    // The QR hand-off link has to be short enough to print on a dispatch note.
    exclude: [
      { path: 't/:code', method: RequestMethod.GET },
      { path: 'healthz', method: RequestMethod.GET },
      // Android will only look here. The path is fixed by the platform and
      // cannot carry an /api/v1 prefix.
      { path: '.well-known/assetlinks.json', method: RequestMethod.GET },
      // Read down a phone line to a driver standing next to a truck.
      { path: 'app', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false, // tolerate fields from a newer app build
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  const ioAdapter = new RedisIoAdapter(app, config.redis.url, config.corsOrigins);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  if (!config.isProd) {
    // Swagger UI on Fastify serves its assets through @fastify/static, which
    // must be an explicit dependency — without it Nest throws
    // "The @fastify/static package is missing" and the process exits. Only
    // reachable in development, so a production-mode smoke test never sees it.
    const swagger = new DocumentBuilder()
      .setTitle('KaraHoca Shipping API')
      .setDescription('3PL tracking: session hand-off, telemetry ingest, live fleet')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      `${config.globalPrefix}/docs`,
      app,
      SwaggerModule.createDocument(app, swagger),
    );
    logger.log(`Swagger UI at /${config.globalPrefix}/docs`);
  }

  await app.listen(config.port, config.host);

  logger.log(`KaraHoca API listening on http://${config.host}:${config.port}/${config.globalPrefix}`);
  logger.log(`Realtime gateway on ws://${config.host}:${config.port}/realtime`);
  logger.log(`HMAC verification: ${config.ingest.requireHmac ? 'ENFORCED' : 'DISABLED (dev only!)'}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});

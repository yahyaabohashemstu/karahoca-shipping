import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * Postgres type coercions applied process-wide.
 *
 * pg returns bigint (OID 20) and numeric (OID 1700) as strings to avoid silent
 * precision loss. For this domain every bigint is a counter that fits in a
 * double (points_total, device_seq) and every numeric is a distance or weight,
 * so converting is safe and stops `"1234"` leaking into JSON responses.
 */
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export interface TxClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  // Not a parameter property: config is consumed here to build the pool and
  // never needed again, so holding a reference would just be dead state.
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      min: config.database.poolMin,
      idleTimeoutMillis: config.database.idleTimeoutMs,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      application_name: 'karahoca-api',
      // Belt and braces: a runaway query must never pin a connection forever.
      statement_timeout: config.database.statementTimeoutMs,
      query_timeout: config.database.statementTimeoutMs,
    });

    this.pool.on('connect', (client) => {
      // Every session resolves unqualified names against our schema first, and
      // works in UTC so timestamptz maths is unambiguous regardless of host TZ.
      void client.query("SET search_path TO kh, public; SET timezone TO 'UTC';");
    });

    this.pool.on('error', (err) => {
      // An idle client erroring is normal during a database restart; log it but
      // never let it take the process down.
      this.logger.error(`Idle pool client error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { rows } = await this.pool.query<{ v: string; ts: string; pg: string }>(
          `SELECT extversion AS v,
                  now()::text  AS ts,
                  current_setting('server_version') AS pg
           FROM pg_extension WHERE extname = 'timescaledb'`,
        );
        if (rows.length === 0) {
          this.logger.warn('TimescaleDB extension not found — did migrations run?');
        } else {
          this.logger.log(
            `Connected to PostgreSQL ${rows[0].pg} with TimescaleDB ${rows[0].v}`,
          );
        }
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        this.logger.warn(
          `Database not ready (${(err as Error).message}); retry ${attempt}/20`,
        );
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('Database pool closed');
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    const started = process.hrtime.bigint();
    try {
      const result = await this.pool.query<R>(text, params as unknown[]);
      return result.rows;
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 500) {
        this.logger.warn(`Slow query (${ms.toFixed(0)} ms): ${text.slice(0, 160)}`);
      }
    }
  }

  /** Exactly one row expected; throws when the query returns 0 or >1. */
  async one<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R> {
    const rows = await this.query<R>(text, params);
    if (rows.length !== 1) {
      throw new Error(`Expected exactly 1 row, got ${rows.length}: ${text.slice(0, 120)}`);
    }
    return rows[0];
  }

  /** Zero or one row. */
  async maybeOne<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R | null> {
    const rows = await this.query<R>(text, params);
    if (rows.length > 1) {
      throw new Error(`Expected at most 1 row, got ${rows.length}: ${text.slice(0, 120)}`);
    }
    return rows[0] ?? null;
  }

  /**
   * Run a callback inside a transaction, retrying once on a serialisation
   * failure or deadlock (40001 / 40P01). These are transient by definition and
   * a blind retry is the documented remedy.
   */
  async transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as TxClient);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if ((code === '40001' || code === '40P01') && attempt === 0) {
          this.logger.warn(`Transaction conflict ${code}; retrying once`);
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw new Error('unreachable');
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; pool: Record<string, number> }> {
    const started = Date.now();
    await this.pool.query('SELECT 1');
    return {
      ok: true,
      latencyMs: Date.now() - started,
      pool: {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      },
    };
  }
}

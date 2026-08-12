import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { AuthModule } from './auth/auth.module';
import { UserAuthGuard } from './auth/guards/user-auth.guard';
import { CatalogModule } from './catalog/catalog.module';
import { RateLimitGuard } from './common/rate-limit.guard';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { IngestModule } from './ingest/ingest.module';
import { JobsModule } from './jobs/jobs.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { SessionsModule } from './sessions/sessions.module';
import { TrackingModule } from './tracking/tracking.module';

@Module({
  imports: [
    // Must be first: everything below injects CONFIG.
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    AuthModule,
    RealtimeModule,
    SessionsModule,
    IngestModule,
    TrackingModule,
    CatalogModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      /*
       * Ordered deliberately. Guards run in registration order, and the rate
       * limiter must run FIRST — it is the only guard that protects the
       * unauthenticated endpoints, and a limiter that runs after
       * authentication protects nothing that needed protecting.
       */
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      // Fail-closed: every route requires a dispatcher token unless it carries
      // @Public(). Driver routes opt out here and re-guard with
      // DriverSessionGuard, which is strictly stricter.
      provide: APP_GUARD,
      useClass: UserAuthGuard,
    },
  ],
})
export class AppModule {}

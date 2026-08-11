import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './configuration';

/**
 * Global so that DatabaseService, RedisService and every guard can inject
 * CONFIG without each feature module re-importing it.
 *
 * `loadConfig` runs once, eagerly, during module construction: a missing
 * JWT_DRIVER_SECRET must crash the container at boot, not at 03:00 when the
 * first driver claims a session.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: loadConfig }],
  exports: [CONFIG],
})
export class AppConfigModule {}

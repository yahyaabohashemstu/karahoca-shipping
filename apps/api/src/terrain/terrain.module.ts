import { Module } from '@nestjs/common';
import { TerrainController } from './terrain.controller';

/**
 * No providers and no imports.
 *
 * The controller talks to one public S3 bucket and holds its own cache; it
 * touches neither the database nor Redis, which is the point — elevation is
 * the one part of the map that must keep working when the pool is saturated,
 * because it is also the part a customer's browser is requesting thirty of at
 * a time.
 */
@Module({
  controllers: [TerrainController],
})
export class TerrainModule {}

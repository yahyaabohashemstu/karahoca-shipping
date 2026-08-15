import { Module } from '@nestjs/common';
import { GeocodeController } from './geocode.controller';

/**
 * No providers and no imports, like TerrainModule and for the same reason: it
 * talks to one public service and holds its own cache, so a saturated database
 * pool cannot stop a dispatcher finding a warehouse.
 */
@Module({
  controllers: [GeocodeController],
})
export class GeocodeModule {}

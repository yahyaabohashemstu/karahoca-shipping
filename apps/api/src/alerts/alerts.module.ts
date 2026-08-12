import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

/**
 * RealtimeModule is imported for the publisher: acknowledging an alert has to
 * reach the other dashboards looking at the same badge, or two dispatchers ring
 * the same driver about the same truck.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}

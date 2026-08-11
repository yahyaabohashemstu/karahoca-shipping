import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimePublisher } from './realtime.publisher';

@Module({
  providers: [RealtimePublisher, RealtimeGateway],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}

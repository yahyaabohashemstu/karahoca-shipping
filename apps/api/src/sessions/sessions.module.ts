import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { DriverController } from './driver.controller';
import { HandoffController } from './handoff.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [RealtimeModule],
  controllers: [SessionsController, DriverController, HandoffController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}

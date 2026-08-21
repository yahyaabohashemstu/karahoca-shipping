import { Module } from '@nestjs/common';
import { ShareModule } from '../share/share.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReleaseModule } from '../release/release.module';
import { DriverController } from './driver.controller';
import { HandoffController } from './handoff.controller';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  // ReleaseModule so the install page can name the version it hands out.
  imports: [ShareModule, RealtimeModule, ReleaseModule],
  controllers: [SessionsController, DriverController, HandoffController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}

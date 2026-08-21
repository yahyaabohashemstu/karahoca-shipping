import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReleaseModule } from '../release/release.module';
import { MaintenanceService } from './maintenance.service';

@Module({
  // ReleaseModule so the outdated-app detector can ask what is released.
  imports: [ScheduleModule.forRoot(), RealtimeModule, ReleaseModule],
  providers: [MaintenanceService],
})
export class JobsModule {}

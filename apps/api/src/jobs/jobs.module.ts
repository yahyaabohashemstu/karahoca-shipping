import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RealtimeModule } from '../realtime/realtime.module';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [ScheduleModule.forRoot(), RealtimeModule],
  providers: [MaintenanceService],
})
export class JobsModule {}

import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [RealtimeModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}

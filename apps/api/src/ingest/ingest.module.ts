import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReleaseModule } from '../release/release.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  /*
   * ReleaseModule so an ingest response can carry the released build number.
   * It is the only channel this architecture has that reaches a phone in
   * seconds — see the note on releasedAppBuild in IngestService.
   */
  imports: [RealtimeModule, ReleaseModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}

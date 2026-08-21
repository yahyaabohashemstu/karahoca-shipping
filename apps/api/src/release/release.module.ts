import { Module } from '@nestjs/common';
import { ReleaseController } from './release.controller';
import { ReleaseService } from './release.service';

/**
 * No DatabaseModule: the release state is the pair of files sitting next to the
 * APK, deliberately. See the note on ReleaseService.
 */
@Module({
  controllers: [ReleaseController],
  providers: [ReleaseService],
  exports: [ReleaseService],
})
export class ReleaseModule {}

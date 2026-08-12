import { Module } from '@nestjs/common';
import { PublicShareController, ShareController } from './share.controller';
import { ShareService } from './share.service';

/**
 * No imports: DatabaseModule and AppConfigModule are both @Global, and this
 * slice needs nothing else. In particular it does not touch RealtimeModule —
 * a consignee gets a page, not a socket. One customer leaving a tab open must
 * not become a Socket.IO connection the fleet gateway has to fan out to.
 */
@Module({
  controllers: [ShareController, PublicShareController],
  providers: [ShareService],
  exports: [ShareService],
})
export class ShareModule {}

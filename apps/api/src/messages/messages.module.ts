import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { DriverMessagesController, SessionMessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [RealtimeModule],
  controllers: [SessionMessagesController, DriverMessagesController],
  providers: [MessagesService],
  // Exported for IngestService, which carries the undelivered count on every
  // response — the closest thing this system has to a push.
  exports: [MessagesService],
})
export class MessagesModule {}

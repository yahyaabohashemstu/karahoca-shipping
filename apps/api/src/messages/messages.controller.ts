import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Driver, Public, Roles } from '../auth/decorators';
import { DriverSessionGuard } from '../auth/guards/driver-session.guard';
import type { DriverContext } from '../auth/auth.types';
import { MessagesService } from './messages.service';
import { AckMessagesDto, SendMessageDto } from './dto';

/**
 * The desk's side: one shipment's thread.
 *
 * Addressed through the session, because that is the recipient a dispatcher
 * means — the lorry carrying this order, on whichever phone has it now.
 * Protected by the global UserAuthGuard.
 */
@Controller('sessions/:sessionId/messages')
export class SessionMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.messages.list(sessionId);
  }

  /** A VIEWER reads the thread but cannot write to a driver. */
  @Roles('ADMIN', 'DISPATCHER')
  @Post()
  send(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.messages.send(sessionId, dto.body, userId);
  }
}

/**
 * The phone's side.
 *
 * Same guard as /ingest and the rest of /driver: session-scoped JWT, and HMAC
 * on the POST. The session comes from the token, never from the request, so a
 * phone can only ever read and acknowledge its own shipment's messages.
 */
@Controller('driver/messages')
@Public()
@UseGuards(DriverSessionGuard)
export class DriverMessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(@Driver() driver: DriverContext) {
    return this.messages.forDevice(driver.sessionId);
  }

  @Post('ack')
  @HttpCode(200)
  acknowledge(@Body() dto: AckMessagesDto, @Driver() driver: DriverContext) {
    return this.messages.acknowledge(driver, dto);
  }
}

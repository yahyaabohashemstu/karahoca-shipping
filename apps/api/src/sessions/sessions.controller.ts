import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators';
import { SessionsService } from './sessions.service';
import {
  CreateSessionDto,
  ListSessionsQueryDto,
  SessionActionDto,
  UpdateSessionPolicyDto,
} from './dto';

/** Dispatcher-facing session management. Protected by the global UserAuthGuard. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Query() query: ListSessionsQueryDto) {
    return this.sessions.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.getDetail(id);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser('id') userId: string) {
    return this.sessions.create(dto, userId);
  }

  /** Re-issue the hand-off code, revoking whatever device holds the session now. */
  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/claim-code')
  @HttpCode(200)
  regenerate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.sessions.regenerateClaimCode(id, userId);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Patch(':id/policy')
  updatePolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSessionPolicyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessions.updatePolicy(id, dto, userId);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/pause')
  @HttpCode(200)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SessionActionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessions.transition(id, 'pause', userId, dto.reason);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/resume')
  @HttpCode(200)
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SessionActionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessions.transition(id, 'resume', userId, dto.reason);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SessionActionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessions.transition(id, 'complete', userId, dto.reason);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SessionActionDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessions.transition(id, 'cancel', userId, dto.reason);
  }
}

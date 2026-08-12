import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators';
import { AlertsService } from './alerts.service';
import { AlertCountQueryDto, ListAlertsQueryDto } from './dto';

/** The exception desk. Dispatcher-facing, protected by the global UserAuthGuard. */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@Query() query: ListAlertsQueryDto) {
    return this.alerts.list(query);
  }

  /**
   * Declared before any parameterised GET would be. Nest matches routes in
   * declaration order, and a `:id` route above this one would swallow /count
   * and fail it as a malformed UUID.
   */
  @Get('count')
  count(@Query() query: AlertCountQueryDto) {
    return this.alerts.count(query);
  }

  /**
   * "I have seen this and I am dealing with it."
   *
   * A VIEWER cannot acknowledge: the stamp is a claim of responsibility for a
   * shipment, and the only people who can act on one are the people who can
   * dispatch it.
   */
  @Roles('ADMIN', 'DISPATCHER')
  @Post(':id/acknowledge')
  @HttpCode(200)
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.alerts.acknowledge(id, userId);
  }
}

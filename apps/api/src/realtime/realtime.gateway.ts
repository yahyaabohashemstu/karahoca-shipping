import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
import { CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { FLEET_COLUMNS } from '../common/fleet-projection';
import { ROOM_ALERTS, ROOM_FLEET, RealtimePublisher, roomSession } from './realtime.publisher';
import type { UserTokenPayload } from '../auth/auth.types';

interface SocketData {
  userId: string;
  email: string;
  role: string;
}

/**
 * Dispatcher-facing WebSocket gateway.
 *
 * Authentication happens once, in `handleConnection`, from the same access token
 * the REST API uses. A socket that fails verification is disconnected before it
 * can join any room — there is no anonymous read of vehicle positions.
 */
@WebSocketGateway({
  path: '/realtime',
  serveClient: false,
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: true },
  pingInterval: 20_000,
  pingTimeout: 25_000,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly publisher: RealtimePublisher,
    private readonly db: DatabaseService,
  ) {}

  afterInit(server: Server): void {
    this.publisher.attach(server);
  }

  handleConnection(client: Socket): void {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.startsWith('Bearer ')
        ? client.handshake.headers.authorization.slice(7)
        : undefined);

    if (!token) {
      client.emit('error:auth', { code: 'MISSING_TOKEN' });
      client.disconnect(true);
      return;
    }

    try {
      const claims = jwt.verify(token, this.config.auth.userJwtSecret, {
        algorithms: ['HS256'],
        issuer: 'karahoca-api',
        audience: 'karahoca-admin',
      }) as UserTokenPayload;

      (client.data as SocketData) = {
        userId: claims.sub,
        email: claims.email,
        role: claims.role,
      };
      // The alert bell is mounted on every screen, so alert delivery must not
      // depend on the fleet subscription the live map owns and drops on
      // navigation. Joined here because every socket that reaches this line is
      // an authenticated dispatcher; leaving is what disconnecting does.
      void client.join(ROOM_ALERTS);

      this.logger.debug(`Socket ${client.id} authenticated as ${claims.email}`);
    } catch {
      client.emit('error:auth', { code: 'INVALID_TOKEN' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /** Join the coalesced fleet-overview stream. */
  @SubscribeMessage('subscribe:fleet')
  async subscribeFleet(@ConnectedSocket() client: Socket) {
    await client.join(ROOM_FLEET);
    // Send an immediate snapshot so the map is populated before the first tick.
    const positions = await this.db.query(
      `SELECT ${FLEET_COLUMNS}
       FROM kh.v_live_fleet f
       WHERE f.status IN ('CLAIMED','ACTIVE','PAUSED')
       ORDER BY f.last_point_at DESC NULLS LAST`,
    );
    return { event: 'fleet:snapshot', data: { at: new Date().toISOString(), positions } };
  }

  @SubscribeMessage('unsubscribe:fleet')
  async unsubscribeFleet(@ConnectedSocket() client: Socket) {
    await client.leave(ROOM_FLEET);
    return { event: 'unsubscribed', data: { room: ROOM_FLEET } };
  }

  /** Join one session's unthrottled detail stream. */
  @SubscribeMessage('subscribe:session')
  async subscribeSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: string },
  ) {
    const sessionId = body?.sessionId;
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return { event: 'error', data: { code: 'BAD_SESSION_ID' } };
    }
    await client.join(roomSession(sessionId));
    return { event: 'subscribed', data: { room: roomSession(sessionId) } };
  }

  @SubscribeMessage('unsubscribe:session')
  async unsubscribeSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: string },
  ) {
    if (body?.sessionId) await client.leave(roomSession(body.sessionId));
    return { event: 'unsubscribed', data: { room: roomSession(body?.sessionId ?? '') } };
  }

  /** Liveness probe used by the dashboard to show a connection indicator. */
  @SubscribeMessage('ping')
  ping() {
    return { event: 'pong', data: { serverTime: Date.now() } };
  }
}

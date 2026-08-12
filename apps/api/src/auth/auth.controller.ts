import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { RateLimit } from '../common/rate-limit.guard';
import { CurrentUser, Public } from './decorators';
import type { AuthenticatedUser, KhRequest } from './auth.types';

class LoginDto {
  @IsEmail({}, { message: 'A valid e-mail address is required' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 10 attempts per IP per minute, and 5 per e-mail address.
   *
   * The per-email window is the one that matters. Password spraying rotates
   * source addresses and tries a handful of common passwords against many
   * accounts; an IP-only limit does nothing about it, and this dashboard has a
   * small, guessable set of accounts.
   */
  @Public()
  @RateLimit({ bucket: 'login', perIp: 10, perSubject: 5, subjectField: 'email', windowSec: 60 })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: KhRequest) {
    return this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: KhRequest) {
    return this.auth.refresh(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}

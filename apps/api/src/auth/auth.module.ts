import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BootstrapService } from './bootstrap.service';
import { DriverSessionGuard } from './guards/driver-session.guard';
import { UserAuthGuard } from './guards/user-auth.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, BootstrapService, UserAuthGuard, DriverSessionGuard],
  exports: [AuthService, UserAuthGuard, DriverSessionGuard],
})
export class AuthModule {}

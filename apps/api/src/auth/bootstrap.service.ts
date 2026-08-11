import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { AuthService } from './auth.service';

/**
 * Creates the first ADMIN account from environment variables.
 *
 * A password hash is never committed to git and never seeded into SQL. On a
 * fresh database the operator sets ADMIN_EMAIL/ADMIN_PASSWORD once, boots, then
 * removes them. If users already exist this is a no-op, so leaving the vars set
 * is harmless but pointless.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { adminEmail, adminPassword, adminName } = this.config.bootstrap;

    const [{ count }] = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM kh.users`,
    );

    if (count > 0) {
      if (adminEmail) {
        this.logger.log(`${count} user(s) already exist — skipping admin bootstrap`);
      }
      return;
    }

    if (!adminEmail || !adminPassword) {
      this.logger.warn(
        'No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are unset. ' +
          'Nobody can sign in. Set them and restart.',
      );
      return;
    }

    if (adminPassword.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    }

    const passwordHash = await this.auth.hashPassword(adminPassword);
    await this.db.query(
      `INSERT INTO kh.users (email, full_name, password_hash, role)
       VALUES ($1, $2, $3, 'ADMIN')
       ON CONFLICT (email) DO NOTHING`,
      [adminEmail, adminName, passwordHash],
    );

    this.logger.log(`Bootstrapped ADMIN account ${adminEmail} — rotate the password now.`);
  }
}

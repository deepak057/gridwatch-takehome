import { Controller, Get } from '@nestjs/common';
import { pool } from './db/pool';

@Controller()
export class HealthController {
  @Get('health')
  async health(): Promise<{ status: string; db: boolean }> {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: true };
    } catch {
      return { status: 'error', db: false };
    }
  }
}

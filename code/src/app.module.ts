import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WebhookController } from './ingest/webhook.controller';

@Module({
  controllers: [HealthController, WebhookController],
})
export class AppModule {}

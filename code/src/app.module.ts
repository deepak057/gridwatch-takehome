import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WebhookController } from './ingest/webhook.controller';
import { NearestController } from './query/nearest.controller';
import { StatusController } from './query/status.controller';

@Module({
  controllers: [HealthController, WebhookController, NearestController, StatusController],
})
export class AppModule {}

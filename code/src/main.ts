import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { connectWithRetry } from './db/pool';
import { runMigrations } from './db/migrate';

async function bootstrap(): Promise<void> {
  await connectWithRetry();
  await runMigrations();

  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(3000);
  console.log('Application is running on port 3000');
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

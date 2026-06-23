import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { createHmac } from 'crypto';
import { AppModule } from '../app.module';
import { pool } from '../db/pool';
import { flushWebhookIngestion } from './webhook.controller';

const SECRET = 'test-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

const BATCH_EVENT = {
  type: 'meter_value',
  charger_id: 'C-DE-0005-A',
  connector_id: '1',
  energy_register_wh: 7777,
  power_w: 1500,
  ts: '2026-06-09T20:00:00+00:00',
};

let app: INestApplication;

beforeAll(async () => {
  process.env.CSMS_WEBHOOK_SECRET = SECRET;

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication({ rawBody: true });
  await app.init();
});

afterAll(async () => {
  await app.close();
  // pool is shared; do not end it here
});

beforeEach(async () => {
  await pool.query('TRUNCATE raw_events, dead_letter RESTART IDENTITY CASCADE');
});

describe('POST /webhook', () => {
  it('responds 200 and ingests events when signature is valid', async () => {
    const body = JSON.stringify({ events: [BATCH_EVENT] });
    const sig = sign(body);

    const resp = await request(app.getHttpServer())
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-csms-signature', sig)
      .send(body);

    expect(resp.status).toBe(200);

    // Drain all in-flight background ingestion before asserting
    await flushWebhookIngestion();

    const { rows } = await pool.query('SELECT id FROM raw_events');
    expect(rows.length).toBe(1);
  });

  it('responds 401 and does not ingest when signature is wrong', async () => {
    const body = JSON.stringify({ events: [BATCH_EVENT] });

    const resp = await request(app.getHttpServer())
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-csms-signature', 'deadbeef')
      .send(body);

    expect(resp.status).toBe(401);

    await flushWebhookIngestion();

    const { rows } = await pool.query('SELECT id FROM raw_events');
    expect(rows.length).toBe(0);
  });
});

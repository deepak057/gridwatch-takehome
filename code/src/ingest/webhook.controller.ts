import {
  Controller,
  Post,
  Headers,
  Res,
  Req,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { normalise, MalformedEventError } from './normalise';
import { ingest } from './inbox';
import { deadLetter } from './dead-letter';

@Controller()
export class WebhookController {
  @Post('webhook')
  async receiveWebhook(
    @Req() req: any,
    @Res() res: any,
    @Headers('x-csms-signature') signature: string,
  ): Promise<void> {
    const secret = process.env.CSMS_WEBHOOK_SECRET ?? '';
    const rawBody: Buffer = req.rawBody ?? Buffer.from('');

    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(signature ?? '', 'hex');
    } catch {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    if (
      sigBuf.length !== expected.length ||
      !timingSafeEqual(sigBuf, expected)
    ) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // Ack first
    res.status(200).json({ ok: true });

    // Process asynchronously
    setImmediate(async () => {
      try {
        const body = JSON.parse(rawBody.toString('utf8'));
        const events: any[] = body?.events ?? [];
        const good: ReturnType<typeof normalise>[] = [];

        for (const ev of events) {
          try {
            good.push(normalise(ev, 'webhook'));
          } catch (err) {
            if (err instanceof MalformedEventError) {
              await deadLetter(ev, 'malformed');
            } else {
              throw err;
            }
          }
        }

        if (good.length > 0) {
          await ingest(good);
        }
      } catch (err) {
        console.error('Webhook async processing error:', err);
      }
    });
  }
}

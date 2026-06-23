import { normalise, MalformedEventError } from './normalise';
import { ingest } from './inbox';
import { deadLetter } from './dead-letter';

export interface PollResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export type FetchPage = (
  siteId: string,
  since: string,
  cursor?: string,
) => Promise<PollResponse>;

export interface PollDeps {
  fetchPage: FetchPage;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export async function pollSite(
  siteId: string,
  since: string,
  deps: PollDeps,
): Promise<{ ingested: number; deadLettered: number; retries: number }> {
  const { fetchPage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 3 } = deps;

  let ingested = 0;
  let deadLettered = 0;
  let retries = 0;
  let cursor: string | undefined;

  while (true) {
    let resp: PollResponse;
    let attempts = 0;

    // Retry loop for a single page (handles 429 and 500)
    while (true) {
      resp = await fetchPage(siteId, since, cursor);

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers['retry-after'] ?? '1', 10);
        await sleep(retryAfter * 1000);
        retries++;
        continue;
      }

      if (resp.status === 500) {
        attempts++;
        if (attempts >= maxRetries) {
          throw new Error(
            `CSMS returned 500 for site=${siteId} after ${maxRetries} retries`,
          );
        }
        retries++;
        continue;
      }

      break;
    }

    const events: any[] = resp.body?.events ?? [];
    const good: ReturnType<typeof normalise>[] = [];

    for (const ev of events) {
      try {
        good.push(normalise(ev, 'poll'));
      } catch (err) {
        if (err instanceof MalformedEventError) {
          await deadLetter(ev, 'malformed');
          deadLettered++;
        } else {
          throw err;
        }
      }
    }

    if (good.length > 0) {
      const result = await ingest(good);
      ingested += result.accepted;
    }

    const nextCursor = resp.body?.next_cursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return { ingested, deadLettered, retries };
}

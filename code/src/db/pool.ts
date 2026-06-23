import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

export async function connectWithRetry(
  retries = 10,
  delayMs = 1000,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('Database connection established');
      return;
    } catch (err) {
      console.warn(
        `DB connection attempt ${attempt}/${retries} failed: ${(err as Error).message}`,
      );
      if (attempt === retries) {
        throw new Error(
          `Could not connect to database after ${retries} attempts`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

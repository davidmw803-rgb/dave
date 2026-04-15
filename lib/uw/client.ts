/**
 * Unusual Whales API client.
 *
 * Session 1: stub only. Session 2 will implement the real methods using the OpenAPI spec
 * at https://api.unusualwhales.com/api/openapi
 *
 * Endpoints we'll use (from session 2 onwards):
 *   - GET /api/stock/{ticker}/analyst-ratings
 *   - GET /api/analyst/{analyst_id}/ratings
 *   - GET /api/stock/{ticker}/news
 */

const BASE_URL = process.env.UW_API_BASE_URL ?? 'https://api.unusualwhales.com/api';

export class UnusualWhalesClient {
  constructor(private readonly apiKey: string = process.env.UW_API_KEY ?? '') {
    if (!this.apiKey) {
      // Don't throw at import time — only when a method is called.
      // Allows app to boot without a key during Session 1.
    }
  }

  private requireKey() {
    if (!this.apiKey) {
      throw new Error('UW_API_KEY is not set in environment.');
    }
  }

  // Implemented in Session 2.
  async getRecentRatingsByAnalyst(_uwAnalystId: string, _sinceIso: string): Promise<unknown[]> {
    this.requireKey();
    throw new Error('Not implemented until Session 2.');
  }

  async getHistoricalRatingsByAnalyst(
    _uwAnalystId: string,
    _fromIso: string,
    _toIso: string
  ): Promise<unknown[]> {
    this.requireKey();
    throw new Error('Not implemented until Session 2.');
  }
}

export const uwClient = new UnusualWhalesClient();
export { BASE_URL as UW_BASE_URL };

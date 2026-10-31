import { Injectable, Logger } from '@nestjs/common';
import type { ExternalProductSuggestionDto } from '@barbercue/shared';

// Optional outside lookup for barcodes missing from the FastQue Global Product Master.
// Open Beauty Facts data is under the Open Database License (ODbL): it needs attribution, and a
// database built from it may need to be shared under the same licence. So this is OFF unless
// OPEN_BEAUTY_FACTS_ENABLED=true (after licence review), and a result is only ever a suggestion the
// salon confirms — never saved on its own. No API key is involved; requests carry a descriptive
// User-Agent as the service asks, time out quickly, and results are cached in memory.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const TIMEOUT_MS = 4000;

@Injectable()
export class OpenBeautyFactsClient {
  private readonly logger = new Logger(OpenBeautyFactsClient.name);
  private readonly cache = new Map<
    string,
    { at: number; value: ExternalProductSuggestionDto | null }
  >();

  get enabled(): boolean {
    return process.env.OPEN_BEAUTY_FACTS_ENABLED === 'true';
  }

  async lookup(barcode: string): Promise<ExternalProductSuggestionDto | null> {
    if (!this.enabled || !/^\d{8,14}$/.test(barcode)) return null;
    const cached = this.cache.get(barcode);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const base = (
      process.env.OPEN_BEAUTY_FACTS_BASE_URL ??
      'https://world.openbeautyfacts.org'
    ).replace(/\/$/, '');
    const url = `${base}/api/v2/product/${barcode}.json?fields=product_name,brands,quantity,categories,image_front_url`;
    let value: ExternalProductSuggestionDto | null = null;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            process.env.PRODUCT_LOOKUP_USER_AGENT ??
            'FastQue-Inventory/1.0 (salon inventory barcode lookup)',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          status?: number;
          product?: Record<string, unknown>;
        };
        const product = body.status === 1 ? body.product : undefined;
        if (product) {
          const str = (key: string) =>
            typeof product[key] === 'string' && product[key]
              ? (product[key] as string).trim().slice(0, 200)
              : null;
          const image = str('image_front_url');
          value = {
            source: 'OPEN_BEAUTY_FACTS',
            attribution: 'Open Beauty Facts contributors',
            license: 'ODbL-1.0',
            sourceUrl: `${base}/product/${barcode}`,
            name: str('product_name'),
            brand: str('brands')?.split(',')[0]?.trim() ?? null,
            packSizeText: str('quantity'),
            category: str('categories')?.split(',')[0]?.trim() ?? null,
            imageUrl: image && image.startsWith('https://') ? image : null,
          };
          if (!value.name && !value.brand) value = null;
        }
      }
    } catch (error) {
      // An outside outage must never block the salon: fall back to "not found" and let them add it.
      this.logger.warn(
        `Open Beauty Facts lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(barcode, { at: Date.now(), value });
    return value;
  }
}

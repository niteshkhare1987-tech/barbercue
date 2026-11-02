import { salonSearchQuerySchema } from '../schemas';

describe('salonSearchQuerySchema', () => {
  it('accepts an empty query (browse-all)', () => {
    expect(salonSearchQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts all filters together', () => {
    const result = salonSearchQuerySchema.safeParse({
      city: 'bengaluru',
      locality: 'indiranagar',
      service: 'haircut',
      q: 'fade',
      limit: '20',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(20); // coerced from string (real query params are always strings)
  });

  it('accepts a service name, independently of the existing service filter', () => {
    const result = salonSearchQuerySchema.safeParse({ serviceName: '  Head Massage  ', service: 'haircut', limit: '8' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serviceName).toBe('Head Massage');
      expect(result.data.service).toBe('haircut');
      expect(result.data.limit).toBe(8);
    }
  });

  it('rejects an empty or unbounded service name', () => {
    expect(salonSearchQuerySchema.safeParse({ serviceName: '   ' }).success).toBe(false);
    expect(salonSearchQuerySchema.safeParse({ serviceName: 'a'.repeat(121) }).success).toBe(false);
  });

  it('rejects a limit above 50', () => {
    expect(salonSearchQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
  });

  it('rejects a non-UUID cursor', () => {
    expect(salonSearchQuerySchema.safeParse({ cursor: 'not-a-uuid' }).success).toBe(false);
  });

  // Part 8/9 — distance + price filters.
  describe('radiusKm / priceMin / priceMax', () => {
    it('accepts and coerces radiusKm, priceMin and priceMax from string query params', () => {
      const result = salonSearchQuerySchema.safeParse({
        lat: '12.9716',
        lng: '77.6412',
        radiusKm: '5',
        priceMin: '200',
        priceMax: '800',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.radiusKm).toBe(5);
        expect(result.data.priceMin).toBe(200);
        expect(result.data.priceMax).toBe(800);
      }
    });

    it('accepts priceMin or priceMax alone', () => {
      expect(salonSearchQuerySchema.safeParse({ priceMin: '100' }).success).toBe(true);
      expect(salonSearchQuerySchema.safeParse({ priceMax: '900' }).success).toBe(true);
    });

    it('rejects priceMin greater than priceMax', () => {
      expect(salonSearchQuerySchema.safeParse({ priceMin: '900', priceMax: '100' }).success).toBe(false);
    });

    it('accepts priceMin equal to priceMax', () => {
      expect(salonSearchQuerySchema.safeParse({ priceMin: '500', priceMax: '500' }).success).toBe(true);
    });

    it('rejects a negative price', () => {
      expect(salonSearchQuerySchema.safeParse({ priceMin: '-1' }).success).toBe(false);
    });

    it('rejects a non-positive radiusKm', () => {
      expect(salonSearchQuerySchema.safeParse({ radiusKm: '0' }).success).toBe(false);
      expect(salonSearchQuerySchema.safeParse({ radiusKm: '-5' }).success).toBe(false);
    });

    it('rejects a radiusKm above the 500km cap', () => {
      expect(salonSearchQuerySchema.safeParse({ radiusKm: '501' }).success).toBe(false);
    });

    it('accepts radiusKm without lat/lng at the schema level (SalonsService ignores it without a query point)', () => {
      expect(salonSearchQuerySchema.safeParse({ radiusKm: '5' }).success).toBe(true);
    });
  });
});

import {
  MenuExtractorFailedError,
  MenuExtractorUnavailableError,
  UnconfiguredMenuExtractor,
  menuExtractorFromEnv,
  parseExtractorJson,
} from './menu-extractor';

describe('menu extraction adapter', () => {
  const original = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  });

  it('is unconfigured without GEMINI_API_KEY and never fabricates rows', async () => {
    delete process.env.GEMINI_API_KEY;
    const extractor = menuExtractorFromEnv();
    expect(extractor).toBeInstanceOf(UnconfiguredMenuExtractor);
    expect(extractor.isConfigured).toBe(false);
    await expect(
      extractor.extract(Buffer.from(''), 'image/jpeg'),
    ).rejects.toBeInstanceOf(MenuExtractorUnavailableError);
  });

  it('keeps missing prices and durations null and flags uncertain prices', () => {
    const rows = parseExtractorJson(
      JSON.stringify({
        services: [
          {
            name: "Men's Haircut",
            price: 150,
            gender: 'MEN',
            confidence: 0.95,
            uncertainFields: [],
          },
          {
            name: 'Facial',
            price: 800,
            priceType: 'STARTS_FROM',
            durationMinutes: 45,
          },
          { name: 'Hair Spa', price: null },
          { name: '', price: 10 },
          { name: 'Bogus', price: -5, durationMinutes: 9999, gender: 'robot' },
        ],
      }),
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      name: "Men's Haircut",
      price: 150,
      gender: 'MEN',
      durationMinutes: null,
    });
    expect(rows[1]).toMatchObject({
      priceType: 'STARTS_FROM',
      durationMinutes: 45,
    });
    expect(rows[2]).toMatchObject({
      price: null,
      uncertainFields: ['basePrice'],
    });
    expect(rows[3]).toMatchObject({
      price: null,
      durationMinutes: null,
      gender: null,
    });
  });

  it('rejects output without a services array', () => {
    expect(() => parseExtractorJson('{"items":[]}')).toThrow(
      MenuExtractorFailedError,
    );
    expect(() => parseExtractorJson('not json')).toThrow();
  });
});

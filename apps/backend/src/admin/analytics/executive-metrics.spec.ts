import { addZonedCalendarDays } from '../../common/timezone/timezone';
import {
  averagePaise,
  cancellationRate,
  classifyAdoption,
  noShowRate,
  previousRange,
  ratePercent,
} from './executive-metrics';

const END = new Date('2026-10-27T18:30:00.000Z'); // end of 27 Oct IST
const daysBefore = (n: number) => new Date(END.getTime() - n * 86_400_000);

const salon = (over: Partial<Parameters<typeof classifyAdoption>[0]> = {}) => ({
  registeredAt: daysBefore(90),
  windowEnd: END,
  visitsInWindow: 0,
  visitsInPreviousWindow: 0,
  visitsEver: 0,
  ...over,
});

describe('classifyAdoption', () => {
  it('gives a salon registered within 7 days time before judging it', () => {
    expect(classifyAdoption(salon({ registeredAt: daysBefore(3) }))).toBe(
      'RECENTLY_ONBOARDED',
    );
  });

  it('registered but never booked -> never activated', () => {
    expect(classifyAdoption(salon())).toBe('NEVER_ACTIVATED');
  });

  it('applies the 20 / 5 / 1 completed-visit thresholds', () => {
    expect(
      classifyAdoption(salon({ visitsEver: 40, visitsInWindow: 20 })),
    ).toBe('HIGHLY_ACTIVE');
    expect(
      classifyAdoption(salon({ visitsEver: 40, visitsInWindow: 19 })),
    ).toBe('MODERATELY_ACTIVE');
    expect(classifyAdoption(salon({ visitsEver: 40, visitsInWindow: 5 }))).toBe(
      'MODERATELY_ACTIVE',
    );
    expect(classifyAdoption(salon({ visitsEver: 40, visitsInWindow: 4 }))).toBe(
      'LOW_USAGE',
    );
    expect(classifyAdoption(salon({ visitsEver: 40, visitsInWindow: 1 }))).toBe(
      'LOW_USAGE',
    );
  });

  it('booked before but nothing in the last 30 days -> dormant', () => {
    expect(
      classifyAdoption(salon({ visitsEver: 3, visitsInPreviousWindow: 3 })),
    ).toBe('DORMANT');
  });

  it('flags a >= 50 % drop only when the previous window had enough volume', () => {
    expect(
      classifyAdoption(
        salon({
          visitsEver: 60,
          visitsInPreviousWindow: 30,
          visitsInWindow: 15,
        }),
      ),
    ).toBe('AT_RISK');
    expect(
      classifyAdoption(
        salon({
          visitsEver: 60,
          visitsInPreviousWindow: 30,
          visitsInWindow: 16,
        }),
      ),
    ).toBe('MODERATELY_ACTIVE');
    // 8 -> 2 is a 75 % drop but below the 10-visit baseline: not enough evidence to call it at risk.
    expect(
      classifyAdoption(
        salon({ visitsEver: 10, visitsInPreviousWindow: 8, visitsInWindow: 2 }),
      ),
    ).toBe('LOW_USAGE');
    // A shop that stopped completely after a strong month is at risk, not merely dormant.
    expect(
      classifyAdoption(
        salon({
          visitsEver: 30,
          visitsInPreviousWindow: 30,
          visitsInWindow: 0,
        }),
      ),
    ).toBe('AT_RISK');
  });
});

describe('rates and averages', () => {
  it('uses only resolved outcomes as the denominator', () => {
    expect(cancellationRate({ completed: 7, cancelled: 2, noShow: 1 })).toBe(
      20,
    );
    expect(noShowRate({ completed: 7, cancelled: 2, noShow: 1 })).toBe(12.5);
  });

  it('reports "not measurable" instead of 0 % when nothing resolved', () => {
    expect(
      cancellationRate({ completed: 0, cancelled: 0, noShow: 0 }),
    ).toBeNull();
    expect(noShowRate({ completed: 0, cancelled: 3, noShow: 0 })).toBeNull();
    expect(ratePercent(0, 0)).toBeNull();
    expect(averagePaise(1000, 0)).toBeNull();
  });

  it('rounds averages to whole paise and rates to one decimal', () => {
    expect(averagePaise(1000, 3)).toBe(333);
    expect(ratePercent(1, 3)).toBe(33.3);
  });
});

describe('previousRange', () => {
  it('is the equally long block of days right before the selection', () => {
    expect(
      previousRange('2026-10-27', '2026-10-27', addZonedCalendarDays),
    ).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(
      previousRange('2026-10-21', '2026-10-27', addZonedCalendarDays),
    ).toEqual({ from: '2026-10-14', to: '2026-10-20' });
    expect(
      previousRange('2026-03-01', '2026-03-31', addZonedCalendarDays),
    ).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });
});

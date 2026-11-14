import { CreditTransactionType, type CustomerCreditTransactionDto } from "@barbercue/shared";

// Rewards page totals, derived only from the customer's own credit ledger rows. The balance itself
// always comes from GET credits/balance (server truth); these are descriptive totals of the rows given.

export interface CreditSummary {
  earned: number;
  redeemed: number;
  expiringSoon: number;
}

const DAY = 86_400_000;

export function summarizeCredits(rows: CustomerCreditTransactionDto[], now: Date, windowDays = 30): CreditSummary {
  let earned = 0;
  let redeemed = 0;
  let expiringSoon = 0;
  for (const row of rows) {
    if (row.type === CreditTransactionType.PROMO_GRANT || row.type === CreditTransactionType.RESTORED) {
      earned += row.amount;
      const remaining = row.remainingAmount ?? 0;
      if (row.expiresAt && remaining > 0) {
        const left = new Date(row.expiresAt).getTime() - now.getTime();
        if (left > 0 && left <= windowDays * DAY) expiringSoon += remaining;
      }
    } else if (row.type === CreditTransactionType.REDEEMED) {
      redeemed += row.amount;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { earned: round(earned), redeemed: round(redeemed), expiringSoon: round(expiringSoon) };
}

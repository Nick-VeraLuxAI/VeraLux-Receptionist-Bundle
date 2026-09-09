/** Monthly host bundle in US cents (2 web + Postgres + Redis). Free tiers omitted. */

const MONTHLY_CENTS: Record<string, Record<string, number>> = {
  render: { starter: 2800, standard: 13000, pro: 40000 },
  railway: { hobby: 2000, pro: 5000 },
  aws: { fargate_small: 3000, fargate_medium: 8000 },
};

export function quoteHostMonthlyCents(host: string, size: string, _region?: string): number {
  return MONTHLY_CENTS[host]?.[size] ?? 0;
}

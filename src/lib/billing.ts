import type {
  BillingPeriodWithProperty,
  Cost,
  CostCategory,
  Prepayment,
} from "@/types";

// Per-period override (Cost.distributionKeyOverride) takes precedence over
// the category default. Used wherever calculation or display needs the
// effective key for a given billing period.
export function effectiveDistributionKey(
  cost: { distributionKeyOverride?: string | null },
  category: Pick<CostCategory, "distributionKey">
): string {
  return cost.distributionKeyOverride ?? category.distributionKey;
}

export function getBillingStatus(bp: BillingPeriodWithProperty) {
  if (bp.paidDate) {
    return { label: "Bezahlt", className: "bg-green-100 text-green-700" };
  }
  if (bp.sentDate) {
    return { label: "Versendet", className: "bg-blue-100 text-blue-700" };
  }
  if (bp.billingDate) {
    return { label: "Abgeschlossen", className: "bg-emerald-100 text-emerald-700" };
  }
  if (bp._count && bp._count.costs > 0) {
    return { label: "In Bearbeitung", className: "bg-amber-100 text-amber-700" };
  }
  return { label: "Offen", className: "bg-zinc-100 text-zinc-600" };
}

export function getUnreviewedCount(
  costs: Cost[],
  prepayments: Prepayment[]
): number {
  // Disabled positions are skipped in calculations, so they should not
  // block the review progress either.
  const unreviewedCosts = costs.filter((c) => c.enabled !== false && !c.reviewed)
    .length;
  const unreviewedPrepayments = prepayments.filter((p) => !p.reviewed).length;
  return unreviewedCosts + unreviewedPrepayments;
}

// --- Unit share calculation ---
//
// Single source of truth for "Ihr Anteil" — used by the billing page, the
// overview cards, the dashboard, the PDF and the tenant app. MEA shares are
// never persisted (Cost.unitAmount stays null for MEA); they are always
// derived here from the total amount, the unit's shares and the tenant's
// occupancy within the billing period.

type DateLike = string | Date;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Day index since epoch. Rounding absorbs dates stored at local midnight
// (e.g. 2025-10-31T23:00Z for 1.11. in CET) as well as UTC midnight.
function dayNumber(date: DateLike): number {
  return Math.round(new Date(date).getTime() / MS_PER_DAY);
}

function dateFromDayNumber(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BillingTenant {
  id: string;
  moveInDate: DateLike;
  moveOutDate: DateLike | null;
}

export interface BillingUnit<T extends BillingTenant = BillingTenant> {
  id: string;
  shares: number;
  tenants?: T[];
}

export interface BillingCost {
  totalAmount: number;
  unitAmount: number | null;
  enabled?: boolean;
  distributionKeyOverride?: string | null;
  costCategory: Pick<CostCategory, "distributionKey">;
}

export interface BillingInput {
  startDate: DateLike;
  endDate: DateLike;
  property: { totalShares: number };
  costs: BillingCost[];
  prepayments: { unitId: string; monthlyAmount: number }[];
}

export interface Occupancy {
  from: Date;
  to: Date;
  days: number;
  totalDays: number;
  // Share of the billing period the tenant lived in the unit (0..1).
  factor: number;
  // Calendar months touched by the occupancy — basis for prepayments.
  months: number;
}

// Time share of a tenant within the billing period. Without a tenant the
// whole period counts (unit is billed as a whole, e.g. owner-occupied).
export function getOccupancy(
  tenant: Pick<BillingTenant, "moveInDate" | "moveOutDate"> | null,
  startDate: DateLike,
  endDate: DateLike
): Occupancy {
  const start = dayNumber(startDate);
  const end = dayNumber(endDate);
  const totalDays = Math.max(1, end - start + 1);

  const from = tenant ? Math.max(start, dayNumber(tenant.moveInDate)) : start;
  const to =
    tenant && tenant.moveOutDate
      ? Math.min(end, dayNumber(tenant.moveOutDate))
      : end;
  const days = Math.max(0, to - from + 1);

  const fromDate = dateFromDayNumber(from);
  const toDate = dateFromDayNumber(to);
  const months =
    days === 0
      ? 0
      : (toDate.getUTCFullYear() - fromDate.getUTCFullYear()) * 12 +
        (toDate.getUTCMonth() - fromDate.getUTCMonth()) +
        1;

  return {
    from: fromDate,
    to: toDate,
    days,
    totalDays,
    factor: Math.min(1, days / totalDays),
    months,
  };
}

// Tenants whose lease overlaps the billing period, oldest first.
export function getTenantsInPeriod<T extends BillingTenant>(
  tenants: T[] | undefined,
  startDate: DateLike,
  endDate: DateLike
): T[] {
  return (tenants ?? [])
    .filter((t) => getOccupancy(t, startDate, endDate).days > 0)
    .sort((a, b) => dayNumber(a.moveInDate) - dayNumber(b.moveInDate));
}

// Unit share of a single cost position. MEA is derived from the shares and
// prorated by occupancy; all other keys use the manually entered amount.
export function calculateCostShare(
  cost: BillingCost,
  unitShares: number,
  propertyTotalShares: number,
  occupancyFactor = 1
): number {
  const key = effectiveDistributionKey(cost, cost.costCategory);
  if (key.toUpperCase() === "MEA") {
    return round2(
      calculateMEAAmount(cost.totalAmount, unitShares, propertyTotalShares) *
        occupancyFactor
    );
  }
  return cost.unitAmount ?? 0;
}

// Billing result for one tenant (or a unit without tenant).
export function calculateTenantBilling<C extends BillingCost>(
  billing: Omit<BillingInput, "costs"> & { costs: C[] },
  unit: Pick<BillingUnit, "id" | "shares">,
  tenant: Pick<BillingTenant, "moveInDate" | "moveOutDate"> | null
) {
  const occupancy = getOccupancy(tenant, billing.startDate, billing.endDate);
  const activeCosts = billing.costs.filter((c) => c.enabled !== false);
  const lines = activeCosts.map((cost) => ({
    cost,
    distributionKey: effectiveDistributionKey(cost, cost.costCategory),
    totalAmount: cost.totalAmount,
    unitAmount: calculateCostShare(
      cost,
      unit.shares,
      billing.property.totalShares,
      occupancy.factor
    ),
  }));
  const totalCosts = round2(lines.reduce((sum, l) => sum + l.totalAmount, 0));
  const totalUnitCosts = round2(lines.reduce((sum, l) => sum + l.unitAmount, 0));
  const monthly =
    billing.prepayments.find((p) => p.unitId === unit.id)?.monthlyAmount ?? 0;
  const totalPrepayment = round2(monthly * occupancy.months);
  // Positive = Erstattung, negative = Nachzahlung.
  const difference = round2(totalPrepayment - totalUnitCosts);
  return {
    occupancy,
    lines,
    totalCosts,
    totalUnitCosts,
    monthlyPrepayment: monthly,
    totalPrepayment,
    difference,
  };
}

// One billing party per tenant living in a unit during the period; units
// without any tenant in the period appear once with `tenant: null`.
export function getBillingParties<U extends BillingUnit>(
  units: U[],
  startDate: DateLike,
  endDate: DateLike
): { unit: U; tenant: NonNullable<U["tenants"]>[number] | null }[] {
  type T = NonNullable<U["tenants"]>[number];
  return units.flatMap((unit): { unit: U; tenant: T | null }[] => {
    const tenants = getTenantsInPeriod(unit.tenants, startDate, endDate);
    return tenants.length > 0
      ? tenants.map((tenant) => ({ unit, tenant }))
      : [{ unit, tenant: null }];
  });
}

// Totals across all billing parties of a period (overview cards, dashboard).
export function calculateBillingTotals(
  billing: BillingInput & { property: { units?: BillingUnit[] } }
) {
  const parties = getBillingParties(
    billing.property.units ?? [],
    billing.startDate,
    billing.endDate
  );
  const results = parties.map(({ unit, tenant }) =>
    calculateTenantBilling(billing, unit, tenant)
  );
  const totalCosts = round2(
    billing.costs
      .filter((c) => c.enabled !== false)
      .reduce((sum, c) => sum + c.totalAmount, 0)
  );
  const totalUnitCosts = round2(
    results.reduce((sum, r) => sum + r.totalUnitCosts, 0)
  );
  const totalPrepayment = round2(
    results.reduce((sum, r) => sum + r.totalPrepayment, 0)
  );
  const difference = round2(totalPrepayment - totalUnitCosts);
  return { totalCosts, totalUnitCosts, totalPrepayment, difference };
}

export function calculateMEAAmount(
  totalAmount: number,
  unitShares: number,
  propertyTotalShares: number
): number {
  if (propertyTotalShares === 0) return 0;
  return totalAmount * (unitShares / propertyTotalShares);
}

export function getMonthsInPeriod(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth()) +
    1;
  return Math.max(1, months);
}

export function getDaysInPeriod(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// Recommended new monthly NK prepayment after a billing period that closes
// with a shortfall (Nachzahlung): keep the current monthly amount and add the
// shortfall spread over the months it accrued in (twelve for a full year,
// fewer for a tenant who moved in during the period), rounded up to the next
// 5-EUR step. If the period closes with a refund, no change is suggested
// (returns null).
export function suggestNextPrepayment(
  currentMonthly: number,
  resultAmount: number,
  months = 12
): number | null {
  if (resultAmount <= 0) return null;
  const raw = currentMonthly + resultAmount / Math.max(1, months);
  return Math.ceil(raw / 5) * 5;
}

// Default effective date for a new prepayment that follows a closed billing
// period: the day after the period ends.
export function dayAfter(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

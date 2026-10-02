import { describe, it, expect } from "vitest";
import {
  calculateBillingTotals,
  calculateTenantBilling,
  getBillingParties,
  getOccupancy,
  suggestNextPrepayment,
} from "@/lib/billing";

const mea = { distributionKey: "MEA" };
const anlage = { distributionKey: "siehe Anlage" };

const unit = { id: "u1", shares: 78 };
const tenant = {
  id: "t1",
  moveInDate: "2025-11-01T00:00:00.000Z",
  moveOutDate: null,
};

function billing(startDate: string, endDate: string) {
  return {
    startDate,
    endDate,
    property: { totalShares: 10000, units: [{ ...unit, tenants: [tenant] }] },
    costs: [
      { totalAmount: 12135.36, unitAmount: null, costCategory: mea },
      { totalAmount: 428.4, unitAmount: null, costCategory: mea },
      { totalAmount: 500, unitAmount: 42.5, costCategory: anlage },
      {
        totalAmount: 999,
        unitAmount: null,
        enabled: false,
        costCategory: mea,
      },
    ],
    prepayments: [{ unitId: "u1", monthlyAmount: 138 }],
  };
}

describe("getOccupancy", () => {
  it("covers the full period without tenant", () => {
    const occ = getOccupancy(null, "2025-01-01", "2025-12-31");
    expect(occ.days).toBe(365);
    expect(occ.factor).toBe(1);
    expect(occ.months).toBe(12);
  });

  it("clips to move-in date", () => {
    const occ = getOccupancy(tenant, "2025-01-01", "2025-12-31");
    expect(occ.days).toBe(61);
    expect(occ.totalDays).toBe(365);
    expect(occ.months).toBe(2);
    expect(occ.from.toISOString().slice(0, 10)).toBe("2025-11-01");
  });

  it("clips to move-out date", () => {
    const occ = getOccupancy(
      { moveInDate: "2020-01-01", moveOutDate: "2025-03-31" },
      "2025-01-01",
      "2025-12-31"
    );
    expect(occ.days).toBe(90);
    expect(occ.months).toBe(3);
  });

  it("tolerates dates stored at local midnight (CET)", () => {
    const occ = getOccupancy(
      { moveInDate: "2025-10-31T23:00:00.000Z", moveOutDate: null },
      "2024-12-31T23:00:00.000Z",
      "2025-12-30T23:00:00.000Z"
    );
    expect(occ.days).toBe(61);
  });
});

describe("calculateTenantBilling", () => {
  it("derives MEA shares instead of reading unitAmount (0-€ bug)", () => {
    const r = calculateTenantBilling(
      billing("2025-11-01", "2025-12-31"),
      unit,
      tenant
    );
    // 12135.36 * 78/10000 = 94.66, 428.4 * 78/10000 = 3.34, + 42.50 manual
    expect(r.lines.map((l) => l.unitAmount)).toEqual([94.66, 3.34, 42.5]);
    expect(r.totalUnitCosts).toBe(140.5);
    expect(r.totalPrepayment).toBe(276);
    expect(r.difference).toBe(135.5);
  });

  it("prorates MEA costs by occupancy, keeps manual amounts", () => {
    const r = calculateTenantBilling(
      billing("2025-01-01", "2025-12-31"),
      unit,
      tenant
    );
    // 94.6558 * 61/365 = 15.82, 3.3415 * 61/365 = 0.56
    expect(r.lines.map((l) => l.unitAmount)).toEqual([15.82, 0.56, 42.5]);
    expect(r.totalPrepayment).toBe(276);
    expect(r.occupancy.factor).toBeCloseTo(61 / 365);
  });

  it("respects a per-period distribution key override", () => {
    const bp = billing("2025-01-01", "2025-12-31");
    bp.costs[0] = {
      ...bp.costs[0],
      unitAmount: 10,
      distributionKeyOverride: "siehe Anlage",
    } as (typeof bp.costs)[number];
    const r = calculateTenantBilling(bp, unit, tenant);
    expect(r.lines[0].unitAmount).toBe(10);
  });
});

describe("getBillingParties / calculateBillingTotals", () => {
  it("splits a unit between consecutive tenants", () => {
    const units = [
      {
        id: "u1",
        shares: 78,
        tenants: [
          { id: "new", moveInDate: "2025-11-01", moveOutDate: null },
          { id: "old", moveInDate: "2019-01-01", moveOutDate: "2025-06-30" },
          { id: "older", moveInDate: "2010-01-01", moveOutDate: "2018-12-31" },
        ],
      },
    ];
    const parties = getBillingParties(units, "2025-01-01", "2025-12-31");
    expect(parties.map((p) => p.tenant?.id)).toEqual(["old", "new"]);
  });

  it("sums tenant shares for the overview", () => {
    const totals = calculateBillingTotals(billing("2025-11-01", "2025-12-31"));
    expect(totals.totalCosts).toBe(13063.76);
    expect(totals.totalUnitCosts).toBe(140.5);
    expect(totals.totalPrepayment).toBe(276);
    expect(totals.difference).toBe(135.5);
  });
});

describe("suggestNextPrepayment", () => {
  it("spreads the shortfall over the occupied months", () => {
    expect(suggestNextPrepayment(100, 120)).toBe(110);
    expect(suggestNextPrepayment(100, 120, 2)).toBe(160);
    expect(suggestNextPrepayment(100, -5)).toBeNull();
  });
});

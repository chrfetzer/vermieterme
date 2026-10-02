import { apiHandler, jsonOk } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { calculateTenantBilling } from "@/lib/billing";

export function GET() {
  return apiHandler(async () => {
    const { tenantId, unitId } = await requireTenantAuth();

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { unit: true },
    });

    if (!tenant) {
      return jsonOk([]);
    }

    const billingPeriods = await prisma.billingPeriod.findMany({
      where: { propertyId: tenant.unit.propertyId },
      include: {
        property: true,
        costs: { include: { costCategory: true } },
        prepayments: { where: { unitId } },
        _count: { select: { costs: true } },
      },
      orderBy: { startDate: "desc" },
    });

    const result = billingPeriods.map((bp) => {
      const totals = calculateTenantBilling(bp, tenant.unit, tenant);

      return {
        id: bp.id,
        startDate: bp.startDate,
        endDate: bp.endDate,
        billingDate: bp.billingDate,
        sentDate: bp.sentDate,
        paidDate: bp.paidDate,
        property: {
          street: bp.property.street,
          zip: bp.property.zip,
          city: bp.property.city,
        },
        totalUnitCosts: totals.totalUnitCosts,
        totalPrepayment: totals.totalPrepayment,
        difference: totals.difference,
      };
    });

    return jsonOk(result);
  });
}

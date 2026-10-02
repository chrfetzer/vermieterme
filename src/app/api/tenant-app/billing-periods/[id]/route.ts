import { apiHandler, ApiError, jsonOk } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { calculateTenantBilling } from "@/lib/billing";
import { NextRequest } from "next/server";

export function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    const { tenantId, unitId } = await requireTenantAuth();
    const { id } = await params;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { unit: { include: { property: true } } },
    });

    if (!tenant) {
      throw new ApiError("Mieter nicht gefunden", 404);
    }

    const bp = await prisma.billingPeriod.findUnique({
      where: { id },
      include: {
        property: true,
        costs: { include: { costCategory: true } },
        prepayments: { where: { unitId } },
        documents: true,
      },
    });

    if (!bp || bp.propertyId !== tenant.unit.propertyId) {
      throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
    }

    const totals = calculateTenantBilling(bp, tenant.unit, tenant);

    const costs = totals.lines.map(({ cost, distributionKey, unitAmount }) => ({
      id: cost.id,
      category: cost.costCategory.name,
      distributionKey,
      totalAmount: cost.totalAmount,
      unitAmount,
    }));

    const documents = bp.documents.map((doc) => ({
      id: doc.id,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      category: doc.category,
      createdAt: doc.createdAt,
    }));

    return jsonOk({
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
      costs,
      prepayments: bp.prepayments.map((p) => ({
        id: p.id,
        monthlyAmount: p.monthlyAmount,
      })),
      totals: {
        totalCosts: totals.totalCosts,
        totalUnitCosts: totals.totalUnitCosts,
        totalPrepayment: totals.totalPrepayment,
        difference: totals.difference,
      },
      documents,
    });
  });
}

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { getDefaultConfig } from "@/lib/pdf-template";
import type { PdfTemplateConfig } from "@/types/pdf-template";
import { BillingPdf } from "@/lib/billing-pdf";
import { calculateTenantBilling, getBillingParties } from "@/lib/billing";

// --- Route Handler ---

export async function GET(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return new Response(JSON.stringify({ error: "Nicht angemeldet" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { id } = await paramsPromise;

    // Load PDF template config
    const templateRow = await prisma.pdfTemplate.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    const templateConfig: PdfTemplateConfig = templateRow
      ? JSON.parse(templateRow.config)
      : getDefaultConfig();

    // Fetch billing period with all related data
    const billingPeriod = await prisma.billingPeriod.findUnique({
      where: { id },
      include: {
        property: {
          include: {
            units: {
              include: {
                tenants: true,
                prepayments: {
                  where: { billingPeriodId: id },
                },
              },
            },
          },
        },
        costs: {
          include: {
            costCategory: true,
          },
          orderBy: {
            costCategory: {
              sortOrder: "asc",
            },
          },
        },
      },
    });

    if (!billingPeriod) {
      return new Response(
        JSON.stringify({ error: "Billing period not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const landlord = await prisma.landlordInfo.findFirst();

    if (!landlord) {
      return new Response(
        JSON.stringify({ error: "Landlord info not configured" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const property = billingPeriod.property;
    const startDate = new Date(billingPeriod.startDate);

    // Optional ?tenantId= selects the recipient when several tenants lived in
    // the property during the period; defaults to the first one found.
    const requestedTenantId = new URL(request.url).searchParams.get("tenantId");
    const party = getBillingParties(
      property.units,
      billingPeriod.startDate,
      billingPeriod.endDate
    ).find(
      (p) =>
        p.tenant !== null &&
        (requestedTenantId === null || p.tenant.id === requestedTenantId)
    );

    if (!party || !party.tenant) {
      return new Response(
        JSON.stringify({
          error: "No active tenant found for this billing period",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const targetUnit = party.unit;
    const activeTenant = party.tenant;
    const result = calculateTenantBilling(
      { ...billingPeriod, prepayments: targetUnit.prepayments },
      targetUnit,
      activeTenant
    );
    const costs = result.lines.map((line) => ({
      categoryName: line.cost.costCategory.name,
      distributionKey: line.distributionKey,
      totalAmount: line.totalAmount,
      unitAmount: line.unitAmount,
    }));

    const year = startDate.getFullYear();

    const buffer = await renderToBuffer(
      <BillingPdf
        landlord={landlord}
        property={property}
        billingPeriod={billingPeriod}
        unit={targetUnit}
        tenant={activeTenant}
        costs={costs}
        totalCosts={result.totalCosts}
        totalUnitCosts={result.totalUnitCosts}
        totalPrepayment={result.totalPrepayment}
        occupancy={result.occupancy}
        templateConfig={templateConfig}
      />
    );

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Betriebskostenabrechnung-${year}.pdf"`,
      },
    });
  } catch (error) {
    console.error("Failed to generate billing PDF:", error);
    return new Response(
      JSON.stringify({ error: "Failed to generate PDF" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

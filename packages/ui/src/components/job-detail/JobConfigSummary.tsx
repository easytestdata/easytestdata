import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
  formatCurrency,
  formatNumber,
  formatDateRange,
  countryName,
  formatTemplateName
} from "../../lib/format";

interface JobConfigSummaryProps {
  config: Record<string, unknown>;
  type: string;
}

function DL({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}

function DT({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted-foreground">{children}</dt>;
}

function DD({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={cn("font-medium", className)}>{children}</dd>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <DT>{label}</DT>
      <DD>{children}</DD>
    </>
  );
}

export function JobConfigSummary({ config, type }: JobConfigSummaryProps) {
  const templateId = config.templateId as string | undefined;
  const companyName = config.companyName as string | undefined;
  const tag = config.tag as string | undefined;
  const purgeMode = config.purgeMode as string | undefined;
  const templateLabel = templateId ? formatTemplateName(templateId) : undefined;

  if (type === "purge") {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Configuration</h4>
        <DL>
          {companyName ? <Row label="Company">{companyName}</Row> : null}
          {tag ? (
            <Row label="Tag">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tag}</code>
            </Row>
          ) : null}
          {purgeMode ? (
            <Row label="Removes">
              {purgeMode === "all"
                ? "Every transaction of the types EasyTestData loads, including yours; customers, vendors, employees and items made inactive; accounts kept"
                : "EasyTestData's transactions; its customers, vendors, employees and items made inactive; accounts kept"}
            </Row>
          ) : null}
        </DL>
      </div>
    );
  }

  if (type === "rollback") {
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Configuration</h4>
        <DL>{companyName ? <Row label="Company">{companyName}</Row> : null}</DL>
      </div>
    );
  }

  // generate / load / export: the job's snapshot of the normalized scenario config.
  const num = (key: string) =>
    typeof config[key] === "number" ? (config[key] as number) : undefined;
  const revenue = num("totalRevenue");
  const ebitda = num("targetEbitda");
  const months = num("months");
  const startDate = config.startDate as string | undefined;
  const endDate = config.endDate as string | undefined;
  const customers = num("customerCount");
  const employees = num("employeeCount");
  const country = config.country as string | undefined;
  const preset = config.presetId as string | undefined;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Configuration</h4>
      <DL>
        {templateLabel ? (
          <Row label="Industry">
            <Badge variant="outline" className="text-xs">
              {templateLabel}
            </Badge>
          </Row>
        ) : null}
        {preset ? (
          <>
            <DT>Scenario</DT>
            <DD className="capitalize">{preset.replace(/-/g, " ")}</DD>
          </>
        ) : null}
        {startDate || endDate ? (
          <Row label="Date range">{formatDateRange(startDate, endDate)}</Row>
        ) : null}
        {months != null ? <Row label="Months">{months}</Row> : null}
        {revenue != null ? <Row label="Revenue target">{formatCurrency(revenue)}</Row> : null}
        {ebitda != null ? <Row label="Profit target">{formatCurrency(ebitda)}</Row> : null}
        {customers != null ? <Row label="Customers">{formatNumber(customers)}</Row> : null}
        {employees != null ? <Row label="Employees">{formatNumber(employees)}</Row> : null}
        {country ? <Row label="Country">{countryName(country)}</Row> : null}
        {tag ? (
          <Row label="Tag">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tag}</code>
          </Row>
        ) : null}
        {companyName ? <Row label="Company">{companyName}</Row> : null}
      </DL>
    </div>
  );
}

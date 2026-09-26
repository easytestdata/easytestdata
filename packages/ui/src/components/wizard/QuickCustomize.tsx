import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { QboConnection } from "../../types";
import type { ScenarioFormState } from "../scenario-config/useScenarioForm";

interface QuickCustomizeProps {
  form: ScenarioFormState;
  setField: <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => void;
  connections: QboConnection[];
  showConnection?: boolean;
}

export function QuickCustomize({
  form,
  setField,
  connections,
  showConnection = true
}: QuickCustomizeProps) {
  return (
    <div className="space-y-4 rounded-xl border bg-muted/30 p-4">
      <h3 className="text-sm font-medium text-muted-foreground">Period and size</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wiz-start" className="text-xs">
            Start date
          </Label>
          <Input
            id="wiz-start"
            type="date"
            value={form.startDate}
            onChange={(e) => setField("startDate", e.target.value)}
            className="h-9"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wiz-end" className="text-xs">
            End date
          </Label>
          <Input
            id="wiz-end"
            type="date"
            value={form.endDate}
            onChange={(e) => setField("endDate", e.target.value)}
            className="h-9"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wiz-revenue" className="text-xs">
            Revenue for the period ($)
          </Label>
          <Input
            id="wiz-revenue"
            type="number"
            value={form.totalRevenue}
            onChange={(e) => setField("totalRevenue", e.target.value)}
            className="h-9"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wiz-customers" className="text-xs">
            Customers
          </Label>
          <Input
            id="wiz-customers"
            type="number"
            min={1}
            max={300}
            value={form.customerCount}
            onChange={(e) => setField("customerCount", e.target.value)}
            className="h-9"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wiz-employees" className="text-xs">
            Employees
          </Label>
          <Input
            id="wiz-employees"
            type="number"
            min={0}
            // core's MAX_EMPLOYEES: the server refuses more
            max={50}
            value={form.employeeCount}
            onChange={(e) => setField("employeeCount", e.target.value)}
            className="h-9"
          />
        </div>
        {showConnection && connections.length > 1 && (
          <div className="grid gap-1.5">
            <Label className="text-xs">QuickBooks sandbox</Label>
            <Select value={form.connectionId} onValueChange={(v) => setField("connectionId", v)}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select connection..." />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.company_name || c.realm_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

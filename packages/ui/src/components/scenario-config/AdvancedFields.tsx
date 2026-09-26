import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { RatioInput } from "./RatioInput";
import { RATIO_TAB_LABELS, getFieldsByTab, type RatioTab } from "./ratio-defaults";

const TABS: RatioTab[] = ["revenue", "expenses", "adjustments", "banking", "payroll"];

interface AdvancedFieldsProps {
  ratioOverrides: Record<string, string>;
  setRatio: (key: string, value: string) => void;
  overrideCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdvancedFields({
  ratioOverrides,
  setRatio,
  overrideCount,
  open,
  onOpenChange
}: AdvancedFieldsProps) {
  const [activeTab, setActiveTab] = useState<RatioTab>("revenue");

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex items-center gap-2">
          Advanced Settings
          {overrideCount > 0 && (
            <Badge variant="secondary" className="text-xs">
              {overrideCount} override{overrideCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as RatioTab)}>
            <TabsList className="w-full flex-wrap h-auto gap-1">
              {TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab} className="text-xs px-2 py-1">
                  {RATIO_TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>

            {TABS.map((tab) => {
              const fields = getFieldsByTab(tab);
              return (
                <TabsContent key={tab} value={tab}>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-2">
                    {fields.map((f) => (
                      <RatioInput
                        key={f.key}
                        label={f.label}
                        field={f.key}
                        defaultValue={f.default}
                        type={f.type}
                        value={ratioOverrides[f.key] || ""}
                        onChange={setRatio}
                        hint={f.hint}
                      />
                    ))}
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        </div>
      )}
    </div>
  );
}

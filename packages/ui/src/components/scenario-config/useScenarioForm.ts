import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { QboConnection, ScenarioPresetDetail } from "../../types";
import { RATIO_FIELDS } from "./ratio-defaults";
import { defaultPeriod } from "../../lib/period";

export interface ScenarioFormState {
  templateId: string;
  presetId: string;
  connectionId: string;
  country: string;
  startDate: string;
  endDate: string;
  totalRevenue: string;
  targetEbitda: string;
  customerCount: string;
  topCustomerCount: string;
  clientConcentrationPercent: string;
  employeeCount: string;
  includeBenefits: boolean;
  tag: string;
  /** "all" is reserved for the dashboard's Erase all data action; the load flow never sets it. */
  purgeMode: "none" | "generated" | "all";
  ratioOverrides: Record<string, string>;
}

/** The first-run defaults: a healthy professional-services firm over the last 12 months. */
export const DEFAULT_TEMPLATE_ID = "professional-services";
export const DEFAULT_PRESET_ID = "healthy-small";

const DEFAULT_STATE: ScenarioFormState = {
  templateId: DEFAULT_TEMPLATE_ID,
  presetId: DEFAULT_PRESET_ID,
  connectionId: "",
  country: "US",
  startDate: "",
  endDate: "",
  // Match @easytestdata/core DEFAULT_REQUEST so the web, CLI, and API agree.
  totalRevenue: "500000",
  targetEbitda: "100000",
  customerCount: "15",
  topCustomerCount: "3",
  clientConcentrationPercent: "40",
  employeeCount: "5",
  includeBenefits: false,
  tag: "",
  purgeMode: "none",
  ratioOverrides: {}
};

export function useScenarioForm(
  open: boolean,
  connections: QboConnection[],
  fetchPreset: (id: string) => Promise<ScenarioPresetDetail>
) {
  const [form, setForm] = useState<ScenarioFormState>(DEFAULT_STATE);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const setField = useCallback(
    <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => {
      setForm((prev) => {
        const next = { ...prev, [key]: value };
        // Auto-clamp topCustomerCount when customerCount is lowered
        if (key === "customerCount" && next.topCustomerCount) {
          const cc = Number(next.customerCount);
          const tcc = Number(next.topCustomerCount);
          if (cc > 0 && tcc > cc) {
            next.topCustomerCount = String(cc);
          }
        }
        // Auto-clamp targetEbitda when totalRevenue is lowered
        if (key === "totalRevenue" && next.targetEbitda) {
          const rev = Number(next.totalRevenue);
          const ebitda = Number(next.targetEbitda);
          if (rev > 0 && ebitda > rev) {
            next.targetEbitda = String(rev);
          }
        }
        // Auto-clamp endDate when startDate moves past it
        if (key === "startDate" && next.endDate && next.startDate > next.endDate) {
          next.endDate = next.startDate;
        }
        return next;
      });
    },
    []
  );

  const setRatio = useCallback((key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      ratioOverrides: { ...prev.ratioOverrides, [key]: value }
    }));
  }, []);

  // Preset responses can arrive out of order; only the latest choice may apply its values.
  const presetRequest = useRef(0);
  const applyPreset = useCallback(
    async (id: string) => {
      const request = ++presetRequest.current;
      setField("presetId", id);
      if (!id || id === "none") return;
      try {
        const preset = await fetchPreset(id);
        if (request !== presetRequest.current) return; // a later choice (or "None") superseded it
        setForm((prev) => {
          const req = preset.request || {};
          const ratios: Record<string, string> = {};
          if (preset.ratioOverrides) {
            for (const [k, v] of Object.entries(preset.ratioOverrides)) {
              ratios[k] = String(v);
            }
          }
          const merged = {
            ...prev,
            presetId: id,
            // A scenario is a package: its period (quick demo = 3 months) comes with it.
            ...defaultPeriod(new Date(), preset.months ?? 12),
            totalRevenue: req.totalRevenue != null ? String(req.totalRevenue) : prev.totalRevenue,
            targetEbitda: req.targetEbitda != null ? String(req.targetEbitda) : prev.targetEbitda,
            customerCount:
              req.customerCount != null ? String(req.customerCount) : prev.customerCount,
            topCustomerCount:
              req.topCustomerCount != null ? String(req.topCustomerCount) : prev.topCustomerCount,
            clientConcentrationPercent:
              req.clientConcentrationPercent != null
                ? String(req.clientConcentrationPercent)
                : prev.clientConcentrationPercent,
            employeeCount:
              req.employeeCount != null ? String(req.employeeCount) : prev.employeeCount,
            includeBenefits:
              req.includeBenefits != null ? Boolean(req.includeBenefits) : prev.includeBenefits,
            ratioOverrides: ratios
          };
          // Clamp dependent fields
          const cc = Number(merged.customerCount);
          const tcc = Number(merged.topCustomerCount);
          if (cc > 0 && tcc > cc) {
            merged.topCustomerCount = String(cc);
          }
          const rev = Number(merged.totalRevenue);
          const ebitda = Number(merged.targetEbitda);
          if (rev > 0 && ebitda > rev) {
            merged.targetEbitda = String(rev);
          }
          return merged;
        });
      } catch {
        // Preset fetch failed — keep presetId set, ignore error
      }
    },
    [setField, fetchPreset]
  );

  const resetForm = useCallback(
    (conns?: QboConnection[]) => {
      const effectiveConns = conns || connections;
      setForm({
        ...DEFAULT_STATE,
        connectionId: effectiveConns[0]?.id || "",
        ...defaultPeriod()
      });
      setAdvancedOpen(false);
      void applyPreset(DEFAULT_PRESET_ID);
    },
    [connections, applyPreset]
  );

  // Reset when the form opens, not when the connection list refetches (a sandbox added
  // elsewhere, last_used_at moving): that would wipe what the user entered.
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  useEffect(() => {
    if (open) {
      resetForm(connectionsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the chosen sandbox valid as the list changes: fill it in once connections load, and
  // move off one that was removed. Everything else the user entered stays.
  useEffect(() => {
    setForm((current) => {
      if (current.connectionId && connections.some((c) => c.id === current.connectionId)) {
        return current;
      }
      const next = connections[0]?.id || "";
      return next === current.connectionId ? current : { ...current, connectionId: next };
    });
  }, [connections]);

  const overrideCount = useMemo(() => {
    return Object.values(form.ratioOverrides).filter((v) => v !== "").length;
  }, [form.ratioOverrides]);

  const serializeConfig = useCallback((): {
    template: string;
    config: Record<string, unknown>;
  } => {
    const filteredOverrides: Record<string, number> = {};
    for (const [key, val] of Object.entries(form.ratioOverrides)) {
      if (val !== "") {
        const def = RATIO_FIELDS.find((f) => f.key === key);
        if (def) {
          filteredOverrides[key] = Number(val);
        }
      }
    }

    const config: Record<string, unknown> = {
      templateId: form.templateId,
      startDate: form.startDate,
      endDate: form.endDate,
      totalRevenue: Number(form.totalRevenue),
      customerCount: Number(form.customerCount),
      employeeCount: Number(form.employeeCount),
      includeBenefits: form.includeBenefits
    };

    if (form.country && form.country !== "US") config.country = form.country;
    if (form.presetId && form.presetId !== "none") config.presetId = form.presetId;
    if (form.connectionId) config.connectionId = form.connectionId;
    if (form.targetEbitda) config.targetEbitda = Number(form.targetEbitda);
    if (form.topCustomerCount) config.topCustomerCount = Number(form.topCustomerCount);
    if (form.clientConcentrationPercent)
      config.clientConcentrationPercent = Number(form.clientConcentrationPercent);
    if (form.tag) config.tag = form.tag;
    if (form.purgeMode !== "none") config.purgeMode = form.purgeMode;
    if (Object.keys(filteredOverrides).length > 0) config.ratioOverrides = filteredOverrides;

    return {
      template: form.templateId,
      config
    };
  }, [form]);

  return {
    form,
    setField,
    setRatio,
    applyPreset,
    overrideCount,
    serializeConfig,
    advancedOpen,
    setAdvancedOpen
  };
}

// @easytestdata/core ships plain JS; the web package only uses these exports in tests.
declare module "@easytestdata/core" {
  export const industryTemplates: Record<string, { name: string }>;
  export const scenarioPresets: Record<string, { id: string; name: string }>;
  export const MAX_EMPLOYEES: number;
}

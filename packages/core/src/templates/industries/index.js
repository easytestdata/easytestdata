import { INDUSTRY_TEMPLATES } from "./data.js";

export const industryTemplates = Object.fromEntries(
  Object.entries(INDUSTRY_TEMPLATES).map(([id, template]) => [id, { id, ...template }])
);

export function getIndustryTemplate(id) {
  return Object.hasOwn(industryTemplates, id) ? industryTemplates[id] : null;
}

/** Like getIndustryTemplate, but throws a helpful error listing valid ids. */
export function requireIndustryTemplate(id) {
  const template = getIndustryTemplate(id);
  if (!template) {
    throw new Error(
      `Unknown industry template "${id}". Valid templates: ${Object.keys(industryTemplates).join(", ")}`
    );
  }
  return template;
}

export function listIndustryTemplates() {
  return Object.values(industryTemplates).map(({ id, name, description }) => ({
    id,
    name,
    description
  }));
}

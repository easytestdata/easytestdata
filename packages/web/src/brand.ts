import metadata from "@easytestdata/web-brand";
import extensions from "@easytestdata/web-extensions";
import { BrandLogo } from "@easytestdata/ui";
import type { ComponentType } from "react";
import type { BrandMetadata } from "./extensions/types";

export const brand: BrandMetadata & { logo: ComponentType<{ className?: string }> } = {
  ...metadata,
  logo: extensions.logo ?? BrandLogo
};

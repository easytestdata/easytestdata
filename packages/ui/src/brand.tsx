import { createContext, useContext, type ReactNode } from "react";

interface ProductBrand {
  name: string;
  repoUrl: string | null;
  supportsSourceReads: boolean;
}

const ProductBrandContext = createContext<ProductBrand>({
  name: "EasyTestData",
  repoUrl: "https://github.com/easytestdata/easytestdata",
  supportsSourceReads: false
});

export function ProductBrandProvider({
  value,
  children
}: {
  value: ProductBrand;
  children: ReactNode;
}) {
  return <ProductBrandContext.Provider value={value}>{children}</ProductBrandContext.Provider>;
}

export function useProductBrand() {
  return useContext(ProductBrandContext);
}

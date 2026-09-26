import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getPublicConfig, type PublicConfig } from "../api/client";

interface AppConfig extends PublicConfig {
  loading: boolean;
  /**
   * Re-fetches /config/public (e.g. after the setup page saved the Intuit keys). Rejects when the
   * fetch fails, leaving the current values in place.
   */
  refresh: () => Promise<void>;
}

type AppConfigState = Omit<AppConfig, "refresh">;

// Conservative defaults while /config/public loads (or if it fails).
const defaultConfig: AppConfigState = {
  version: null,
  sentryDsn: null,
  deployment: "cloud",
  enabledOAuthProviders: [],
  qboConfigured: true,
  qboRedirectUri: "",
  marketingUrl: "https://easytestdata.com",
  loading: true
};

const AppConfigContext = createContext<AppConfig>({
  ...defaultConfig,
  refresh: async () => {}
});

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfigState>(defaultConfig);

  const refresh = useCallback(async () => {
    const data = await getPublicConfig();
    setConfig({ ...data, loading: false });
  }, []);

  // The first load keeps the conservative defaults if /config/public fails.
  useEffect(() => {
    refresh().catch(() => setConfig((prev) => ({ ...prev, loading: false })));
  }, [refresh]);

  const value = useMemo(() => ({ ...config, refresh }), [config, refresh]);
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig() {
  return useContext(AppConfigContext);
}

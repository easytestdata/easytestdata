import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useAppConfig } from "./AppConfigContext";

type SentryModule = typeof import("@sentry/react");

interface SentryContextValue {
  initialized: boolean;
  Sentry: SentryModule | null;
}

const SentryContext = createContext<SentryContextValue>({ initialized: false, Sentry: null });

// Module-level ref accessible outside React tree (e.g. api/client.ts)
let sentryModule: SentryModule | null = null;

export function SentryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SentryContextValue>({ initialized: false, Sentry: null });
  const initRef = useRef(false);
  const config = useAppConfig();

  useEffect(() => {
    if (initRef.current || config.loading) return;
    initRef.current = true;

    if (config.sentryDsn) {
      import("@sentry/react")
        .then((Sentry) => {
          Sentry.init({
            dsn: config.sentryDsn!,
            environment: import.meta.env.MODE,
            tracesSampleRate: import.meta.env.MODE === "production" ? 0.1 : 1.0,
            replaysSessionSampleRate: 0
          });
          sentryModule = Sentry;
          setState({ initialized: true, Sentry });
        })
        .catch(() => {
          // Sentry failed to load; error tracking unavailable, non-fatal
        });
    }
  }, [config.loading, config.sentryDsn]);

  return <SentryContext.Provider value={state}>{children}</SentryContext.Provider>;
}

export function useSentryContext() {
  return useContext(SentryContext);
}

/** Capture an exception if Sentry is loaded; no-op otherwise */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }
) {
  if (sentryModule) {
    sentryModule.captureException(error, context);
  }
}

/** Add a breadcrumb if Sentry is loaded; no-op otherwise */
export function addBreadcrumb(breadcrumb: {
  category?: string;
  message?: string;
  level?: "fatal" | "error" | "warning" | "log" | "info" | "debug";
  data?: Record<string, unknown>;
}) {
  if (sentryModule) {
    sentryModule.addBreadcrumb(breadcrumb);
  }
}

/** Set the current user for Sentry; no-op if not loaded */
export function setSentryUser(user: { id: string; email: string; teamId?: string | null } | null) {
  if (sentryModule) {
    sentryModule.setUser(user);
  }
}

/** Get the ErrorBoundary component if Sentry is loaded, otherwise a passthrough */
export function SentryErrorBoundary({
  children,
  fallback
}: {
  children: ReactNode;
  fallback: React.ReactElement;
}) {
  const { Sentry } = useContext(SentryContext);
  if (Sentry) {
    return <Sentry.ErrorBoundary fallback={fallback}>{children}</Sentry.ErrorBoundary>;
  }
  return <>{children}</>;
}

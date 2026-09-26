export interface DeploymentLimits {
  connections: number;
  loadsPerMonth: number;
  entitiesPerJob: number;
  teamMembers: number;
}

export type Deployment = "cloud" | "local";
export type LimitKind = keyof DeploymentLimits;

export declare const UNLIMITED: -1;

export declare const DEPLOYMENT_LIMITS: Record<Deployment, DeploymentLimits>;

export declare const LIMIT_LABELS: Record<LimitKind, string>;

export declare function limitExceededMessage(kind: LimitKind, limit: number): string;
export declare function isUnlimited(limit: number | null | undefined): boolean;
export declare function allowsAny(limit: number | null | undefined): boolean;
export declare function withinLimit(used: number, limit: number): boolean;

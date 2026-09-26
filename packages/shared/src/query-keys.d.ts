export declare const queryKeys: {
  connections: {
    all: string[];
    health: (id: string) => string[];
  };
  jobs: {
    all: string[];
    detail: (id: string) => string[];
    data: (id: string) => string[];
  };
  templates: {
    industries: string[];
    presets: string[];
  };
  teams: {
    all: string[];
    members: (teamId: string) => string[];
  };
  usage: string[];
};

export declare const ACTIVE_JOB_STATUSES: string[];

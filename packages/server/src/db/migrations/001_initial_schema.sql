-- EasyTestData database schema (baseline).
--
-- The whole schema in one file. New schema changes go in new numbered files (002_*.sql, ...),
-- applied in order by src/db/migrate.js, which records them in the _migrations table.

-- Emails are stored canonical (trimmed, lower case): the triggers normalize on write and the
-- CHECK constraints refuse anything else.
CREATE FUNCTION normalize_email(input text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
  AS $$
  SELECT LOWER(BTRIM(input));
$$;

CREATE FUNCTION trg_normalize_email_column() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.email := normalize_email(NEW.email);
  RETURN NEW;
END;
$$;

CREATE TABLE teams (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT teams_pkey PRIMARY KEY (id)
);

CREATE TABLE users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  display_name text,
  avatar_url text,
  oauth_provider text,
  oauth_provider_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  is_admin boolean DEFAULT false NOT NULL,
  suspended_at timestamptz,
  suspended_reason text,
  suspended_by uuid,
  active_team_id uuid,
  session_version integer DEFAULT 0 NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_canonical_chk CHECK (email = normalize_email(email)),
  CONSTRAINT users_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES users (id),
  CONSTRAINT users_active_team_id_fkey FOREIGN KEY (active_team_id) REFERENCES teams (id)
    ON DELETE SET NULL
);

CREATE INDEX idx_users_email_norm ON users (normalize_email(email));
CREATE INDEX idx_users_oauth ON users (oauth_provider, oauth_provider_id);
CREATE INDEX idx_users_suspended ON users (suspended_at) WHERE suspended_at IS NOT NULL;

CREATE TRIGGER users_normalize_email_biur BEFORE INSERT OR UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION trg_normalize_email_column();

CREATE TABLE team_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text DEFAULT 'member' NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT team_members_pkey PRIMARY KEY (id),
  CONSTRAINT team_members_team_id_user_id_key UNIQUE (team_id, user_id),
  CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id)
    ON DELETE CASCADE,
  CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
);

CREATE INDEX idx_team_members_user ON team_members (user_id);

CREATE TABLE team_invites (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  email text NOT NULL,
  role text DEFAULT 'member' NOT NULL,
  token text NOT NULL,
  invited_by uuid,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT team_invites_pkey PRIMARY KEY (id),
  CONSTRAINT team_invites_token_key UNIQUE (token),
  CONSTRAINT team_invites_email_canonical_chk CHECK (email = normalize_email(email)),
  CONSTRAINT team_invites_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT team_invites_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id)
    ON DELETE CASCADE,
  CONSTRAINT team_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users (id)
);

CREATE INDEX idx_team_invites_email ON team_invites (email);
CREATE INDEX idx_team_invites_team ON team_invites (team_id);

CREATE TRIGGER team_invites_normalize_email_biur BEFORE INSERT OR UPDATE OF email ON team_invites
  FOR EACH ROW EXECUTE FUNCTION trg_normalize_email_column();

-- QBO access/refresh tokens are AES-encrypted with a per-row IV (token_iv). Disconnecting a
-- sandbox keeps its row (so its jobs keep their sandbox) with the tokens cleared and
-- disconnected_at set; reconnecting the same realm stores new tokens on the same row.
CREATE TABLE qbo_connections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  realm_id text NOT NULL,
  company_name text,
  access_token_enc text,
  refresh_token_enc text,
  token_iv text,
  base_url text DEFAULT 'https://sandbox-quickbooks.api.intuit.com' NOT NULL,
  connected_at timestamptz DEFAULT now(),
  last_used_at timestamptz,
  disconnected_at timestamptz,
  CONSTRAINT qbo_connections_pkey PRIMARY KEY (id),
  CONSTRAINT qbo_connections_team_id_realm_id_key UNIQUE (team_id, realm_id),
  CONSTRAINT qbo_connections_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id)
    ON DELETE CASCADE,
  CONSTRAINT qbo_connections_tokens_chk CHECK (
    disconnected_at IS NOT NULL
    OR (access_token_enc IS NOT NULL AND refresh_token_enc IS NOT NULL AND token_iv IS NOT NULL)
  )
);

CREATE TABLE jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  team_id uuid NOT NULL,
  connection_id uuid,
  type text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  progress jsonb DEFAULT '{"step": 0, "message": "", "totalSteps": 0}'::jsonb,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  result jsonb,
  error text,
  entity_count integer DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  parent_job_id uuid,
  CONSTRAINT jobs_pkey PRIMARY KEY (id),
  CONSTRAINT jobs_status_check CHECK (
    status IN ('pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled',
      'failed_with_orphans')
  ),
  CONSTRAINT jobs_type_check CHECK (type IN ('generate', 'load', 'purge', 'export', 'rollback')),
  CONSTRAINT jobs_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT jobs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES qbo_connections (id)
    ON DELETE SET NULL,
  CONSTRAINT jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT jobs_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES jobs (id)
);

CREATE INDEX idx_jobs_connection ON jobs (connection_id);
CREATE INDEX idx_jobs_parent ON jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_team_created ON jobs (team_id, created_at DESC);
CREATE INDEX idx_jobs_team_status ON jobs (team_id, status);

-- One pending/running/cancelling QBO job (load, purge, rollback) per team.
CREATE UNIQUE INDEX jobs_one_active_qbo_job_per_team ON jobs (team_id)
  WHERE type IN ('load', 'purge', 'rollback') AND status IN ('pending', 'running', 'cancelling');

-- session_version is the users.session_version generation the token was issued for.
CREATE TABLE refresh_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  used_at timestamptz,
  session_version integer NOT NULL,
  CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);

-- Encrypted app-level settings (value_enc with its IV).
CREATE TABLE app_settings (
  key text NOT NULL,
  value_enc text NOT NULL,
  iv text NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT app_settings_pkey PRIMARY KEY (key)
);

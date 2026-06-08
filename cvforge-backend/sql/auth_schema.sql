-- ═══════════════════════════════════════════════════════════════
--  CVForge — Auth Schema Migration
--  Run this in psql AFTER connecting to cvforge database:
--    \c cvforge
--    \i sql/auth_schema.sql
--
--  What this does:
--    1. Drops the old users table (had integer id, no auth fields)
--    2. Recreates users with UUID id + email + password + role
--    3. Adds role system: 'candidate' | 'recruiter' | 'admin'
--    4. Re-creates all foreign keys that reference users(id)
--    5. Creates sessions table for token blacklisting (logout)
-- ═══════════════════════════════════════════════════════════════

-- ── SAFETY: only run on cvforge ─────────────────────────────────
DO $$
BEGIN
  IF current_database() != 'cvforge' THEN
    RAISE EXCEPTION 'Wrong database! Connect to cvforge first: \c cvforge';
  END IF;
END $$;


-- ── 1. DROP OLD TABLES (order matters — children before parents) ─
-- We drop and recreate because the old users.id was INTEGER,
-- but all CVForge tables need UUID foreign keys.
DROP TABLE IF EXISTS
  pdf_downloads,
  public_profiles,
  skill_project_links,
  certifications,
  projects,
  skills,
  education,
  experience,
  cvs,
  users
CASCADE;


-- ── 2. RECREATE USERS TABLE WITH AUTH FIELDS ────────────────────
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Auth fields
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,           -- bcrypt hash, never plain text
  role          TEXT        NOT NULL DEFAULT 'candidate'
                            CHECK (role IN ('candidate', 'recruiter', 'admin')),

  -- Profile fields
  full_name     TEXT        NOT NULL DEFAULT '',
  browser_uid   TEXT        UNIQUE,             -- links to localStorage session

  -- State
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN    NOT NULL DEFAULT FALSE,

  -- Metadata
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_email  ON users(email);
CREATE INDEX idx_users_role   ON users(role);

COMMENT ON COLUMN users.role         IS 'candidate = job seeker, recruiter = can search profiles, admin = full access';
COMMENT ON COLUMN users.password_hash IS 'bcrypt hash with 12 salt rounds — never store plain text';
COMMENT ON COLUMN users.browser_uid  IS 'Links registered account to anonymous localStorage session for data migration';


-- ── 3. SESSIONS TABLE (JWT token blacklist for logout) ───────────
-- When a user logs out, their token JTI is stored here so it
-- cannot be reused even before it expires.
CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti           TEXT        UNIQUE NOT NULL,   -- JWT ID claim — unique per token
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address    TEXT        NOT NULL DEFAULT '',
  user_agent    TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX idx_sessions_jti       ON sessions(jti);
CREATE INDEX idx_sessions_expires   ON sessions(expires_at);

COMMENT ON TABLE sessions IS 'Tracks issued JWTs — revoked=true means logged out';


-- ── 4. RECREATE CVS TABLE ────────────────────────────────────────
CREATE TABLE cvs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name       TEXT        NOT NULL DEFAULT '',
  email           TEXT        NOT NULL DEFAULT '',
  phone           TEXT        NOT NULL DEFAULT '',
  job_title       TEXT        NOT NULL DEFAULT '',
  location        TEXT        NOT NULL DEFAULT '',
  summary         TEXT        NOT NULL DEFAULT '',
  linkedin_url    TEXT        NOT NULL DEFAULT '',
  github_url      TEXT        NOT NULL DEFAULT '',
  is_public       BOOLEAN     NOT NULL DEFAULT FALSE,
  accent_color    TEXT        NOT NULL DEFAULT '#0A0C10',
  font_size       SMALLINT    NOT NULL DEFAULT 10,
  job_preferences JSONB       NOT NULL DEFAULT '{}',
  keywords        TEXT[]      NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cvs_user_id  ON cvs(user_id);
CREATE INDEX idx_cvs_keywords ON cvs USING GIN(keywords);
CREATE INDEX idx_cvs_location ON cvs(location);


-- ── 5. RECREATE ALL CHILD TABLES ────────────────────────────────
CREATE TABLE experience (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id        UUID         NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  sort_order   SMALLINT     NOT NULL DEFAULT 0,
  role         TEXT         NOT NULL DEFAULT '',
  company      TEXT         NOT NULL DEFAULT '',
  location     TEXT         NOT NULL DEFAULT '',
  start_date   TEXT         NOT NULL DEFAULT '',
  end_date     TEXT         NOT NULL DEFAULT '',
  is_present   BOOLEAN      NOT NULL DEFAULT FALSE,
  bullets      TEXT         NOT NULL DEFAULT '',
  years        NUMERIC(4,1)          DEFAULT 0
);
CREATE INDEX idx_experience_cv_id ON experience(cv_id);

CREATE TABLE education (
  id           UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id        UUID     NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  degree       TEXT     NOT NULL DEFAULT '',
  school       TEXT     NOT NULL DEFAULT '',
  field        TEXT     NOT NULL DEFAULT '',
  start_date   TEXT     NOT NULL DEFAULT '',
  end_date     TEXT     NOT NULL DEFAULT '',
  is_present   BOOLEAN  NOT NULL DEFAULT FALSE,
  grade        TEXT     NOT NULL DEFAULT ''
);
CREATE INDEX idx_education_cv_id ON education(cv_id);

CREATE TABLE skills (
  id           UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id        UUID     NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  name         TEXT     NOT NULL DEFAULT '',
  level        SMALLINT NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 5),
  color        TEXT     NOT NULL DEFAULT '#4F7AFF'
);
CREATE INDEX idx_skills_cv_id ON skills(cv_id);

CREATE TABLE projects (
  id           UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id        UUID     NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  name         TEXT     NOT NULL DEFAULT '',
  tech_stack   TEXT     NOT NULL DEFAULT '',
  project_url  TEXT     NOT NULL DEFAULT '',
  description  TEXT     NOT NULL DEFAULT ''
);
CREATE INDEX idx_projects_cv_id ON projects(cv_id);

CREATE TABLE skill_project_links (
  skill_id   UUID NOT NULL REFERENCES skills(id)   ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, project_id)
);
CREATE INDEX idx_spl_skill_id   ON skill_project_links(skill_id);
CREATE INDEX idx_spl_project_id ON skill_project_links(project_id);

CREATE TABLE certifications (
  id            UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id         UUID     NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  sort_order    SMALLINT NOT NULL DEFAULT 0,
  name          TEXT     NOT NULL DEFAULT '',
  issuing_org   TEXT     NOT NULL DEFAULT '',
  issue_date    TEXT     NOT NULL DEFAULT '',
  credential_id TEXT     NOT NULL DEFAULT ''
);
CREATE INDEX idx_certifications_cv_id ON certifications(cv_id);


-- ── 6. PUBLIC PROFILES (recruiter search index) ──────────────────
CREATE TABLE public_profiles (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cv_id            UUID         UNIQUE NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name        TEXT         NOT NULL DEFAULT '',
  job_title        TEXT         NOT NULL DEFAULT '',
  location         TEXT         NOT NULL DEFAULT '',
  keywords         TEXT[]       NOT NULL DEFAULT '{}',
  experience_years NUMERIC(4,1)          DEFAULT 0,
  is_visible       BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pp_keywords         ON public_profiles USING GIN(keywords);
CREATE INDEX idx_pp_location         ON public_profiles(location);
CREATE INDEX idx_pp_experience_years ON public_profiles(experience_years);
CREATE INDEX idx_pp_is_visible       ON public_profiles(is_visible);


-- ── 7. PDF DOWNLOADS (analytics) ────────────────────────────────
CREATE TABLE pdf_downloads (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  cv_id         UUID        REFERENCES cvs(id)   ON DELETE SET NULL,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent    TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX idx_pdf_downloads_user ON pdf_downloads(user_id);
CREATE INDEX idx_pdf_downloads_date ON pdf_downloads(downloaded_at);


-- ── 8. AUTO updated_at TRIGGER ───────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cvs_updated_at
  BEFORE UPDATE ON cvs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_pp_updated_at
  BEFORE UPDATE ON public_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── 9. CV FULL VIEW ──────────────────────────────────────────────
CREATE OR REPLACE VIEW cv_full AS
SELECT
  c.id AS cv_id,
  c.user_id,
  u.email        AS user_email,
  u.role         AS user_role,
  c.full_name,   c.email,        c.phone,
  c.job_title,   c.location,     c.summary,
  c.linkedin_url, c.github_url,
  c.is_public,   c.accent_color, c.font_size,
  c.job_preferences, c.keywords, c.updated_at,

  COALESCE((SELECT json_agg(e  ORDER BY e.sort_order)    FROM experience    e    WHERE e.cv_id    = c.id), '[]') AS experience,
  COALESCE((SELECT json_agg(ed ORDER BY ed.sort_order)   FROM education     ed   WHERE ed.cv_id   = c.id), '[]') AS education,
  COALESCE((SELECT json_agg(
    json_build_object('id',sk.id,'name',sk.name,'level',sk.level,'color',sk.color,'sort_order',sk.sort_order,
      'project_ids', COALESCE((SELECT array_agg(spl.project_id) FROM skill_project_links spl WHERE spl.skill_id=sk.id),'{}'))
    ORDER BY sk.sort_order) FROM skills sk WHERE sk.cv_id = c.id), '[]') AS skills,
  COALESCE((SELECT json_agg(p  ORDER BY p.sort_order)    FROM projects      p    WHERE p.cv_id    = c.id), '[]') AS projects,
  COALESCE((SELECT json_agg(ct ORDER BY ct.sort_order)   FROM certifications ct  WHERE ct.cv_id   = c.id), '[]') AS certifications
FROM cvs c
JOIN users u ON u.id = c.user_id;


-- ── 10. GRANT PERMISSIONS TO APP USER ───────────────────────────
-- Run after creating cvforge_app role (already done earlier)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cvforge_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      users, sessions, cvs, experience, education, skills,
      projects, skill_project_links, certifications,
      public_profiles, pdf_downloads
    TO cvforge_app;
    GRANT SELECT ON cv_full TO cvforge_app;
    GRANT USAGE  ON ALL SEQUENCES IN SCHEMA public TO cvforge_app;
  END IF;
END $$;


-- ── 11. VERIFY ───────────────────────────────────────────────────
\dt

-- Expected 11 tables:
-- certifications, cvs, education, experience, pdf_downloads,
-- projects, public_profiles, sessions, skill_project_links,
-- skills, users

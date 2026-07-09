-- 0001_init.sql
-- CleanTech Index — core relational schema for Cloudflare D1.
-- Applied via: wrangler d1 migrations apply cleantech_index --local|--remote

-- Developers who own/operate infrastructure portfolios.
CREATE TABLE energy_developers (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  headquarters_state  TEXT,
  total_portfolio_mw  REAL
);

-- The indexable pSEO leaf pages live here — one row = one /project/:slug page.
CREATE TABLE infrastructure_projects (
  id                        INTEGER PRIMARY KEY,
  developer_id              INTEGER NOT NULL REFERENCES energy_developers(id),
  project_name              TEXT NOT NULL,
  slug                      TEXT NOT NULL UNIQUE,
  technology_type           TEXT NOT NULL,          -- 'Solar PV', 'Battery Storage', 'Onshore Wind', ...
  capacity_mw               REAL,
  status                    TEXT NOT NULL
                              CHECK (status IN ('Operational','Under Construction','Planned')),
  interconnection_utility   TEXT,                    -- ERCOT, MISO, ISO-NE, ...
  commercial_operation_year INTEGER,
  county                    TEXT,
  state                     TEXT
);

-- Hardware suppliers (modules, inverters, turbines, cells, controls).
CREATE TABLE hardware_vendors (
  id             INTEGER PRIMARY KEY,
  company_name   TEXT NOT NULL,
  component_type TEXT
);

-- Many-to-many: a project uses multiple vendors; a vendor supplies many projects.
CREATE TABLE project_hardware (
  project_id INTEGER NOT NULL REFERENCES infrastructure_projects(id),
  vendor_id  INTEGER NOT NULL REFERENCES hardware_vendors(id),
  PRIMARY KEY (project_id, vendor_id)
);

-- Slug columns are already UNIQUE (auto-indexed). These cover the join paths.
CREATE INDEX idx_projects_developer ON infrastructure_projects(developer_id);
CREATE INDEX idx_projecthw_vendor   ON project_hardware(vendor_id);

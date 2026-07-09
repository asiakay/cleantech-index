-- 0002_seed.sql
-- Illustrative sample rows so a /project/:slug page renders immediately.
-- These are FICTIONAL placeholder companies/projects — replace with real data.

INSERT INTO energy_developers (id, name, slug, headquarters_state, total_portfolio_mw) VALUES
  (1, 'Helios Grid Partners',      'helios-grid-partners',      'TX', 4200.0),
  (2, 'Prairie Wind Development',  'prairie-wind-development',  'IA', 3100.5),
  (3, 'Bay State Storage Co',      'bay-state-storage-co',      'MA',  850.0);

INSERT INTO infrastructure_projects
  (id, developer_id, project_name, slug, technology_type, capacity_mw, status,
   interconnection_utility, commercial_operation_year, county, state) VALUES
  (1, 1, 'Mustang Ridge Solar',  'mustang-ridge-solar',  'Solar PV',        250.0, 'Operational',        'ERCOT',  2023, 'Crockett', 'TX'),
  (2, 1, 'Llano Battery Hub',    'llano-battery-hub',    'Battery Storage', 150.0, 'Under Construction', 'ERCOT',  2026, 'Llano',    'TX'),
  (3, 2, 'North Prairie Wind',   'north-prairie-wind',   'Onshore Wind',    400.0, 'Operational',        'MISO',   2022, 'Story',    'IA'),
  (4, 3, 'Quincy Point Storage', 'quincy-point-storage', 'Battery Storage',  80.0, 'Planned',            'ISO-NE', 2027, 'Norfolk',  'MA');

INSERT INTO hardware_vendors (id, company_name, component_type) VALUES
  (1, 'Sunterra Modules',  'PV Module'),
  (2, 'VoltCore Systems',  'Battery Inverter'),
  (3, 'Aeris Turbines',    'Wind Turbine'),
  (4, 'GridLink Controls', 'SCADA / Controls'),
  (5, 'Cellwave Energy',   'Battery Cell');

INSERT INTO project_hardware (project_id, vendor_id) VALUES
  (1, 1), (1, 4),          -- Mustang Ridge Solar
  (2, 2), (2, 5), (2, 4),  -- Llano Battery Hub
  (3, 3), (3, 4),          -- North Prairie Wind
  (4, 2), (4, 5);          -- Quincy Point Storage

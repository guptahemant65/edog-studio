# C03 — ThemeSchemaPage: Component Deep Spec

> **Component:** ThemeSchemaPage (C03)
> **Feature:** F16 — New Infra Wizard
> **Page:** 2 of 5 ("Theme & Schema Setup")
> **Owner:** Pixel (JS/CSS) — Card grid, animation choreography, chip interaction
> **Reviewer:** Sana (Architecture) — Data model correctness, schema propagation
> **Complexity:** MEDIUM
> **Status:** P1 SPEC — DRAFT
> **Mock Reference:** `mocks/infra-wizard.html` Page 2
> **Design Reference:** Design Bible 4b, Overlay 25A
> **Last Updated:** 2025-07-20

---

## Table of Contents

1. [Overview](#1-overview)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [State Machine](#4-state-machine)
5. [Scenarios](#5-scenarios)
6. [Visual Spec](#6-visual-spec)
7. [Keyboard & Accessibility](#7-keyboard--accessibility)
8. [Error Handling](#8-error-handling)
9. [Performance](#9-performance)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Overview

### 1.1 Purpose

ThemeSchemaPage is wizard Page 2 — the point where users define *what kind of data* their test environment will contain and *how schemas are organized*. It owns two conceptually distinct but visually unified sections:

1. **Theme Selection** — A 3×2 grid of 6 data theme cards. Each theme represents a business domain (E-Commerce, Sales Analytics, IoT Telemetry, HR Analytics, Finance, Healthcare). The user selects exactly one theme, which determines the table names, column structures, and sample data rows that will be auto-generated throughout the notebook. Single-select, mandatory.

2. **Schema Configuration** — A chip-based control for configuring medallion architecture schemas. The `dbo` schema is always present and locked (cannot be deselected). An "Add medallion schemas" toggle reveals three optional schema chips — Bronze, Silver, Gold — each individually toggleable. The selected schemas propagate downstream to Page 3 (DAG Canvas), where every node's schema dropdown is populated with exactly the set of schemas chosen here.

### 1.2 User Journey Context

```
Page 1 (InfraSetupPage)        Page 2 (ThemeSchemaPage)         Page 3 (DagCanvas)
━━━━━━━━━━━━━━━━━━━━━━━━━━ → ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ → ━━━━━━━━━━━━━━━━━━━━━━━
Workspace, Capacity,           Theme + Schemas                  DAG node placement,
Lakehouse, Notebook names      "What data? Which schemas?"      connections, code gen
```

The user arrives on Page 2 after completing infrastructure naming on Page 1. They must select a theme before "Next" is enabled. Schema configuration has sensible defaults (dbo always, medallion toggle off), so the page is "valid" as soon as a theme is picked.

### 1.3 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Card grid vs dropdown for themes | **Card grid (3×2)** | Research finding #6: "Selection UIs should use radio cards, not dropdowns." Cards celebrate choices; dropdowns hide them. (Notion, Discord, Shopify pattern) |
| Single-select vs multi-select themes | **Single-select** | One theme per environment. Mixing themes creates incoherent sample data. |
| Schema chip vs radio group | **Toggleable chips** | Medallion schemas are additive — users may want dbo+gold without bronze/silver. Multi-select chips communicate optionality better than radio buttons. |
| Medallion toggle gate | **Toggle → reveal chips** | Keeps the default UI simple for users who don't need medallion schemas. Progressive disclosure. |
| dbo chip locked | **Always present, non-interactive** | `dbo` is the Fabric default schema and is always created. Removing it would break the lakehouse. |
| Theme affects code gen only | **Yes** | Theme selection changes auto-generated SQL/PySpark content. It does NOT affect infrastructure (workspace, capacity, lakehouse). |
| Schema selection affects Page 3 | **Yes** | DAG node schema dropdowns are populated from this page's schema selection. |

### 1.4 What This Component Does NOT Own

- **Infrastructure names** — Page 1 (InfraSetupPage, C02)
- **DAG node placement** — Page 3 (DagCanvas, C04)
- **Code generation engine** — Shared service (uses theme data as input)
- **Schema creation API calls** — Page 5 (ExecutionPipeline, C10)
- **Template save/load** — TemplateManager (C12) — but theme+schema data IS serialized into templates

---

## 2. Data Model

### 2.1 Theme Registry — Complete Definition

The theme registry is a static, read-only data structure that defines all 6 data themes. Each theme contains: an identifier, display metadata (name, icon, description), and a complete table catalog with column definitions and sample rows.

```typescript
/** Theme identifier — used as data-theme attribute and serialization key */
type ThemeId = 'ecommerce' | 'sales' | 'iot' | 'hr' | 'finance' | 'healthcare';

/** Column type — maps to Spark SQL types used in CREATE TABLE / StructType */
type ColumnType = 'INT' | 'BIGINT' | 'STRING' | 'DECIMAL(10,2)' | 'DECIMAL(12,2)'
               | 'TIMESTAMP' | 'DATE' | 'BOOLEAN' | 'DOUBLE' | 'FLOAT';

/** Single column definition */
interface ThemeColumn {
  name: string;         // e.g., "order_id"
  type: ColumnType;     // e.g., "INT"
  nullable: boolean;    // false for PKs, true for most others
  description: string;  // human-readable, used in code comments
}

/** Single table definition within a theme */
interface ThemeTable {
  name: string;              // e.g., "orders" — used as SQL table name
  displayName: string;       // e.g., "Orders" — shown in UI
  columns: ThemeColumn[];    // full column list
  sampleRows: any[][];       // 10 rows, positional match to columns
  primaryKey: string;        // column name serving as PK
  description: string;       // one-line table description
}

/** Complete theme definition */
interface ThemeDefinition {
  id: ThemeId;
  name: string;              // display name, e.g., "E-Commerce"
  icon: string;              // SVG markup string (inline SVG, 18×18 viewBox)
  description: string;       // short tagline for the card
  tables: ThemeTable[];      // exactly 6 tables per theme
  color: string;             // optional accent tint for the theme icon background
}
```

### 2.2 Complete Theme Catalog

#### Theme 1: E-Commerce

**ID:** `ecommerce`
**Display Name:** E-Commerce
**Description:** Online retail with orders, products, and customer reviews
**Icon:** Shopping cart SVG (from mock: `<svg>` with cart path)

##### Table: `orders`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| order_id | INT | No | Primary key |
| customer_id | INT | No | FK to customers |
| order_date | TIMESTAMP | No | When order was placed |
| total_amount | DECIMAL(10,2) | No | Order total in USD |
| status | STRING | No | pending / shipped / delivered / cancelled |
| shipping_address | STRING | Yes | Delivery address |

Sample rows (3 of 10):

```
(1, 101, '2024-01-15T09:30:00', 149.99, 'shipped', '742 Evergreen Terrace, Springfield')
(2, 102, '2024-01-15T10:45:00', 89.50, 'delivered', '221B Baker Street, London')
(3, 103, '2024-01-16T14:20:00', 299.00, 'pending', '1600 Pennsylvania Ave, Washington')
```

##### Table: `customers`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| customer_id | INT | No | Primary key |
| first_name | STRING | No | Customer first name |
| last_name | STRING | No | Customer last name |
| email | STRING | No | Contact email |
| signup_date | DATE | No | Registration date |
| loyalty_tier | STRING | Yes | bronze / silver / gold / platinum |

Sample rows (3 of 10):

```
(101, 'Alice', 'Chen', 'alice.chen@example.com', '2023-06-15', 'gold')
(102, 'Bob', 'Martinez', 'bob.m@example.com', '2023-09-22', 'silver')
(103, 'Carol', 'Johnson', 'carol.j@example.com', '2024-01-02', null)
```

##### Table: `products`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| product_id | INT | No | Primary key |
| name | STRING | No | Product display name |
| category | STRING | No | Product category |
| price | DECIMAL(10,2) | No | Unit price in USD |
| stock_quantity | INT | No | Current inventory count |
| is_active | BOOLEAN | No | Whether product is listed |

Sample rows (3 of 10):

```
(201, 'Wireless Bluetooth Headphones', 'Electronics', 79.99, 342, true)
(202, 'Organic Green Tea (100 bags)', 'Grocery', 24.50, 1205, true)
(203, 'Running Shoes Pro X', 'Footwear', 149.00, 87, true)
```

##### Table: `order_items`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| item_id | INT | No | Primary key |
| order_id | INT | No | FK to orders |
| product_id | INT | No | FK to products |
| quantity | INT | No | Number of units |
| unit_price | DECIMAL(10,2) | No | Price per unit at time of purchase |
| discount | DECIMAL(10,2) | Yes | Applied discount amount |

Sample rows (3 of 10):

```
(1001, 1, 201, 1, 79.99, 0.00)
(1002, 1, 202, 2, 24.50, 5.00)
(1003, 2, 203, 1, 149.00, 59.50)
```

##### Table: `reviews`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| review_id | INT | No | Primary key |
| product_id | INT | No | FK to products |
| customer_id | INT | No | FK to customers |
| rating | INT | No | 1-5 star rating |
| review_text | STRING | Yes | Written review body |
| review_date | TIMESTAMP | No | When review was posted |

Sample rows (3 of 10):

```
(3001, 201, 101, 5, 'Amazing sound quality, worth every penny!', '2024-01-20T08:15:00')
(3002, 203, 102, 4, 'Great comfort but runs slightly large', '2024-01-21T14:30:00')
(3003, 202, 103, 3, 'Good tea but packaging was damaged', '2024-01-22T11:00:00')
```

##### Table: `inventory`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| inventory_id | INT | No | Primary key |
| product_id | INT | No | FK to products |
| warehouse | STRING | No | Warehouse location code |
| quantity_on_hand | INT | No | Current stock |
| reorder_point | INT | No | Threshold to trigger reorder |
| last_restocked | TIMESTAMP | Yes | Most recent restock date |

Sample rows (3 of 10):

```
(5001, 201, 'WH-EAST-01', 150, 50, '2024-01-10T06:00:00')
(5002, 202, 'WH-WEST-02', 800, 200, '2024-01-12T06:00:00')
(5003, 203, 'WH-EAST-01', 45, 30, '2024-01-08T06:00:00')
```

---

#### Theme 2: Sales Analytics

**ID:** `sales`
**Display Name:** Sales Analytics
**Description:** CRM pipeline with opportunities, accounts, and quota tracking
**Icon:** Activity/pulse SVG (from mock: zigzag line path)

##### Table: `opportunities`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| opportunity_id | INT | No | Primary key |
| account_id | INT | No | FK to accounts |
| name | STRING | No | Deal name |
| stage | STRING | No | prospecting / qualification / proposal / negotiation / closed_won / closed_lost |
| amount | DECIMAL(12,2) | No | Deal value in USD |
| close_date | DATE | Yes | Expected or actual close date |

Sample rows (3 of 10):

```
(1, 501, 'Enterprise Platform License', 'negotiation', 125000.00, '2024-03-15')
(2, 502, 'Cloud Migration Phase 1', 'proposal', 89000.00, '2024-04-01')
(3, 503, 'Annual Support Renewal', 'closed_won', 45000.00, '2024-02-28')
```

##### Table: `accounts`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| account_id | INT | No | Primary key |
| company_name | STRING | No | Organization name |
| industry | STRING | No | Industry vertical |
| annual_revenue | DECIMAL(12,2) | Yes | Estimated ARR |
| employee_count | INT | Yes | Company size |
| region | STRING | No | Sales territory |

Sample rows (3 of 10):

```
(501, 'Contoso Ltd', 'Technology', 5200000.00, 1200, 'West')
(502, 'Northwind Traders', 'Retail', 3800000.00, 850, 'East')
(503, 'Adventure Works', 'Manufacturing', 12000000.00, 4500, 'Central')
```

##### Table: `contacts`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| contact_id | INT | No | Primary key |
| account_id | INT | No | FK to accounts |
| first_name | STRING | No | Contact first name |
| last_name | STRING | No | Contact last name |
| title | STRING | Yes | Job title |
| email | STRING | No | Work email |

Sample rows (3 of 10):

```
(601, 501, 'Sarah', 'O''Brien', 'VP of Engineering', 'sarah.obrien@contoso.com')
(602, 502, 'James', 'Park', 'IT Director', 'jpark@northwind.com')
(603, 503, 'Maria', 'Gonzalez', 'CTO', 'mgonzalez@adventureworks.com')
```

##### Table: `activities`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| activity_id | INT | No | Primary key |
| opportunity_id | INT | No | FK to opportunities |
| contact_id | INT | No | FK to contacts |
| type | STRING | No | call / email / meeting / demo |
| subject | STRING | No | Activity subject line |
| activity_date | TIMESTAMP | No | When activity occurred |

Sample rows (3 of 10):

```
(701, 1, 601, 'meeting', 'Technical architecture deep-dive', '2024-02-10T10:00:00')
(702, 2, 602, 'demo', 'Cloud platform capabilities demo', '2024-02-12T14:00:00')
(703, 3, 603, 'call', 'Renewal terms discussion', '2024-02-15T09:30:00')
```

##### Table: `pipeline`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| snapshot_id | INT | No | Primary key |
| snapshot_date | DATE | No | Pipeline snapshot date |
| stage | STRING | No | Pipeline stage |
| deal_count | INT | No | Number of deals in stage |
| total_value | DECIMAL(12,2) | No | Aggregate value |
| avg_days_in_stage | INT | No | Average age of deals in stage |

Sample rows (3 of 10):

```
(801, '2024-02-01', 'prospecting', 12, 480000.00, 15)
(802, '2024-02-01', 'qualification', 8, 640000.00, 22)
(803, '2024-02-01', 'negotiation', 5, 925000.00, 35)
```

##### Table: `quotas`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| quota_id | INT | No | Primary key |
| rep_name | STRING | No | Sales rep full name |
| quarter | STRING | No | Fiscal quarter (Q1-Q4 YYYY) |
| target_amount | DECIMAL(12,2) | No | Quota target |
| actual_amount | DECIMAL(12,2) | No | Actual closed revenue |
| attainment_pct | DOUBLE | No | actual / target × 100 |

Sample rows (3 of 10):

```
(901, 'David Kim', 'Q1 2024', 250000.00, 275000.00, 110.0)
(902, 'Lisa Wang', 'Q1 2024', 300000.00, 198000.00, 66.0)
(903, 'Marcus Brown', 'Q1 2024', 275000.00, 340000.00, 123.6)
```

---

#### Theme 3: IoT Telemetry

**ID:** `iot`
**Display Name:** IoT Telemetry
**Description:** Sensor networks with device readings, alerts, and maintenance logs
**Icon:** Server/device SVG (from mock: rectangle with partitions)

##### Table: `sensors`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| sensor_id | INT | No | Primary key |
| device_id | INT | No | FK to devices |
| sensor_type | STRING | No | temperature / humidity / pressure / vibration / flow |
| unit | STRING | No | Measurement unit (°C, %, hPa, mm/s, L/min) |
| min_threshold | DOUBLE | No | Alert lower bound |
| max_threshold | DOUBLE | No | Alert upper bound |

Sample rows (3 of 10):

```
(1, 1001, 'temperature', '°C', -10.0, 85.0)
(2, 1001, 'humidity', '%', 20.0, 80.0)
(3, 1002, 'pressure', 'hPa', 950.0, 1050.0)
```

##### Table: `readings`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| reading_id | BIGINT | No | Primary key |
| sensor_id | INT | No | FK to sensors |
| value | DOUBLE | No | Measured value |
| timestamp | TIMESTAMP | No | Reading timestamp (UTC) |
| quality | STRING | No | good / suspect / bad |
| battery_pct | INT | Yes | Remaining battery percentage |

Sample rows (3 of 10):

```
(100001, 1, 22.5, '2024-01-15T08:00:00', 'good', 95)
(100002, 2, 45.2, '2024-01-15T08:00:00', 'good', 95)
(100003, 3, 1013.25, '2024-01-15T08:00:05', 'good', 88)
```

##### Table: `alerts`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| alert_id | INT | No | Primary key |
| sensor_id | INT | No | FK to sensors |
| severity | STRING | No | info / warning / critical |
| message | STRING | No | Alert description |
| triggered_at | TIMESTAMP | No | When alert fired |
| resolved_at | TIMESTAMP | Yes | When alert was cleared |

Sample rows (3 of 10):

```
(2001, 1, 'warning', 'Temperature approaching upper threshold: 82.3°C', '2024-01-15T14:30:00', '2024-01-15T14:45:00')
(2002, 3, 'critical', 'Pressure drop detected: 940.1 hPa below minimum', '2024-01-16T02:10:00', null)
(2003, 2, 'info', 'Humidity reading variance >5% over 1h window', '2024-01-16T06:00:00', '2024-01-16T06:30:00')
```

##### Table: `devices`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| device_id | INT | No | Primary key |
| device_name | STRING | No | Human-readable device name |
| location | STRING | No | Physical installation location |
| firmware_version | STRING | No | Current firmware |
| install_date | DATE | No | When device was deployed |
| is_online | BOOLEAN | No | Current connectivity status |

Sample rows (3 of 10):

```
(1001, 'HVAC-North-Wing-01', 'Building A, Floor 3, Room 301', 'v2.4.1', '2023-06-15', true)
(1002, 'Boiler-Pressure-Main', 'Building B, Basement, Utility Room', 'v3.1.0', '2023-08-20', true)
(1003, 'Warehouse-Climate-03', 'Warehouse C, Zone 3', 'v2.4.1', '2023-11-01', false)
```

##### Table: `maintenance`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| maintenance_id | INT | No | Primary key |
| device_id | INT | No | FK to devices |
| type | STRING | No | preventive / corrective / calibration |
| description | STRING | No | Work performed |
| performed_by | STRING | No | Technician name |
| performed_at | TIMESTAMP | No | Maintenance timestamp |

Sample rows (3 of 10):

```
(3001, 1001, 'preventive', 'Quarterly sensor calibration and filter replacement', 'Mike Torres', '2024-01-10T09:00:00')
(3002, 1002, 'corrective', 'Replaced faulty pressure transducer', 'Sarah Lin', '2024-01-12T11:30:00')
(3003, 1003, 'calibration', 'Annual humidity sensor recalibration', 'Mike Torres', '2024-01-14T08:00:00')
```

##### Table: `thresholds`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| threshold_id | INT | No | Primary key |
| sensor_type | STRING | No | Sensor type this threshold applies to |
| environment | STRING | No | operating / storage / hazardous |
| min_value | DOUBLE | No | Lower acceptable bound |
| max_value | DOUBLE | No | Upper acceptable bound |
| escalation_delay_sec | INT | No | Seconds before escalation |

Sample rows (3 of 10):

```
(4001, 'temperature', 'operating', -10.0, 85.0, 300)
(4002, 'humidity', 'operating', 20.0, 80.0, 600)
(4003, 'pressure', 'operating', 950.0, 1050.0, 120)
```

---

#### Theme 4: HR Analytics

**ID:** `hr`
**Display Name:** HR Analytics
**Description:** People data with employees, departments, performance, and payroll
**Icon:** Users SVG (from mock: two-person silhouette paths)

##### Table: `employees`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| employee_id | INT | No | Primary key |
| first_name | STRING | No | First name |
| last_name | STRING | No | Last name |
| department_id | INT | No | FK to departments |
| position_id | INT | No | FK to positions |
| hire_date | DATE | No | Employment start date |

Sample rows (3 of 10):

```
(1, 'Priya', 'Sharma', 10, 100, '2021-03-15')
(2, 'John', 'Okafor', 20, 201, '2019-07-01')
(3, 'Mei', 'Zhang', 10, 101, '2022-01-10')
```

##### Table: `departments`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| department_id | INT | No | Primary key |
| name | STRING | No | Department name |
| head_employee_id | INT | Yes | FK to employees (department head) |
| budget | DECIMAL(12,2) | No | Annual department budget |
| location | STRING | No | Office location |
| headcount | INT | No | Current team size |

Sample rows (3 of 10):

```
(10, 'Engineering', 2, 2400000.00, 'Seattle HQ', 45)
(20, 'Product Management', null, 1200000.00, 'Seattle HQ', 18)
(30, 'Human Resources', 5, 800000.00, 'Austin Office', 12)
```

##### Table: `positions`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| position_id | INT | No | Primary key |
| title | STRING | No | Job title |
| level | STRING | No | IC1-IC5 / M1-M3 / D1-D2 / VP |
| salary_min | DECIMAL(10,2) | No | Compensation band lower bound |
| salary_max | DECIMAL(10,2) | No | Compensation band upper bound |
| is_management | BOOLEAN | No | Whether position manages direct reports |

Sample rows (3 of 10):

```
(100, 'Software Engineer', 'IC2', 95000.00, 140000.00, false)
(101, 'Senior Software Engineer', 'IC3', 130000.00, 185000.00, false)
(201, 'Product Manager', 'IC3', 120000.00, 170000.00, false)
```

##### Table: `reviews`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| review_id | INT | No | Primary key |
| employee_id | INT | No | FK to employees |
| reviewer_id | INT | No | FK to employees (manager) |
| review_period | STRING | No | e.g., "H1 2024" or "Q4 2023" |
| rating | INT | No | 1-5 performance rating |
| comments | STRING | Yes | Written feedback summary |

Sample rows (3 of 10):

```
(5001, 1, 2, 'H2 2023', 4, 'Consistently exceeds expectations on backend reliability work')
(5002, 3, 2, 'H2 2023', 5, 'Outstanding cross-team collaboration on the platform migration')
(5003, 2, 6, 'H2 2023', 3, 'Meets expectations; needs improvement in stakeholder communication')
```

##### Table: `attendance`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| attendance_id | INT | No | Primary key |
| employee_id | INT | No | FK to employees |
| date | DATE | No | Calendar date |
| status | STRING | No | present / remote / pto / sick / holiday |
| hours_worked | DOUBLE | Yes | Hours logged (null for non-work days) |
| notes | STRING | Yes | Optional context |

Sample rows (3 of 10):

```
(8001, 1, '2024-01-15', 'present', 8.5, null)
(8002, 2, '2024-01-15', 'remote', 7.0, 'Working from home — school closure')
(8003, 3, '2024-01-15', 'pto', null, 'Annual leave')
```

##### Table: `payroll`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| payroll_id | INT | No | Primary key |
| employee_id | INT | No | FK to employees |
| pay_period | STRING | No | e.g., "2024-01" |
| base_salary | DECIMAL(10,2) | No | Base pay for period |
| bonus | DECIMAL(10,2) | Yes | Variable compensation |
| deductions | DECIMAL(10,2) | No | Tax + benefits deductions |

Sample rows (3 of 10):

```
(9001, 1, '2024-01', 11250.00, 0.00, 3375.00)
(9002, 2, '2024-01', 14166.67, 2000.00, 4850.00)
(9003, 3, '2024-01', 12916.67, 0.00, 3875.00)
```

---

#### Theme 5: Finance

**ID:** `finance`
**Display Name:** Finance
**Description:** Financial operations with transactions, budgets, and invoice management
**Icon:** Dollar sign SVG (from mock: currency path)

##### Table: `transactions`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| transaction_id | INT | No | Primary key |
| account_id | INT | No | FK to accounts |
| type | STRING | No | credit / debit / transfer |
| amount | DECIMAL(12,2) | No | Transaction amount |
| description | STRING | No | Transaction memo |
| transaction_date | TIMESTAMP | No | When transaction occurred |

Sample rows (3 of 10):

```
(1, 1001, 'credit', 15000.00, 'Client payment — Invoice INV-2024-001', '2024-01-15T09:00:00')
(2, 1002, 'debit', 3200.00, 'Office lease — January 2024', '2024-01-01T00:00:00')
(3, 1001, 'transfer', 5000.00, 'Inter-account transfer to savings', '2024-01-10T14:30:00')
```

##### Table: `accounts`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| account_id | INT | No | Primary key |
| account_name | STRING | No | Descriptive account name |
| account_type | STRING | No | checking / savings / credit / investment |
| balance | DECIMAL(12,2) | No | Current balance |
| currency | STRING | No | ISO 4217 currency code |
| opened_date | DATE | No | Account opening date |

Sample rows (3 of 10):

```
(1001, 'Operating Account', 'checking', 284500.00, 'USD', '2020-01-15')
(1002, 'Payroll Account', 'checking', 125000.00, 'USD', '2020-01-15')
(1003, 'Reserve Fund', 'savings', 500000.00, 'USD', '2020-06-01')
```

##### Table: `budgets`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| budget_id | INT | No | Primary key |
| department | STRING | No | Department or cost center |
| fiscal_year | INT | No | Budget year |
| allocated | DECIMAL(12,2) | No | Allocated budget |
| spent | DECIMAL(12,2) | No | Amount spent YTD |
| remaining | DECIMAL(12,2) | No | Remaining = allocated − spent |

Sample rows (3 of 10):

```
(2001, 'Engineering', 2024, 2400000.00, 198000.00, 2202000.00)
(2002, 'Marketing', 2024, 800000.00, 125000.00, 675000.00)
(2003, 'Operations', 2024, 1500000.00, 310000.00, 1190000.00)
```

##### Table: `invoices`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| invoice_id | INT | No | Primary key |
| invoice_number | STRING | No | Human-readable invoice code |
| client_name | STRING | No | Billed-to entity |
| amount | DECIMAL(12,2) | No | Invoice total |
| issued_date | DATE | No | Date invoice was sent |
| due_date | DATE | No | Payment due date |

Sample rows (3 of 10):

```
(3001, 'INV-2024-001', 'Contoso Ltd', 15000.00, '2024-01-05', '2024-02-04')
(3002, 'INV-2024-002', 'Northwind Traders', 8500.00, '2024-01-10', '2024-02-09')
(3003, 'INV-2024-003', 'Adventure Works', 32000.00, '2024-01-15', '2024-02-14')
```

##### Table: `payments`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| payment_id | INT | No | Primary key |
| invoice_id | INT | No | FK to invoices |
| amount | DECIMAL(12,2) | No | Amount paid |
| payment_method | STRING | No | wire / ach / check / credit_card |
| payment_date | DATE | No | When payment was received |
| reference_number | STRING | Yes | Bank or processor reference |

Sample rows (3 of 10):

```
(4001, 3001, 15000.00, 'wire', '2024-01-28', 'WIR-2024-881234')
(4002, 3002, 8500.00, 'ach', '2024-02-05', 'ACH-2024-005567')
(4003, 3003, 16000.00, 'wire', '2024-02-10', 'WIR-2024-881301')
```

##### Table: `categories`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| category_id | INT | No | Primary key |
| name | STRING | No | Category display name |
| type | STRING | No | revenue / expense / asset / liability |
| parent_category_id | INT | Yes | FK to categories (hierarchical) |
| gl_code | STRING | No | General ledger code |
| is_active | BOOLEAN | No | Whether category is in use |

Sample rows (3 of 10):

```
(6001, 'Revenue', 'revenue', null, '4000', true)
(6002, 'Software Licensing', 'revenue', 6001, '4100', true)
(6003, 'Professional Services', 'revenue', 6001, '4200', true)
```

---

#### Theme 6: Healthcare

**ID:** `healthcare`
**Display Name:** Healthcare
**Description:** Clinical data with patients, appointments, prescriptions, and claims
**Icon:** Heart pulse SVG (from mock: pulse/activity path)

##### Table: `patients`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| patient_id | INT | No | Primary key |
| first_name | STRING | No | Patient first name |
| last_name | STRING | No | Patient last name |
| date_of_birth | DATE | No | Date of birth |
| gender | STRING | No | M / F / Other |
| insurance_id | STRING | Yes | Insurance policy number |

Sample rows (3 of 10):

```
(1, 'Emma', 'Thompson', '1985-04-12', 'F', 'BCBS-IL-98234')
(2, 'Liam', 'Nakamura', '1972-11-03', 'M', 'UHC-CA-44521')
(3, 'Sofia', 'Reyes', '1990-08-25', 'F', 'AETNA-TX-71003')
```

##### Table: `appointments`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| appointment_id | INT | No | Primary key |
| patient_id | INT | No | FK to patients |
| provider_id | INT | No | FK to providers |
| appointment_date | TIMESTAMP | No | Scheduled date/time |
| type | STRING | No | checkup / follow_up / procedure / emergency |
| status | STRING | No | scheduled / completed / cancelled / no_show |

Sample rows (3 of 10):

```
(2001, 1, 301, '2024-02-15T09:00:00', 'checkup', 'completed')
(2002, 2, 302, '2024-02-16T10:30:00', 'follow_up', 'completed')
(2003, 3, 301, '2024-02-20T14:00:00', 'procedure', 'scheduled')
```

##### Table: `prescriptions`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| prescription_id | INT | No | Primary key |
| patient_id | INT | No | FK to patients |
| provider_id | INT | No | FK to providers |
| medication | STRING | No | Drug name |
| dosage | STRING | No | e.g., "500mg twice daily" |
| prescribed_date | DATE | No | Date prescribed |

Sample rows (3 of 10):

```
(4001, 1, 301, 'Lisinopril', '10mg once daily', '2024-02-15')
(4002, 2, 302, 'Metformin', '500mg twice daily', '2024-02-16')
(4003, 3, 301, 'Amoxicillin', '250mg three times daily', '2024-02-20')
```

##### Table: `providers`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| provider_id | INT | No | Primary key |
| first_name | STRING | No | Provider first name |
| last_name | STRING | No | Provider last name |
| specialty | STRING | No | Medical specialty |
| npi_number | STRING | No | National Provider Identifier |
| is_accepting_patients | BOOLEAN | No | Currently accepting new patients |

Sample rows (3 of 10):

```
(301, 'Rachel', 'Adams', 'Internal Medicine', '1234567890', true)
(302, 'David', 'Chen', 'Endocrinology', '0987654321', true)
(303, 'Fatima', 'Hassan', 'Cardiology', '1122334455', false)
```

##### Table: `claims`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| claim_id | INT | No | Primary key |
| patient_id | INT | No | FK to patients |
| appointment_id | INT | No | FK to appointments |
| amount_billed | DECIMAL(10,2) | No | Total billed amount |
| amount_covered | DECIMAL(10,2) | No | Insurance coverage |
| status | STRING | No | submitted / approved / denied / paid |

Sample rows (3 of 10):

```
(5001, 1, 2001, 350.00, 280.00, 'paid')
(5002, 2, 2002, 275.00, 220.00, 'approved')
(5003, 3, 2003, 1200.00, 960.00, 'submitted')
```

##### Table: `diagnoses`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| diagnosis_id | INT | No | Primary key |
| patient_id | INT | No | FK to patients |
| appointment_id | INT | No | FK to appointments |
| icd_code | STRING | No | ICD-10 diagnosis code |
| description | STRING | No | Diagnosis description |
| diagnosed_date | DATE | No | Date of diagnosis |

Sample rows (3 of 10):

```
(6001, 1, 2001, 'I10', 'Essential (primary) hypertension', '2024-02-15')
(6002, 2, 2002, 'E11.9', 'Type 2 diabetes mellitus without complications', '2024-02-16')
(6003, 3, 2003, 'J06.9', 'Acute upper respiratory infection, unspecified', '2024-02-20')
```

---

### 2.3 Schema Model

```typescript
/** Schema identifier */
type SchemaId = 'dbo' | 'bronze' | 'silver' | 'gold';

/** Schema definition with visual metadata */
interface SchemaDefinition {
  id: SchemaId;
  displayName: string;       // "dbo", "Bronze", "Silver", "Gold"
  color: string;             // hex color for chip/visual
  colorDim: string;          // dimmed background for chip
  isDefault: boolean;        // true only for dbo
  isLocked: boolean;         // true only for dbo — cannot be toggled
  sortOrder: number;         // display ordering: dbo=0, bronze=1, silver=2, gold=3
}

/** The 4 schema definitions — static/constant */
const SCHEMA_DEFINITIONS: SchemaDefinition[] = [
  { id: 'dbo',    displayName: 'dbo',    color: '#5a6070', colorDim: 'rgba(90,96,112,0.08)',   isDefault: true,  isLocked: true,  sortOrder: 0 },
  { id: 'bronze', displayName: 'Bronze', color: '#b87333', colorDim: 'rgba(184,115,51,0.08)',  isDefault: false, isLocked: false, sortOrder: 1 },
  { id: 'silver', displayName: 'Silver', color: '#7b8794', colorDim: 'rgba(123,135,148,0.08)', isDefault: false, isLocked: false, sortOrder: 2 },
  { id: 'gold',   displayName: 'Gold',   color: '#c5a038', colorDim: 'rgba(197,160,56,0.08)',  isDefault: false, isLocked: false, sortOrder: 3 },
];
```

### 2.4 Page State Model

```typescript
/** Complete state for ThemeSchemaPage */
interface ThemeSchemaPageState {
  /** Currently selected theme ID, or null if none selected */
  selectedTheme: ThemeId | null;

  /** Whether the medallion toggle is ON */
  medallionEnabled: boolean;

  /** Which medallion schemas are active (independent of toggle) */
  medallionSchemas: {
    bronze: boolean;
    silver: boolean;
    gold: boolean;
  };

  /** Whether the page is valid (theme selected = valid) */
  isValid: boolean;

  /** Whether the page has been visited (for stepper state) */
  visited: boolean;

  /** Whether the page is dirty (user has changed from defaults) */
  isDirty: boolean;
}

/** Default state — before any user interaction */
const DEFAULT_STATE: ThemeSchemaPageState = {
  selectedTheme: null,
  medallionEnabled: false,
  medallionSchemas: { bronze: false, silver: false, gold: false },
  isValid: false,
  visited: false,
  isDirty: false,
};
```

### 2.5 Schema Combination Matrix

This matrix defines which schemas are available to DAG nodes on Page 3 based on the user's selection on Page 2:

| Medallion Toggle | Bronze | Silver | Gold | Available Schemas for Nodes | Schema Dropdown Options |
|------------------|--------|--------|------|-----------------------------|------------------------|
| OFF | — | — | — | `[dbo]` | No dropdown shown (only dbo) |
| ON | ☐ | ☐ | ☐ | `[dbo]` | No dropdown shown (only dbo) |
| ON | ☑ | ☐ | ☐ | `[dbo, bronze]` | Dropdown: dbo, bronze |
| ON | ☐ | ☑ | ☐ | `[dbo, silver]` | Dropdown: dbo, silver |
| ON | ☐ | ☐ | ☑ | `[dbo, gold]` | Dropdown: dbo, gold |
| ON | ☑ | ☑ | ☐ | `[dbo, bronze, silver]` | Dropdown: dbo, bronze, silver |
| ON | ☑ | ☐ | ☑ | `[dbo, bronze, gold]` | Dropdown: dbo, bronze, gold |
| ON | ☐ | ☑ | ☑ | `[dbo, silver, gold]` | Dropdown: dbo, silver, gold |
| ON | ☑ | ☑ | ☑ | `[dbo, bronze, silver, gold]` | Dropdown: dbo, bronze, silver, gold |

**Key behavior:** When a schema is deselected on Page 2 after nodes have been assigned to it on Page 3, those nodes fall back to `dbo`. The wizard MUST track this and show a brief toast notification: "2 nodes moved to dbo (schema removed)".

### 2.6 Schema × Node Type Interaction Matrix

All three node types (SQL Table, SQL MLV, PySpark MLV) can be assigned to any schema. There are no restrictions — this is a free-form topology decision per the master spec.

| Node Type | dbo | bronze | silver | gold |
|-----------|-----|--------|--------|------|
| ◇ Plain SQL Table | ✅ | ✅ | ✅ | ✅ |
| ◆ SQL MLV | ✅ | ✅ | ✅ | ✅ |
| ◆ PySpark MLV | ✅ | ✅ | ✅ | ✅ |

### 2.7 Template Serialization Format

When the user saves a template (TemplateManager, C12), the theme and schema selections are serialized as:

```json
{
  "themeSchema": {
    "themeId": "ecommerce",
    "schemas": ["dbo", "bronze", "silver", "gold"],
    "medallionEnabled": true
  }
}
```

When loading a template, ThemeSchemaPage restores from this shape — re-selecting the theme card and toggling the appropriate schema chips.

---

## 3. API Surface

### 3.1 Class Definition

```javascript
/**
 * ThemeSchemaPage — Page 2 of the Infra Wizard
 *
 * Renders a 3×2 theme card grid and schema chip controls.
 * Emits events on theme/schema change for downstream consumption.
 */
class ThemeSchemaPage {
  /**
   * @param {HTMLElement} container — The .page element this page renders into
   * @param {object} options
   * @param {Function} options.onStateChange — callback(pageState) on any change
   * @param {Function} options.onValidationChange — callback(isValid) when validity toggles
   */
  constructor(container, options) { }
}
```

### 3.2 Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `render()` | `render(): void` | void | Builds full DOM (theme grid + schema section) into container |
| `activate()` | `activate(): void` | void | Called when page becomes active. Triggers entrance animations, restores focus. |
| `deactivate()` | `deactivate(): void` | void | Called when page becomes inactive. Pauses animations. |
| `getState()` | `getState(): ThemeSchemaPageState` | state object | Returns current page state for serialization / validation |
| `setState(state)` | `setState(state: Partial<ThemeSchemaPageState>): void` | void | Restores state from template or navigation (Back button from Page 3) |
| `getSelectedTheme()` | `getSelectedTheme(): ThemeDefinition \| null` | ThemeDefinition or null | Returns the full theme object for the selected theme, or null |
| `getActiveSchemas()` | `getActiveSchemas(): SchemaId[]` | array of SchemaId | Returns sorted array of active schema IDs (always includes 'dbo') |
| `isValid()` | `isValid(): boolean` | boolean | Returns true if a theme is selected (schemas always valid) |
| `reset()` | `reset(): void` | void | Resets page to DEFAULT_STATE, clears all selections |
| `dispose()` | `dispose(): void` | void | Removes event listeners, cleans up DOM references |

### 3.3 Events Emitted

Events are dispatched via the `options.onStateChange` callback (not CustomEvent) to keep the component framework-agnostic and consistent with the wizard's internal event bus.

| Event | Payload | When |
|-------|---------|------|
| `themeChanged` | `{ themeId: ThemeId, theme: ThemeDefinition }` | User clicks a theme card |
| `schemasChanged` | `{ schemas: SchemaId[], medallionEnabled: boolean }` | User toggles medallion or clicks a chip |
| `validationChanged` | `{ isValid: boolean, reason: string \| null }` | Page transitions between valid/invalid |
| `pageActivated` | `{ pageIndex: 1 }` | Page becomes active (entrance) |
| `pageDeactivated` | `{ pageIndex: 1 }` | Page becomes inactive (exit) |

### 3.4 Consumed Inputs

| Input | Source | Purpose |
|-------|--------|---------|
| `container` | InfraWizardDialog (C01) | DOM element to render into |
| `initialState` | Template load or Back navigation | Pre-populate selections |
| Wizard data bus | InfraWizardDialog (C01) | Receives `navigate` commands (activate/deactivate) |

### 3.5 Downstream Consumers

| Consumer | What It Uses | How |
|----------|-------------|-----|
| **DagCanvas (C04)** | `getActiveSchemas()` | Populates node schema dropdown options |
| **DagNode (C06)** | `getActiveSchemas()` | Individual node schema selector |
| **CodePreviewPanel (C08)** | `getSelectedTheme()` | Generates themed SQL/PySpark code |
| **ReviewSummary (C09)** | `getState()` | Displays theme + schema summary |
| **ExecutionPipeline (C10)** | `getActiveSchemas()` | Creates schema objects during execution |
| **TemplateManager (C12)** | `getState()` | Serializes theme+schema into template |

---

## 4. State Machine

### 4.1 Page-Level States

```
                                    ┌────────────────────┐
                                    │    UNVISITED        │
                                    │ (initial state)     │
                                    └────────┬───────────┘
                                             │ activate()
                                             ▼
                             ┌───────────────────────────────┐
                             │        PRISTINE               │
                             │  No theme selected            │
                             │  Medallion toggle: OFF        │
                             │  Next button: DISABLED        │
                             └───────┬──────────┬────────────┘
                                     │          │
                          card click │          │ medallion toggle
                                     ▼          ▼
                    ┌────────────────────────────────────────┐
                    │            THEME_SELECTED              │
                    │  One theme card has .selected           │
                    │  Next button: ENABLED                   │
                    │  May or may not have schemas configured  │
                    └────┬──────────┬───────────┬─────────────┘
                         │          │           │
              card click │   toggle │    chip   │ deactivate()
              (different)│   medal. │    click  │
                         ▼          ▼           │
                    ┌────────────────────┐      │
                    │  THEME_CHANGED     │      │
                    │  Swap selected card │      │
                    │  → back to          │      │
                    │    THEME_SELECTED   │      │
                    └────────────────────┘      │
                                                ▼
                                   ┌───────────────────────┐
                                   │     INACTIVE          │
                                   │  Page not visible     │
                                   │  State preserved      │
                                   └───────────────────────┘
```

### 4.2 Theme Card States (Per Card)

Each of the 6 theme cards has its own independent visual state:

| State | CSS Classes | Visual | Transitions To |
|-------|------------|--------|----------------|
| **idle** | `.theme-card` | 1px muted border, flat background | hover, selected |
| **hover** | `.theme-card:hover` | Border brightens to `rgba(109,92,255,0.3)`, translateY(-2px), shadow-md | idle, selected |
| **selected** | `.theme-card.selected` | 2px accent border, accent-dim background, 3px glow ring, checkmark badge | idle (when another card selected) |
| **selected+hover** | `.theme-card.selected:hover` | Same as selected (no additional hover effect) | selected |
| **focus-visible** | `.theme-card:focus-visible` | Same as hover + focus ring (outline: 2px solid accent) | idle, selected |

State transition rules:
- Only ONE card can be `.selected` at any time (radio behavior)
- Selecting a card removes `.selected` from all siblings
- Hover effects apply to ALL cards regardless of selected state (except selected card suppresses hover)
- Animation on selection: `checkPop` keyframe (scale 0 → 1.2 → 1) on the checkmark badge, 200ms

### 4.3 Medallion Toggle States

| State | CSS | Visual |
|-------|-----|--------|
| **off** | `.toggle-track` (no `.on`) | Gray track (`--surface-3`), thumb at left position |
| **on** | `.toggle-track.on` | Accent track (`--accent`), thumb at right (+16px translateX) |

When toggled ON → `.medallion-chips` container transitions from `max-height: 0; opacity: 0` to `max-height: 50px; opacity: 1` (300ms ease).
When toggled OFF → reverse transition. **Does NOT deselect active chips** — chip state is preserved so toggling back ON restores previous selections.

### 4.4 Schema Chip States (Per Chip)

Each of the 3 medallion chips (Bronze, Silver, Gold) has:

| State | CSS | Visual |
|-------|-----|--------|
| **inactive** | `.medallion-chip` | 1.5px border (`--border-bright`), white background, schema color text |
| **active** | `.medallion-chip.active` | Border matches schema color, tinted background (schema `*-dim`), checkmark filled |
| **hover** | `.medallion-chip:hover` | Border darkens slightly (`rgba(0,0,0,0.2)`) |
| **active+hover** | `.medallion-chip.active:hover` | No additional change (already visually distinct) |
| **hidden** | parent `.medallion-chips` without `.show` | Not visible (parent collapsed) |

### 4.5 dbo Chip State

The `dbo` chip is a static element with no interactive states:

| State | CSS | Visual |
|-------|-----|--------|
| **locked** (always) | `.chip.chip-dbo` | `--dbo-dim` background, `--dbo` text color, "● dbo" label, "Always included" helper text |

It has `cursor: default`, no hover effect, no click handler, and `aria-disabled="true"`.

### 4.6 Page Validation State Machine

```
              ┌──────────────┐
              │   INVALID    │ ◄── Initial state
              │ No theme     │     Next button disabled
              └──────┬───────┘
                     │ theme card clicked
                     ▼
              ┌──────────────┐
              │    VALID     │     Next button enabled
              │ Theme chosen │
              └──────────────┘
```

**Schemas never invalidate the page.** The `dbo` schema is always implicitly selected, so even with medallion off and no chips active, the page has at least one valid schema. Only the theme selection gates validation.

---

## 5. Scenarios

### 5.1 Happy Path — First Visit

1. User completes Page 1, clicks "Next"
2. Page 2 slides in from right (`slideLeft` animation, 360ms)
3. Theme cards stagger-animate in (row 1: 50ms, 100ms, 150ms; row 2: 200ms, 250ms, 300ms)
4. Schema section fades in after cards (350ms delay)
5. No theme selected → "Next" button disabled, stepper shows step 2 active
6. User clicks "IoT Telemetry" card
7. Card gains `.selected` class — accent border + glow + checkmark pops in
8. Other cards remain idle
9. "Next" button enables (accent fill, hover effects activate)
10. User clicks "Next" → Page 3 slides in

### 5.2 Theme Change

1. User has "E-Commerce" selected
2. User clicks "Finance" card
3. "E-Commerce" card loses `.selected` → smooth border/background transition (200ms)
4. "Finance" card gains `.selected` → checkmark pops
5. `themeChanged` event fires with `{ themeId: 'finance', theme: FINANCE_THEME }`
6. Downstream consumers (CodePreviewPanel) update on next refresh

### 5.3 Medallion Schema Configuration

1. User has theme selected, medallion toggle is OFF
2. User clicks toggle → slides ON (accent color, thumb moves right)
3. Chip container expands (300ms ease) → Bronze, Silver, Gold chips appear
4. All chips are inactive (not selected) by default
5. User clicks "Bronze" → chip becomes `.active` (border = `#b87333`, background tint)
6. User clicks "Gold" → chip becomes `.active` (border = `#c5a038`, background tint)
7. `schemasChanged` fires: `{ schemas: ['dbo', 'bronze', 'gold'], medallionEnabled: true }`
8. On Page 3, node schema dropdowns now show: dbo, bronze, gold

### 5.4 Medallion Toggle Off/On Preservation

1. User has Bronze + Gold active, toggle is ON
2. User clicks toggle OFF → chips container collapses (300ms)
3. `schemasChanged` fires: `{ schemas: ['dbo'], medallionEnabled: false }`
4. Node schema dropdowns on Page 3 revert to dbo-only
5. User clicks toggle ON again → chips container expands
6. Bronze + Gold are still `.active` (state preserved through toggle cycle)
7. `schemasChanged` fires: `{ schemas: ['dbo', 'bronze', 'gold'], medallionEnabled: true }`

### 5.5 Schema Removal with Existing Node Assignments

1. User on Page 2 has all 3 medallion schemas active
2. User has already been to Page 3 and assigned 2 nodes to "silver" schema
3. User navigates Back to Page 2
4. User clicks "Silver" chip to deselect it
5. `schemasChanged` fires: `{ schemas: ['dbo', 'bronze', 'gold'], medallionEnabled: true }`
6. InfraWizardDialog detects that 2 nodes on Page 3 reference "silver"
7. Those nodes are reassigned to "dbo" (the fallback schema)
8. Toast notification: "2 nodes reassigned to dbo (silver schema removed)"

### 5.6 Template Load

1. User selects a template from TemplateManager
2. TemplateManager calls `setState({ selectedTheme: 'hr', medallionEnabled: true, medallionSchemas: { bronze: true, silver: true, gold: false } })`
3. ThemeSchemaPage:
   - Selects the "HR Analytics" card (adds `.selected`)
   - Toggles medallion ON
   - Activates Bronze and Silver chips, leaves Gold inactive
   - Fires `themeChanged` + `schemasChanged` events
   - Page is valid → "Next" enabled

### 5.7 Back Navigation from Page 3

1. User is on Page 3 (DAG Canvas), clicks "Back"
2. Page 2 slides in from left (`slideRight` animation, 360ms)
3. All prior selections are preserved (theme card selected, schemas configured)
4. No entrance animations replay (cards don't stagger again)
5. User can change theme or schemas
6. If theme changes → code generation on Page 3 will use new theme data on next refresh

### 5.8 Keyboard-Only Theme Selection

1. User Tabs into theme grid
2. First card receives focus ring (`outline: 2px solid var(--accent), offset: 2px`)
3. User presses Arrow Right → focus moves to next card
4. User presses Arrow Down → focus moves to card below (column-aware: card 1 → card 4)
5. User presses Enter or Space → card becomes selected
6. Focus remains on selected card
7. User presses Tab → focus moves to medallion toggle

### 5.9 Screen Reader Walkthrough

1. Screen reader announces: "Data Theme, radio group, 6 items"
2. On first card: "E-Commerce. orders, customers, products, order_items, reviews, inventory. Radio button, 1 of 6, not selected"
3. User arrows to card 3: "IoT Telemetry. sensors, readings, alerts, devices, maintenance, thresholds. Radio button, 3 of 6, not selected"
4. User presses Space: "IoT Telemetry. Selected. Radio button, 3 of 6"
5. Tab to schema section: "Schemas group. dbo, always included. Add medallion schemas, toggle button, off"
6. User activates toggle: "Add medallion schemas, toggle button, on"
7. "Bronze, toggle button, off. Silver, toggle button, off. Gold, toggle button, off"

---

## 6. Visual Spec

### 6.1 Page Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  .page-content                                                       │
│  padding: var(--sp-8) = 32px on all sides                            │
│                                                                      │
│  ┌─── .form-group ──────────────────────────────────────────────┐   │
│  │  label.form-label: "Data Theme"                               │   │
│  │  font-size: --text-sm (12px), font-weight: 600                │   │
│  │  text-transform: uppercase, letter-spacing: 0.05em            │   │
│  │  color: var(--text-muted), margin-bottom: var(--sp-3)         │   │
│  │                                                                │   │
│  │  ┌─── .theme-grid ──────────────────────────────────────────┐ │   │
│  │  │  display: grid                                            │ │   │
│  │  │  grid-template-columns: repeat(3, 1fr)                    │ │   │
│  │  │  gap: var(--sp-3) = 12px                                  │ │   │
│  │  │                                                            │ │   │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │   │
│  │  │  │ Card 1   │  │ Card 2   │  │ Card 3   │  Row 1        │ │   │
│  │  │  │E-Commerce│  │  Sales   │  │   IoT    │               │ │   │
│  │  │  └──────────┘  └──────────┘  └──────────┘               │ │   │
│  │  │                                                            │ │   │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │   │
│  │  │  │ Card 4   │  │ Card 5   │  │ Card 6   │  Row 2        │ │   │
│  │  │  │   HR     │  │ Finance  │  │Healthcare│               │ │   │
│  │  │  └──────────┘  └──────────┘  └──────────┘               │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─── .schema-section ──────────────────────────────────────────┐   │
│  │  margin-top: var(--sp-6) = 24px                               │   │
│  │  label.form-label: "Schemas"                                  │   │
│  │                                                                │   │
│  │  ┌─── .schema-row ─────────────────────────────────────────┐ │   │
│  │  │  [● dbo]  "Always included"                              │ │   │
│  │  └─────────────────────────────────────────────────────────┘ │   │
│  │                                                                │   │
│  │  ┌─── .schema-row ─────────────────────────────────────────┐ │   │
│  │  │  [○] "Add medallion schemas"                             │ │   │
│  │  └─────────────────────────────────────────────────────────┘ │   │
│  │                                                                │   │
│  │  ┌─── .medallion-chips ────────────────────────────────────┐ │   │
│  │  │  [☐ Bronze]  [☐ Silver]  [☐ Gold]                       │ │   │
│  │  │  gap: var(--sp-2) = 8px                                  │ │   │
│  │  │  (collapsed when toggle is OFF)                          │ │   │
│  │  └─────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 Theme Card Anatomy

```
┌──────────────────────────────────────┐
│                           [✓] ← checkmark badge (selected only)
│  ┌──────┐                            │  20×20px circle, accent fill
│  │ ICON │ 36×36px container          │  position: absolute; top: 8px; right: 8px
│  │      │ border-radius: --r-md      │
│  └──────┘ bg: --surface-2            │
│            color: --accent            │
│                                      │
│  Theme Name                          │  font-size: --text-md (13px)
│  font-weight: 600                    │  color: --text
│                                      │
│  orders, customers,                  │  font-family: --mono
│  products, order_items,              │  font-size: --text-xs (10px)
│  reviews, inventory                  │  color: --text-muted
│                                      │  line-height: 1.6
└──────────────────────────────────────┘
  padding: var(--sp-4) = 16px
  border-radius: var(--r-lg) = 10px
  border: 2px solid var(--border-bright)
```

### 6.3 Card Dimensions

| Property | Value | Token |
|----------|-------|-------|
| Padding | 16px | `--sp-4` |
| Border radius | 10px | `--r-lg` |
| Border width (idle) | 2px | — |
| Border color (idle) | `rgba(0,0,0,0.12)` | `--border-bright` |
| Border color (hover) | `rgba(109,92,255,0.3)` | — |
| Border color (selected) | `#6d5cff` | `--accent` |
| Background (idle) | `#ffffff` | `--surface` |
| Background (hover) | `rgba(109,92,255,0.04)` | `--accent-hover` |
| Background (selected) | `rgba(109,92,255,0.07)` | `--accent-dim` |
| Shadow (idle) | none | — |
| Shadow (hover) | `var(--shadow-md)` | `0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` |
| Shadow (selected) | `0 0 0 3px var(--accent-glow)` | glow ring, `rgba(109,92,255,0.15)` |
| Grid gap | 12px | `--sp-3` |
| Icon container | 36×36px | — |
| Checkmark badge | 20×20px circle | — |
| Transition | `all 200ms var(--ease)` | cubic-bezier(0.4, 0, 0.2, 1) |
| Hover lift | `translateY(-2px)` | — |

### 6.4 Schema Section Dimensions

| Element | Property | Value | Token |
|---------|----------|-------|-------|
| dbo chip | padding | `4px 12px` | `--sp-1` / `--sp-3` |
| dbo chip | border-radius | 100px | `--r-full` |
| dbo chip | font-size | 10px | `--text-xs` |
| dbo chip | font-weight | 600 | — |
| dbo chip | font-family | `--mono` | JetBrains Mono |
| dbo chip | background | `rgba(90,96,112,0.08)` | `--dbo-dim` |
| dbo chip | color | `#5a6070` | `--dbo` |
| Toggle track | size | 38×22px | — |
| Toggle track | border-radius | 11px | — |
| Toggle track (off) | background | `--surface-3` | `#ebedf0` |
| Toggle track (on) | background | `--accent` | `#6d5cff` |
| Toggle thumb | size | 18×18px circle | — |
| Toggle thumb | shadow | `0 1px 3px rgba(0,0,0,0.15)` | — |
| Toggle thumb | transition | `transform 200ms var(--spring)` | cubic-bezier(0.34, 1.56, 0.64, 1) |
| Toggle thumb (on) | transform | `translateX(16px)` | — |
| Medallion chip | padding | `8px 12px` | `--sp-2` / `--sp-3` |
| Medallion chip | border-radius | 6px | `--r-md` |
| Medallion chip | border | 1.5px solid `--border-bright` | — |
| Medallion chip | font-size | 12px | `--text-sm` |
| Medallion chip | font-weight | 500 | — |
| Medallion check | size | 16×16px | — |
| Medallion check | border-radius | 3px | — |
| Chips container | gap | 8px | `--sp-2` |
| Chips container | transition | `all 300ms var(--ease)` | — |

### 6.5 Color Reference Table

| Element | Token / Value | Hex | Usage |
|---------|--------------|-----|-------|
| Accent | `--accent` | `#6d5cff` | Selected card border, toggle ON, checkmark badge |
| Accent dim | `--accent-dim` | `rgba(109,92,255,0.07)` | Selected card background |
| Accent hover | `--accent-hover` | `rgba(109,92,255,0.04)` | Card hover background |
| Accent glow | `--accent-glow` | `rgba(109,92,255,0.15)` | Selected card glow ring (3px) |
| Bronze | `--bronze` | `#b87333` | Bronze chip text + active border |
| Bronze dim | `--bronze-dim` | `rgba(184,115,51,0.08)` | Bronze chip active background |
| Silver | `--silver` | `#7b8794` | Silver chip text + active border |
| Silver dim | `--silver-dim` | `rgba(123,135,148,0.08)` | Silver chip active background |
| Gold | `--gold` | `#c5a038` | Gold chip text + active border |
| Gold dim | `--gold-dim` | `rgba(197,160,56,0.08)` | Gold chip active background |
| dbo | `--dbo` | `#5a6070` | dbo chip text |
| dbo dim | `--dbo-dim` | `rgba(90,96,112,0.08)` | dbo chip background |
| Surface | `--surface` | `#ffffff` | Card background (idle) |
| Surface-2 | `--surface-2` | `#f8f9fb` | Icon container background |
| Surface-3 | `--surface-3` | `#ebedf0` | Toggle track (off) |
| Border bright | `--border-bright` | `rgba(0,0,0,0.12)` | Card idle border, chip idle border |
| Text | `--text` | `#1a1d23` | Theme name |
| Text dim | `--text-dim` | `#5a6070` | Toggle label |
| Text muted | `--text-muted` | `#8e95a5` | Sample table names, "Always included" |

### 6.6 Card Animation Choreography

#### Entrance Animation (First Visit)

The 6 theme cards use staggered entrance animations when the page first becomes active. Two keyframe variants create a wave effect:

| Card | Position | Keyframe | Duration | Delay | Effect |
|------|----------|----------|----------|-------|--------|
| Card 1 (E-Commerce) | Row 1, Col 1 | `cardStagger1` | 350ms | 50ms | translateY(12px→0) + fadeIn |
| Card 2 (Sales) | Row 1, Col 2 | `cardStagger1` | 350ms | 100ms | translateY(12px→0) + fadeIn |
| Card 3 (IoT) | Row 1, Col 3 | `cardStagger1` | 350ms | 150ms | translateY(12px→0) + fadeIn |
| Card 4 (HR) | Row 2, Col 1 | `cardStagger2` | 350ms | 200ms | translateY(12px→0) + fadeIn |
| Card 5 (Finance) | Row 2, Col 2 | `cardStagger2` | 350ms | 250ms | translateY(12px→0) + fadeIn |
| Card 6 (Healthcare) | Row 2, Col 3 | `cardStagger2` | 350ms | 300ms | translateY(12px→0) + fadeIn |

CSS (from approved mock):

```css
@keyframes cardStagger1 {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes cardStagger2 {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.page.active .theme-card:nth-child(1) { animation: cardStagger1 350ms var(--ease) 50ms both; }
.page.active .theme-card:nth-child(2) { animation: cardStagger1 350ms var(--ease) 100ms both; }
.page.active .theme-card:nth-child(3) { animation: cardStagger1 350ms var(--ease) 150ms both; }
.page.active .theme-card:nth-child(4) { animation: cardStagger2 350ms var(--ease) 200ms both; }
.page.active .theme-card:nth-child(5) { animation: cardStagger2 350ms var(--ease) 250ms both; }
.page.active .theme-card:nth-child(6) { animation: cardStagger2 350ms var(--ease) 300ms both; }
```

**Total entrance duration:** 650ms (300ms last delay + 350ms animation = 650ms from first to last card complete).

**Schema section entrance:** The `.schema-section` uses a `slideUp` animation with 350ms delay (starts after row 1 cards finish):

```css
.page.active .schema-section { animation: slideUp 400ms var(--ease) 350ms both; }
```

#### Selection Animation

When a card becomes `.selected`:

1. **Border transition:** `border-color` transitions from `--border-bright` to `--accent` over 200ms (ease)
2. **Background transition:** `background` transitions from `--surface` to `--accent-dim` over 200ms (ease)
3. **Glow ring:** `box-shadow` transitions to `0 0 0 3px var(--accent-glow)` over 200ms (ease)
4. **Checkmark badge pop:** `::after` pseudo-element uses `checkPop` keyframe:

```css
@keyframes checkPop {
  0%   { transform: scale(0); }
  60%  { transform: scale(1.2); }
  100% { transform: scale(1); }
}
```

Duration: 200ms. The checkmark "pops" into existence with a spring overshoot.

#### Deselection Animation

When a card loses `.selected`:
1. Border, background, glow all transition back over 200ms (ease)
2. Checkmark badge: `scale(1) → scale(0)` over 150ms (ease-in) — shrinks and disappears

#### Medallion Chip Container

```css
.medallion-chips {
  max-height: 0; opacity: 0;
  transition: all 300ms var(--ease);
  overflow: hidden;
}
.medallion-chips.show {
  max-height: 50px; opacity: 1;
}
```

#### Toggle Thumb

```css
.toggle-thumb {
  transition: transform 200ms var(--spring);  /* cubic-bezier(0.34, 1.56, 0.64, 1) */
}
.toggle-track.on .toggle-thumb {
  transform: translateX(16px);
}
```

The spring easing gives the thumb a slight bounce overshoot when toggling on/off.

#### Re-visit (Back Navigation) — No Replay

When the user navigates Back from Page 3, the entrance animations do NOT replay. Cards appear immediately in their current state. This is controlled by a `_hasAnimated` flag that is set to `true` after the first `activate()`.

---

## 7. Keyboard & Accessibility

### 7.1 ARIA Roles and Attributes

```html
<!-- Theme grid as radiogroup -->
<div class="theme-grid"
     role="radiogroup"
     aria-label="Data Theme"
     aria-required="true"
     id="themeGrid">

  <!-- Individual theme card as radio -->
  <div class="theme-card"
       role="radio"
       aria-checked="false"
       aria-label="E-Commerce. Tables: orders, customers, products, order_items, reviews, inventory"
       tabindex="0"
       data-theme="ecommerce">
    ...
  </div>

  <!-- Selected card -->
  <div class="theme-card selected"
       role="radio"
       aria-checked="true"
       aria-label="IoT Telemetry. Tables: sensors, readings, alerts, devices, maintenance, thresholds"
       tabindex="0"
       data-theme="iot">
    ...
  </div>
</div>

<!-- Schema section -->
<div class="schema-section"
     role="group"
     aria-label="Schema Configuration">

  <!-- dbo chip (static) -->
  <span class="chip chip-dbo"
        role="status"
        aria-label="dbo schema, always included">
    ● dbo
  </span>

  <!-- Medallion toggle -->
  <button class="toggle-track"
          role="switch"
          aria-checked="false"
          aria-label="Add medallion schemas"
          id="medallionToggle">
    <span class="toggle-thumb"></span>
  </button>

  <!-- Medallion chips (when visible) -->
  <div class="medallion-chips"
       role="group"
       aria-label="Medallion schemas"
       aria-hidden="true">  <!-- true when collapsed -->

    <button class="medallion-chip"
            role="switch"
            aria-checked="false"
            aria-label="Bronze schema"
            data-schema="bronze">
      <span class="medallion-check">✓</span>
      Bronze
    </button>
    <!-- Silver, Gold similar -->
  </div>
</div>
```

### 7.2 Keyboard Navigation Map

| Key | Context | Action |
|-----|---------|--------|
| **Tab** | Anywhere | Move focus: theme grid → medallion toggle → chip group → footer buttons |
| **Shift+Tab** | Anywhere | Reverse tab order |
| **Arrow Right** | Theme grid (focused) | Move focus to next card (wraps at row end) |
| **Arrow Left** | Theme grid (focused) | Move focus to previous card (wraps at row start) |
| **Arrow Down** | Theme grid (focused) | Move focus to card directly below (col-aware: card N → card N+3) |
| **Arrow Up** | Theme grid (focused) | Move focus to card directly above (col-aware: card N → card N−3) |
| **Enter / Space** | Theme card focused | Select the focused card (radio behavior) |
| **Enter / Space** | Medallion toggle focused | Toggle on/off |
| **Enter / Space** | Medallion chip focused | Toggle chip active/inactive |
| **Arrow Right** | Chip group | Move focus to next chip |
| **Arrow Left** | Chip group | Move focus to previous chip |
| **Escape** | Anywhere on page | No action (handled by dialog-level Escape) |

### 7.3 Focus Management

**Grid focus model:** The theme grid uses a roving tabindex pattern. Only one card in the grid has `tabindex="0"` at a time (the focused/selected one). All others have `tabindex="-1"`. Arrow keys move the `tabindex="0"` to the target card and focus it.

**Initial focus on activate:** When the page becomes active:
- First visit (no selection): Focus the first theme card
- Return visit (with selection): Focus the previously selected card

**After selection:** Focus remains on the just-selected card. The user must explicitly Tab to advance to the schema section.

### 7.4 Screen Reader Announcements

| Trigger | Announcement |
|---------|-------------|
| Page becomes active | "Step 2 of 5: Theme and Schema Setup" (via `aria-live` region in stepper) |
| Theme card selected | "{Theme Name}. Selected." (via `aria-checked` change) |
| Medallion toggle on | "Add medallion schemas. On." |
| Medallion toggle off | "Add medallion schemas. Off." |
| Bronze chip activated | "Bronze schema. On." |
| Bronze chip deactivated | "Bronze schema. Off." |
| Validation pass (theme selected) | "Next button now available" (via `aria-live` polite on Next button region) |
| Schema removal toast | "2 nodes reassigned to dbo. Silver schema removed." (via toast `aria-live` assertive) |

### 7.5 Color Contrast Compliance

All text-on-background combinations meet WCAG 2.1 AA (4.5:1 minimum):

| Element | Foreground | Background | Contrast Ratio | Pass? |
|---------|-----------|------------|----------------|-------|
| Theme name (idle) | `#1a1d23` | `#ffffff` | 16.8:1 | ✅ AAA |
| Theme name (selected) | `#1a1d23` | `rgba(109,92,255,0.07)` ≈ `#f5f3ff` | 15.2:1 | ✅ AAA |
| Table names (idle) | `#8e95a5` | `#ffffff` | 3.1:1 | ⚠️ AA (large text only) |
| Table names: alternative | Use `#5a6070` | `#ffffff` | 5.9:1 | ✅ AA |
| dbo chip text | `#5a6070` | `rgba(90,96,112,0.08)` ≈ `#f3f4f5` | 5.5:1 | ✅ AA |
| Bronze chip text | `#b87333` | `rgba(184,115,51,0.08)` ≈ `#faf5f0` | 3.4:1 | ⚠️ Needs darkening |
| Bronze chip: corrected | `#8a5726` | `rgba(184,115,51,0.08)` | 5.1:1 | ✅ AA |
| Gold chip text | `#c5a038` | `rgba(197,160,56,0.08)` ≈ `#faf8f0` | 2.5:1 | ❌ Fails |
| Gold chip: corrected | `#8a7028` | `rgba(197,160,56,0.08)` | 5.0:1 | ✅ AA |
| Silver chip text | `#7b8794` | `rgba(123,135,148,0.08)` ≈ `#f4f5f6` | 3.4:1 | ⚠️ Needs darkening |
| Silver chip: corrected | `#5b6570` | `rgba(123,135,148,0.08)` | 5.2:1 | ✅ AA |

> **A11y Action Item:** The mock's schema chip colors for bronze, silver, and gold text on their dim backgrounds may not meet AA contrast. The implementation MUST use darkened text variants for the chip label text. The chip border and active background can retain the original colors since borders are decorative and backgrounds carry no text-critical information. An acceptable approach: keep the current colors but add a `--bronze-text`, `--silver-text`, `--gold-text` token set with darkened values.

### 7.6 Motion Preferences

```css
@media (prefers-reduced-motion: reduce) {
  .theme-card,
  .toggle-thumb,
  .medallion-chips,
  .medallion-chip {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }
  .page.active .theme-card { animation: none !important; opacity: 1; transform: none; }
}
```

When `prefers-reduced-motion: reduce` is active, all stagger animations, hover lifts, toggle bounces, and checkmark pops are suppressed. Elements appear instantly.

---

## 8. Error Handling

### 8.1 Error States

ThemeSchemaPage has minimal error surface — it's a selection-based page with no API calls, text input, or async operations. The error handling is primarily validation feedback.

| Error Condition | Detection | User Feedback | Recovery |
|-----------------|-----------|---------------|----------|
| No theme selected when "Next" clicked | `isValid()` returns false | "Next" button remains disabled (never enters error state). Stepper step 2 does not show checkmark. If user somehow triggers validation: inline message below theme grid — "Please select a data theme to continue" in `--status-fail` color. | User clicks a theme card |
| Template load with unknown themeId | `setState()` receives unrecognized `themeId` | Console warning. Theme remains unselected. Toast: "Template theme not recognized — please select a theme" | User selects a theme manually |
| Template load with corrupted schema data | `setState()` receives malformed `medallionSchemas` | Console warning. Schemas reset to defaults (medallion off, no chips active). Toast: "Schema configuration reset to defaults" | User reconfigures schemas |
| Schema removal orphans nodes | `schemasChanged` event processed by DagCanvas | Toast (from InfraWizardDialog, not ThemeSchemaPage): "N nodes reassigned to dbo (X schema removed)" | Automatic — no user action needed. Nodes silently reassigned. |
| DOM container missing | `render()` called with null container | `throw new Error('ThemeSchemaPage: container element is required')` | Developer bug — fix container wiring |

### 8.2 Defensive Guards

```javascript
// Guard: theme ID validation
_selectTheme(themeId) {
  const theme = THEME_REGISTRY.find(t => t.id === themeId);
  if (!theme) {
    console.warn(`ThemeSchemaPage: Unknown theme ID "${themeId}"`);
    return;
  }
  // proceed with selection...
}

// Guard: prevent double-activation
activate() {
  if (this._isActive) return;
  this._isActive = true;
  // entrance logic...
}

// Guard: schema computation never returns empty
getActiveSchemas() {
  const schemas = ['dbo']; // dbo is ALWAYS included
  if (this._state.medallionEnabled) {
    if (this._state.medallionSchemas.bronze) schemas.push('bronze');
    if (this._state.medallionSchemas.silver) schemas.push('silver');
    if (this._state.medallionSchemas.gold)   schemas.push('gold');
  }
  return schemas; // minimum: ['dbo']
}
```

### 8.3 No-Op Safety

| Action | Guard |
|--------|-------|
| Click on already-selected theme card | No-op (`.selected` class already present, no event fires) |
| Click on dbo chip | No-op (no click handler attached, `cursor: default`) |
| Click medallion chip when toggle OFF | Not possible (chips hidden, `pointer-events: none` via `max-height: 0; overflow: hidden`) |
| `dispose()` called twice | Idempotent — listeners removed only if present (nullify references) |
| `setState()` with partial data | Merges with current state using `Object.assign`, no overwrite of missing fields |

---

## 9. Performance

### 9.1 Render Budget

ThemeSchemaPage is one of the simplest wizard pages — no canvas, no API calls, no async work. The performance budget is generous.

| Metric | Budget | Expected | Notes |
|--------|--------|----------|-------|
| `render()` time | < 5ms | ~2ms | 6 cards + schema section = ~20 DOM elements total |
| First paint (with animations) | < 700ms | 650ms | Stagger animation: last card completes at 650ms |
| Theme card click → visual feedback | < 16ms (1 frame) | ~1ms | CSS class toggle only, no layout thrash |
| Medallion toggle → chip reveal | < 320ms | 300ms | CSS transition, no JS layout calculation |
| `getActiveSchemas()` call | < 0.1ms | ~0.01ms | Array construction from 4 booleans |
| `getState()` call | < 0.1ms | ~0.01ms | Object copy |
| Memory footprint | < 50KB | ~20KB | 6 ThemeDefinition objects with sample data |

### 9.2 DOM Efficiency

- **Card rendering:** Single `innerHTML` assignment for the grid, not 6 sequential `appendChild` calls
- **Event delegation:** One click listener on `.theme-grid` (not 6 on individual cards), per mock pattern
- **Schema events:** One click listener on `.medallion-chips` container (not 3 on individual chips)
- **No MutationObserver needed** — all state changes are driven by direct user interaction
- **No requestAnimationFrame loops** — all animations are CSS-only (no JS-driven animation frames)

### 9.3 Theme Data Loading

The theme registry (`THEME_REGISTRY`) is a static constant defined once at module load time. It is NOT loaded from a file or API. Each theme contains:
- 6 tables × ~6 columns × column metadata ≈ 36 column definitions
- 6 tables × 10 sample rows × ~6 values ≈ 360 sample values
- Total per theme: ~400 data points
- Total across all 6 themes: ~2,400 data points

This data is embedded in the JavaScript module (not fetched). The `render()` method only reads the currently selected theme's table names for display; it does NOT load all sample data into the DOM. Sample data is accessed lazily by the code generation engine (CodePreviewPanel, C08) when needed.

### 9.4 Animation Performance

All animations use `transform` and `opacity` exclusively — both are GPU-composited properties. No `width`, `height`, `top`, `left`, or `margin` animations that would trigger layout recalculation.

Exception: The medallion chips container uses `max-height` for expand/collapse. This triggers layout but on a very small DOM subtree (3 chips). The performance impact is negligible (< 1ms).

### 9.5 What NOT to Optimize

- **Do not** lazy-load theme cards — all 6 are always visible
- **Do not** virtualize the grid — 6 items is far below any virtualization threshold
- **Do not** debounce card click events — they're discrete user actions, not continuous
- **Do not** cache `getActiveSchemas()` — it's a trivial computation called infrequently
- **Do not** use Web Workers — no computation warrants thread offloading

---

## 10. Implementation Notes

### 10.1 File Placement

```
src/frontend/js/
  infra-wizard/
    theme-schema-page.js      ← This component
    theme-registry.js          ← THEME_REGISTRY constant (all 6 themes with sample data)
    schema-definitions.js      ← SCHEMA_DEFINITIONS constant
```

The theme registry is extracted to a separate file because it's ~15KB of data (6 themes × 6 tables × columns + sample rows). Keeping it separate allows the build system to manage it independently and makes the component file cleaner.

### 10.2 CSS Integration

All CSS for ThemeSchemaPage is already defined in the approved mock (`mocks/infra-wizard.html`). During `build-html.py` inlining, these styles are included in the single HTML output. The CSS class names from the mock are authoritative:

| CSS Class | Element |
|-----------|---------|
| `.theme-grid` | Grid container for cards |
| `.theme-card` | Individual theme card |
| `.theme-card.selected` | Selected state |
| `.theme-icon` | Icon container within card |
| `.theme-name` | Theme name text |
| `.theme-tables` | Sample table names (mono font) |
| `.schema-section` | Schema configuration section |
| `.schema-row` | Row within schema section |
| `.chip` | Base chip class |
| `.chip-dbo` | dbo chip variant |
| `.toggle-track` | Medallion toggle track |
| `.toggle-track.on` | Toggle ON state |
| `.toggle-thumb` | Toggle thumb |
| `.toggle-label` | "Add medallion schemas" text |
| `.medallion-chips` | Chips container |
| `.medallion-chips.show` | Expanded state |
| `.medallion-chip` | Individual medallion chip |
| `.medallion-chip.active` | Active chip state |
| `.medallion-check` | Checkbox visual within chip |

### 10.3 Integration with InfraWizardDialog (C01)

ThemeSchemaPage is instantiated by InfraWizardDialog and receives lifecycle calls:

```javascript
// In InfraWizardDialog
this._pages = [
  new InfraSetupPage(pageContainers[0], { onStateChange: this._onPageChange.bind(this) }),
  new ThemeSchemaPage(pageContainers[1], { onStateChange: this._onPageChange.bind(this) }),
  new DagCanvas(pageContainers[2], { onStateChange: this._onPageChange.bind(this) }),
  // ...
];

// Page navigation
_goToPage(index) {
  this._pages[this._currentPage].deactivate();
  this._currentPage = index;
  this._pages[index].activate();
  this._updateStepper();
  this._updateNavigationButtons();
}

// Validation gating
_updateNavigationButtons() {
  const canAdvance = this._pages[this._currentPage].isValid();
  this._nextBtn.disabled = !canAdvance;
  this._nextBtn.classList.toggle('disabled', !canAdvance);
}
```

### 10.4 Data Flow Diagram

```
ThemeSchemaPage                    InfraWizardDialog                 DagCanvas (Page 3)
━━━━━━━━━━━━━━━                   ━━━━━━━━━━━━━━━━━                ━━━━━━━━━━━━━━━━━━
                                                                    
User clicks card ──► themeChanged ──► wizardState.theme updated ──► CodeGen uses new theme
                     event                                          
                                                                    
User toggles ──────► schemasChanged ─► wizardState.schemas updated ─► Node schema dropdowns
schema chip          event                                            repopulated
                                                                    
                                    ┌── If schemas removed and ──► Nodes on removed schema
                                    │   nodes exist on them        reassigned to 'dbo'
                                    │                              + toast notification
                                    └───────────────────────────────
```

### 10.5 Theme Card Table Name Display

The approved mock shows 5 table names per card. Our spec defines 6 tables per theme. The card should display all 6, separated by commas, with the mono font (`--mono`) at `--text-xs` (10px). The text should wrap naturally within the card — no truncation, no ellipsis. The `line-height: 1.6` provides comfortable reading density.

Example rendered text for E-Commerce card:
```
orders, customers, products,
order_items, reviews, inventory
```

### 10.6 Theme Icon SVG Catalog

Each theme uses an inline SVG icon (18×18 viewBox, stroke-based, 2px stroke). These are taken directly from the approved mock:

| Theme | Icon Description | SVG Source |
|-------|-----------------|------------|
| E-Commerce | Shopping cart | `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>` |
| Sales Analytics | Activity/pulse line | `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>` |
| IoT Telemetry | Server/device box | `<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>` |
| HR Analytics | Users/people | `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>` |
| Finance | Dollar sign | `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>` |
| Healthcare | Heart pulse | `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>` |

> **Note:** The mock uses the same SVG path for both Sales Analytics and Healthcare (activity line). The implementation should differentiate Healthcare with a distinct icon — recommended: the medical cross or heartbeat variant. Pixel to finalize during implementation.

### 10.7 Theme ID to Display Name Mapping

| ThemeId | data-theme Attribute | Display Name | Mock Card Label |
|---------|---------------------|--------------|-----------------|
| `ecommerce` | `data-theme="ecommerce"` | E-Commerce | E-Commerce |
| `sales` | `data-theme="sales"` | Sales Analytics | Sales & Marketing |
| `iot` | `data-theme="iot"` | IoT Telemetry | IoT / Sensors |
| `hr` | `data-theme="hr"` | HR Analytics | HR & People |
| `finance` | `data-theme="finance"` | Finance | Finance |
| `healthcare` | `data-theme="healthcare"` | Healthcare | Healthcare |

> **Note:** The master spec and mock use slightly different display names (e.g., "Sales & Marketing" vs "Sales Analytics"). The master spec names are authoritative. The mock names should be updated during implementation to match the spec.

### 10.8 Sample Data Generation Notes

Each theme generates exactly **10 sample rows per table**. The sample data must be:

1. **Realistic** — Names, dates, and values should look plausible (not "test1", "test2")
2. **Referentially consistent** — FK values should point to valid PKs in related tables
3. **Thematically coherent** — E-Commerce data should feel like an e-commerce system
4. **Diverse** — Show variety in enum columns (e.g., multiple `status` values, different `types`)
5. **Date-ranged** — Timestamps should fall within a reasonable window (Jan–Mar 2024)
6. **Non-offensive** — No real people, no controversial content, no PII patterns
7. **Size-appropriate** — DECIMAL values should be realistic for the domain (not $0.01 or $999,999,999)

The complete 10-row datasets for each table are defined in `theme-registry.js` and consumed by the code generation engine (C08). This spec shows 3 representative rows per table — the remaining 7 follow the same patterns.

### 10.9 Validation Integration

```javascript
// In ThemeSchemaPage
_validatePage() {
  const wasValid = this._state.isValid;
  this._state.isValid = this._state.selectedTheme !== null;

  if (this._state.isValid !== wasValid) {
    this._options.onStateChange({
      type: 'validationChanged',
      isValid: this._state.isValid,
      reason: this._state.isValid ? null : 'No theme selected',
    });
  }
}
```

### 10.10 Edge Cases & Boundary Conditions

| Scenario | Expected Behavior |
|----------|-------------------|
| Rapid double-click on same card | No-op on second click (already selected) |
| Rapid click on two different cards | Last click wins. No race condition — CSS class operations are synchronous. |
| Click theme card while page transition animating | Allowed — card click is processed immediately. The stagger animation is CSS-only and doesn't block interaction. |
| Toggle medallion rapidly 5 times | Each toggle fires `schemasChanged`. The CSS transition is interruptible — it reverses mid-animation if toggled again. Final state matches final toggle position. |
| Browser back button during wizard | Handled by InfraWizardDialog (C01), not ThemeSchemaPage. Dialog intercepts browser navigation. |
| Dialog resize while on Page 2 | Theme grid is `repeat(3, 1fr)` — cards resize responsively. At very narrow widths (< 400px available), cards may become too narrow for text. The dialog's min-width constraint (640px) prevents this. |
| Copy/paste on card text | Allowed but no special handling. Card text is user-selectable (not `user-select: none`). Selection does not interfere with card click because the click handler checks `e.target.closest('.theme-card')`. |
| Touch interaction (tablet) | `:hover` styles should not persist after touch release. Use `@media (hover: hover)` for hover-only styles. Touch tap = click. |

### 10.11 Testing Checklist

| Test ID | Category | Test Description | Priority |
|---------|----------|-----------------|----------|
| TSP-01 | Render | Page renders 6 theme cards in 3×2 grid | P0 |
| TSP-02 | Render | Each card shows icon, name, and table names | P0 |
| TSP-03 | Render | Schema section shows locked dbo chip | P0 |
| TSP-04 | Render | Medallion toggle is OFF by default | P0 |
| TSP-05 | Selection | Clicking card selects it (adds `.selected`) | P0 |
| TSP-06 | Selection | Only one card can be selected at a time | P0 |
| TSP-07 | Selection | Selecting a card enables "Next" button | P0 |
| TSP-08 | Selection | Checkmark badge appears on selected card | P1 |
| TSP-09 | Selection | Card hover shows lift + shadow | P1 |
| TSP-10 | Schema | Toggle ON reveals 3 medallion chips | P0 |
| TSP-11 | Schema | Toggle OFF hides medallion chips | P0 |
| TSP-12 | Schema | Clicking chip toggles active state | P0 |
| TSP-13 | Schema | `getActiveSchemas()` always includes 'dbo' | P0 |
| TSP-14 | Schema | `getActiveSchemas()` includes active chips when toggle ON | P0 |
| TSP-15 | Schema | `getActiveSchemas()` returns only ['dbo'] when toggle OFF | P0 |
| TSP-16 | Schema | Chip state preserved through toggle cycle | P1 |
| TSP-17 | State | `getState()` returns correct current state | P0 |
| TSP-18 | State | `setState()` restores selections from template | P0 |
| TSP-19 | State | `reset()` clears all selections | P1 |
| TSP-20 | Validation | `isValid()` returns false when no theme selected | P0 |
| TSP-21 | Validation | `isValid()` returns true when theme selected | P0 |
| TSP-22 | Events | `themeChanged` fires on card selection | P0 |
| TSP-23 | Events | `schemasChanged` fires on chip toggle | P0 |
| TSP-24 | Events | `schemasChanged` fires on medallion toggle | P0 |
| TSP-25 | Animation | Cards stagger-animate on first visit | P2 |
| TSP-26 | Animation | Cards don't re-animate on Back navigation | P2 |
| TSP-27 | A11y | Theme grid has `role="radiogroup"` | P0 |
| TSP-28 | A11y | Cards have `role="radio"` and `aria-checked` | P0 |
| TSP-29 | A11y | Arrow keys navigate between cards | P1 |
| TSP-30 | A11y | Enter/Space selects focused card | P1 |
| TSP-31 | A11y | Toggle has `role="switch"` and `aria-checked` | P1 |
| TSP-32 | A11y | Chips have `role="switch"` and `aria-checked` | P1 |
| TSP-33 | A11y | `prefers-reduced-motion` disables animations | P2 |
| TSP-34 | Integration | Schema changes propagate to DagCanvas dropdown | P0 |
| TSP-35 | Integration | Theme changes propagate to CodePreviewPanel | P0 |
| TSP-36 | Edge | Rapid double-click on card: no-op | P2 |
| TSP-37 | Edge | Toggle rapidly: final state correct | P2 |
| TSP-38 | Edge | `dispose()` removes all event listeners | P1 |

### 10.12 Dependencies

| Dependency | Type | Required By |
|-----------|------|-------------|
| `InfraWizardDialog` (C01) | Parent container | Lifecycle management, page navigation |
| `DagCanvas` (C04) | Downstream consumer | Schema dropdown population |
| `CodePreviewPanel` (C08) | Downstream consumer | Theme-based code generation |
| `ReviewSummary` (C09) | Downstream consumer | Theme + schema display |
| `TemplateManager` (C12) | Bidirectional | Save/load theme + schema state |
| Design tokens (CSS custom properties) | Build dependency | All visual styling |
| `theme-registry.js` | Module dependency | Complete theme data |
| `schema-definitions.js` | Module dependency | Schema constants |

### 10.13 Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| OQ-1 | Should Healthcare icon be differentiated from Sales Analytics? Mock uses same SVG path. | Pixel | OPEN — recommend unique icon |
| OQ-2 | Should chip text colors be darkened for AA contrast? Spec recommends yes with new tokens. | Pixel | OPEN — implement `--bronze-text` etc. |
| OQ-3 | When all 3 medallion chips are deselected but toggle is ON, should the toggle auto-turn OFF? | Sana | OPEN — recommend NO (explicit toggle) |
| OQ-4 | Should the mock display names (e.g., "Sales & Marketing") be updated to match spec ("Sales Analytics")? | Sana | OPEN — spec names are authoritative |
| OQ-5 | Should cards show a brief description below table names (like Notion/Discord patterns)? | Pixel | OPEN — mock doesn't include description |

### 10.14 Revision History

| Date | Author | Change |
|------|--------|--------|
| 2025-07-20 | Pixel (spec) | Initial P1 component deep spec |

---

*End of C03-ThemeSchemaPage Component Deep Spec*

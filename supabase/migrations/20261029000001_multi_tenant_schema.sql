-- ============================================================================
-- Supabase PostgreSQL Multi-Tenant Migration for Restaurant POS & KDS
-- Egress-Optimized, RLS-Hardened, Atomic Checkout RPCs
-- ============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. CUSTOM TYPES
DO $$ BEGIN
  CREATE TYPE order_type AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY', 'DRIVE_THRU', 'QR_ORDER', 'KIOSK', 'PHONE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('OPEN', 'BILLED', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kot_status AS ENUM ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kot_item_status AS ENUM ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE table_status AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'OUT_OF_SERVICE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'UPI', 'WALLET', 'BANK_TRANSFER', 'GIFT_CARD', 'STORE_CREDIT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE inventory_tracking AS ENUM ('NONE', 'RECIPE', 'DIRECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM ('RECEIPT', 'WASTE', 'ADJUSTMENT', 'CONSUMPTION', 'REVERSAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. JWT APP_METADATA TENANT EXTRACTION HELPER
-- Cached & stable function to extract tenant_id directly from JWT claims without subqueries
CREATE OR REPLACE FUNCTION auth_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

-- 4. CORE OPERATIONAL TABLES (ALL WITH TENANT_ID)

-- 4.1 Tenants (Restaurants)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  legal_name TEXT,
  slug TEXT UNIQUE,
  subscription_tier TEXT NOT NULL DEFAULT 'standard',
  is_active BOOLEAN NOT NULL DEFAULT true,
  currency TEXT NOT NULL DEFAULT 'INR',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  logo_url TEXT,
  upi_vpa TEXT,
  upi_payee_name TEXT,
  loyalty_point_value NUMERIC(6,2) NOT NULL DEFAULT 1.00,
  loyalty_earn_per_currency INTEGER NOT NULL DEFAULT 100,
  menu_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.2 Branches / Outlets
CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  gst_number TEXT,
  country TEXT NOT NULL DEFAULT 'IN',
  tax_regime TEXT NOT NULL DEFAULT 'INDIA_GST',
  tax_mode TEXT NOT NULL DEFAULT 'INCLUSIVE',
  tax_label TEXT,
  tax_id TEXT,
  auto_confirm_orders BOOLEAN NOT NULL DEFAULT false,
  auto_confirm_reservations BOOLEAN NOT NULL DEFAULT false,
  kiosk_token TEXT UNIQUE,
  kiosk_dine_in_enabled BOOLEAN NOT NULL DEFAULT true,
  kiosk_takeaway_enabled BOOLEAN NOT NULL DEFAULT true,
  printer_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.3 Users / Staff Profiles (Linked to Supabase auth.users)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'CASHIER',
  pin_hash TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.4 Floors
CREATE TABLE IF NOT EXISTS floors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.5 Tables
CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  floor_id UUID NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  name TEXT,
  capacity INTEGER NOT NULL DEFAULT 2,
  status table_status NOT NULL DEFAULT 'AVAILABLE',
  status_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  pos_x DOUBLE PRECISION NOT NULL DEFAULT 0,
  pos_y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION NOT NULL DEFAULT 80,
  height DOUBLE PRECISION NOT NULL DEFAULT 80,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  shape TEXT NOT NULL DEFAULT 'square',
  color TEXT,
  assigned_waiter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  qr_token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tables_floor_number UNIQUE (floor_id, number)
);

-- 4.6 Kitchen Stations
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.7 Menu Categories
CREATE TABLE IF NOT EXISTS menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  show_on_website BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.8 Ingredients (Stock items)
CREATE TABLE IF NOT EXISTS ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  unit TEXT NOT NULL,
  reorder_level NUMERIC(12,3) NOT NULL DEFAULT 0,
  current_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(12,4) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ingredients_branch_name UNIQUE (branch_id, name)
);

-- 4.9 Menu Items
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  station_id UUID REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  image_url TEXT,
  price NUMERIC(12,2) NOT NULL,
  tax_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  cost_price NUMERIC(12,2),
  prep_time_minutes INTEGER,
  calories INTEGER,
  is_veg BOOLEAN NOT NULL DEFAULT true,
  is_vegan BOOLEAN NOT NULL DEFAULT false,
  is_jain BOOLEAN NOT NULL DEFAULT false,
  is_halal BOOLEAN NOT NULL DEFAULT false,
  is_gluten_free BOOLEAN NOT NULL DEFAULT false,
  allergens TEXT[] NOT NULL DEFAULT '{}',
  available_from TEXT,
  available_to TEXT,
  barcode TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_combo BOOLEAN NOT NULL DEFAULT false,
  inventory_tracking inventory_tracking NOT NULL DEFAULT 'NONE',
  stock_ingredient_id UUID REFERENCES ingredients(id) ON DELETE SET NULL,
  stock_quantity_per_sale NUMERIC(12,3) NOT NULL DEFAULT 1,
  half_price NUMERIC(12,2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.10 Modifier Groups & Modifiers
CREATE TABLE IF NOT EXISTS modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER NOT NULL DEFAULT 1,
  is_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_adjustment NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_rate_percent NUMERIC(5,2),
  kitchen_note TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_item_id, modifier_group_id)
);

-- 4.11 Recipe Ingredients (BOM)
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_recipe_ingredients UNIQUE (menu_item_id, ingredient_id)
);

-- 4.12 Stock Movements (Ledger)
CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  type stock_movement_type NOT NULL,
  quantity NUMERIC(12,3) NOT NULL,
  note TEXT,
  order_id UUID,
  created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.13 Customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.14 Orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  type order_type NOT NULL DEFAULT 'DINE_IN',
  status order_status NOT NULL DEFAULT 'OPEN',
  channel TEXT NOT NULL DEFAULT 'STAFF',
  acceptance TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
  guest_count INTEGER,
  guest_name TEXT,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_type TEXT,
  discount_value NUMERIC(12,2),
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  tip_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0,
  loyalty_discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  client_request_id TEXT,
  scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  billed_at TIMESTAMPTZ,
  CONSTRAINT uq_orders_branch_order_number UNIQUE (branch_id, order_number),
  CONSTRAINT uq_orders_branch_client_request UNIQUE (branch_id, client_request_id)
);

-- 4.15 Order Items
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL,
  unit_price_snapshot NUMERIC(12,2) NOT NULL,
  tax_rate_snapshot NUMERIC(5,2) NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  line_total NUMERIC(12,2) NOT NULL,
  kitchen_note TEXT,
  status kot_item_status NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.16 Order Item Modifiers
CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id UUID NOT NULL REFERENCES modifiers(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL,
  price_adj_snapshot NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- 4.17 KOTs (Kitchen Order Tickets)
CREATE TABLE IF NOT EXISTS kots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id UUID REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  ticket_number TEXT NOT NULL,
  status kot_status NOT NULL DEFAULT 'NEW',
  printed_count INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.18 KOT Items
CREATE TABLE IF NOT EXISTS kot_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kot_id UUID NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  status kot_item_status NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.19 Payments
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method payment_method NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  tendered NUMERIC(12,2),
  change_given NUMERIC(12,2),
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.20 Settings / Store Configurations
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ============================================================================
-- 5. PERFORMANCE & EGRESS INDEXES
-- ============================================================================

-- Primary tenant_id indexes for all tables (for ultra-fast RLS evaluation)
CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_floors_tenant ON floors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tables_tenant ON tables(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_stations_tenant ON kitchen_stations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_categories_tenant ON menu_categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_tenant ON ingredients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifier_groups_tenant ON modifier_groups(tenant_id);
CREATE INDEX IF NOT EXISTS idx_modifiers_tenant ON modifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_tenant ON recipe_ingredients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant ON stock_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant ON order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_tenant ON order_item_modifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kots_tenant ON kots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kot_items_tenant ON kot_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);

-- Operational composite indexes for fast POS & KDS hot paths
CREATE INDEX IF NOT EXISTS idx_orders_pos_lookup 
  ON orders(tenant_id, branch_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table_active 
  ON orders(tenant_id, table_id, status) WHERE status IN ('OPEN', 'BILLED');
CREATE INDEX IF NOT EXISTS idx_order_items_order 
  ON order_items(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_tables_active 
  ON tables(tenant_id, branch_id, floor_id, status);
CREATE INDEX IF NOT EXISTS idx_menu_items_catalog 
  ON menu_items(tenant_id, branch_id, category_id, is_active);
CREATE INDEX IF NOT EXISTS idx_menu_items_updated 
  ON menu_items(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_kots_kitchen_stream 
  ON kots(tenant_id, branch_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ledger 
  ON stock_movements(tenant_id, ingredient_id, created_at DESC);

-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- Zero subqueries: extracts tenant_id from auth.jwt() -> 'app_metadata' ->> 'tenant_id'
-- ============================================================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kots ENABLE ROW LEVEL SECURITY;
ALTER TABLE kot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;

-- Tenants: authenticated users can only view their own tenant record
DROP POLICY IF EXISTS "tenant_isolation_tenants" ON tenants;
CREATE POLICY "tenant_isolation_tenants" ON tenants
  FOR ALL TO authenticated
  USING (id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid)
  WITH CHECK (id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid);

-- Generic Macro: Apply tenant_id isolation to all core operational tables
DO $$
DECLARE
  t TEXT;
  tables_to_protect TEXT[] := ARRAY[
    'branches', 'users', 'floors', 'tables', 'kitchen_stations',
    'menu_categories', 'ingredients', 'menu_items', 'modifier_groups',
    'modifiers', 'menu_item_modifier_groups', 'recipe_ingredients',
    'stock_movements', 'customers', 'orders', 'order_items',
    'order_item_modifiers', 'kots', 'kot_items', 'payments', 'tenant_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables_to_protect LOOP
    EXECUTE format('DROP POLICY IF EXISTS "tenant_isolation_%I" ON %I;', t, t);
    EXECUTE format('
      CREATE POLICY "tenant_isolation_%I" ON %I
        FOR ALL TO authenticated
        USING (tenant_id = (auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid)
        WITH CHECK (tenant_id = (auth.jwt() -> ''app_metadata'' ->> ''tenant_id'')::uuid);
    ', t, t);
  END LOOP;
END $$;

-- Public read-only access for Guest QR Menu & Kiosk (categories & items with is_active = true)
DROP POLICY IF EXISTS "anon_read_active_categories" ON menu_categories;
CREATE POLICY "anon_read_active_categories" ON menu_categories
  FOR SELECT TO anon
  USING (is_active = true);

DROP POLICY IF EXISTS "anon_read_active_menu_items" ON menu_items;
CREATE POLICY "anon_read_active_menu_items" ON menu_items
  FOR SELECT TO anon
  USING (is_active = true);

DROP POLICY IF EXISTS "anon_read_active_modifiers" ON modifiers;
CREATE POLICY "anon_read_active_modifiers" ON modifiers
  FOR SELECT TO anon
  USING (true);

-- ============================================================================
-- 7. SUPABASE REALTIME CONFIGURATION
-- ============================================================================

-- Add operational tables to supabase_realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE kots;
ALTER PUBLICATION supabase_realtime ADD TABLE kot_items;
ALTER PUBLICATION supabase_realtime ADD TABLE tables;

-- Set REPLICA IDENTITY FULL to guarantee delta patches have all fields
ALTER TABLE orders REPLICA IDENTITY FULL;
ALTER TABLE kots REPLICA IDENTITY FULL;
ALTER TABLE kot_items REPLICA IDENTITY FULL;
ALTER TABLE tables REPLICA IDENTITY FULL;

-- ============================================================================
-- 8. ATOMIC EGRESS-OPTIMIZED RPC FUNCTIONS
-- ============================================================================

-- 8.1 Atomic POS Order Placement
-- Handles idempotency, sequential order numbers, snapshotting, table status,
-- KOT generation, inventory deduction, and returns MINIMAL JSON (~80 bytes).
CREATE OR REPLACE FUNCTION create_pos_order(
  p_branch_id UUID,
  p_type order_type DEFAULT 'DINE_IN',
  p_table_id UUID DEFAULT NULL,
  p_guest_count INTEGER DEFAULT NULL,
  p_guest_name TEXT DEFAULT NULL,
  p_customer_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_client_request_id TEXT DEFAULT NULL,
  p_items JSONB DEFAULT '[]'::jsonb,
  p_auto_occupy_table BOOLEAN DEFAULT TRUE,
  p_deduct_inventory BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id UUID;
  v_order_id UUID;
  v_order_number TEXT;
  v_seq INTEGER;
  v_existing_id UUID;
  v_existing_number TEXT;
  v_existing_total NUMERIC(12,2);
  v_item JSONB;
  v_menu_item RECORD;
  v_qty INTEGER;
  v_unit_price NUMERIC(12,2);
  v_tax_rate NUMERIC(5,2);
  v_line_total NUMERIC(12,2);
  v_subtotal NUMERIC(12,2) := 0;
  v_tax_amount NUMERIC(12,2) := 0;
  v_total_amount NUMERIC(12,2) := 0;
  v_order_item_id UUID;
  v_modifier_id_text TEXT;
  v_modifier RECORD;
  v_mod_price_total NUMERIC(12,2);
  v_kot_id UUID;
  v_kot_number TEXT;
  v_station_id UUID;
  v_recipe RECORD;
BEGIN
  -- 1. Extract tenant_id and user_id from JWT claims
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: missing tenant_id claim in app_metadata';
  END IF;
  v_user_id := auth.uid();

  -- 2. Idempotency Check
  IF p_client_request_id IS NOT NULL AND p_client_request_id <> '' THEN
    SELECT id, order_number, total_amount INTO v_existing_id, v_existing_number, v_existing_total
    FROM orders
    WHERE tenant_id = v_tenant_id AND branch_id = p_branch_id AND client_request_id = p_client_request_id;

    IF FOUND THEN
      -- Ultra-low egress return for idempotent request
      RETURN jsonb_build_object(
        'order_id', v_existing_id,
        'order_number', v_existing_number,
        'total_amount', v_existing_total,
        'status', 'OPEN',
        'idempotent', true
      );
    END IF;
  END IF;

  -- 3. Generate Sequential Daily Order Number
  SELECT COALESCE(MAX(NULLIF(regexp_replace(order_number, '\D', '', 'g'), '')::INT), 0) + 1
  INTO v_seq
  FROM orders
  WHERE tenant_id = v_tenant_id AND branch_id = p_branch_id AND created_at >= CURRENT_DATE;

  v_order_number := '#' || v_seq::TEXT;
  v_order_id := gen_random_uuid();

  -- 4. Insert Base Order Header (Calculations finalized after item loop)
  INSERT INTO orders (
    id, tenant_id, branch_id, order_number, type, status, channel,
    acceptance, table_id, guest_count, guest_name, customer_id,
    created_by_id, notes, client_request_id, subtotal, tax_amount, total_amount
  ) VALUES (
    v_order_id, v_tenant_id, p_branch_id, v_order_number, p_type, 'OPEN', 'STAFF',
    'NOT_REQUIRED', p_table_id, p_guest_count, p_guest_name, p_customer_id,
    v_user_id, p_notes, p_client_request_id, 0, 0, 0
  );

  -- 5. Process Items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item ->> 'quantity')::INTEGER, 1);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    -- Lookup menu item verifying tenant isolation
    SELECT * INTO v_menu_item
    FROM menu_items
    WHERE id = (v_item ->> 'menu_item_id')::UUID AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Menu item % not found for this tenant', (v_item ->> 'menu_item_id');
    END IF;

    v_unit_price := v_menu_item.price;
    v_tax_rate := v_menu_item.tax_rate_percent;
    v_mod_price_total := 0;

    -- Compute line total with modifier adjustments
    IF v_item ? 'modifier_ids' AND jsonb_typeof(v_item -> 'modifier_ids') = 'array' THEN
      FOR v_modifier_id_text IN SELECT jsonb_array_elements_text(v_item -> 'modifier_ids')
      LOOP
        SELECT * INTO v_modifier
        FROM modifiers
        WHERE id = v_modifier_id_text::UUID AND tenant_id = v_tenant_id;
        IF FOUND THEN
          v_mod_price_total := v_mod_price_total + v_modifier.price_adjustment;
        END IF;
      END LOOP;
    END IF;

    v_line_total := (v_unit_price + v_mod_price_total) * v_qty;
    v_subtotal := v_subtotal + v_line_total;
    v_tax_amount := v_tax_amount + (v_line_total * (v_tax_rate / 100.0));

    -- Insert Order Item
    v_order_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, tenant_id, order_id, menu_item_id, name_snapshot,
      unit_price_snapshot, tax_rate_snapshot, quantity, line_total,
      kitchen_note, status
    ) VALUES (
      v_order_item_id, v_tenant_id, v_order_id, v_menu_item.id, v_menu_item.name,
      v_unit_price, v_tax_rate, v_qty, v_line_total,
      v_item ->> 'kitchen_note', 'NEW'
    );

    -- Insert Modifiers
    IF v_item ? 'modifier_ids' AND jsonb_typeof(v_item -> 'modifier_ids') = 'array' THEN
      FOR v_modifier_id_text IN SELECT jsonb_array_elements_text(v_item -> 'modifier_ids')
      LOOP
        SELECT * INTO v_modifier
        FROM modifiers
        WHERE id = v_modifier_id_text::UUID AND tenant_id = v_tenant_id;
        IF FOUND THEN
          INSERT INTO order_item_modifiers (
            tenant_id, order_item_id, modifier_id, name_snapshot, price_adj_snapshot
          ) VALUES (
            v_tenant_id, v_order_item_id, v_modifier.id, v_modifier.name, v_modifier.price_adjustment
          );
        END IF;
      END LOOP;
    END IF;

    -- 6. Optional Inventory Deduction (on order placement)
    IF p_deduct_inventory THEN
      IF v_menu_item.inventory_tracking = 'DIRECT' AND v_menu_item.stock_ingredient_id IS NOT NULL THEN
        UPDATE ingredients
        SET current_stock = current_stock - (v_menu_item.stock_quantity_per_sale * v_qty)
        WHERE id = v_menu_item.stock_ingredient_id AND tenant_id = v_tenant_id;

        INSERT INTO stock_movements (
          tenant_id, branch_id, ingredient_id, type, quantity, note, order_id, created_by_id
        ) VALUES (
          v_tenant_id, p_branch_id, v_menu_item.stock_ingredient_id, 'CONSUMPTION',
          -(v_menu_item.stock_quantity_per_sale * v_qty), 'POS Order Placement', v_order_id, v_user_id
        );
      ELSIF v_menu_item.inventory_tracking = 'RECIPE' THEN
        FOR v_recipe IN SELECT ingredient_id, quantity FROM recipe_ingredients WHERE menu_item_id = v_menu_item.id LOOP
          UPDATE ingredients
          SET current_stock = current_stock - (v_recipe.quantity * v_qty)
          WHERE id = v_recipe.ingredient_id AND tenant_id = v_tenant_id;

          INSERT INTO stock_movements (
            tenant_id, branch_id, ingredient_id, type, quantity, note, order_id, created_by_id
          ) VALUES (
            v_tenant_id, p_branch_id, v_recipe.ingredient_id, 'CONSUMPTION',
            -(v_recipe.quantity * v_qty), 'POS Order Placement', v_order_id, v_user_id
          );
        END LOOP;
      END IF;
    END IF;

  END LOOP;

  -- 7. Update Final Order Totals
  v_total_amount := v_subtotal;
  UPDATE orders
  SET subtotal = v_subtotal, tax_amount = v_tax_amount, total_amount = v_total_amount, updated_at = now()
  WHERE id = v_order_id;

  -- 8. Table Status Update
  IF p_table_id IS NOT NULL AND p_auto_occupy_table THEN
    UPDATE tables
    SET status = 'OCCUPIED', status_since = now(), updated_at = now()
    WHERE id = p_table_id AND tenant_id = v_tenant_id;
  END IF;

  -- 9. Auto-Generate KOT (Kitchen Order Ticket)
  v_kot_number := 'KOT-' || v_seq::TEXT;
  v_kot_id := gen_random_uuid();
  INSERT INTO kots (id, tenant_id, branch_id, order_id, ticket_number, status)
  VALUES (v_kot_id, v_tenant_id, p_branch_id, v_order_number, v_kot_number, 'NEW');

  INSERT INTO kot_items (tenant_id, kot_id, order_item_id, status)
  SELECT v_tenant_id, v_kot_id, id, 'NEW'
  FROM order_items
  WHERE order_id = v_order_id;

  -- 10. Ultra-low Egress Minimal Return (~80 bytes payload)
  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total_amount', v_total_amount,
    'status', 'OPEN'
  );
END;
$$;

-- 8.2 Atomic POS Checkout Settlement
-- Settles payment, marks order PAID, marks table AVAILABLE, deducts inventory
CREATE OR REPLACE FUNCTION settle_pos_order(
  p_order_id UUID,
  p_payment_method payment_method,
  p_amount NUMERIC(12,2),
  p_tendered NUMERIC(12,2) DEFAULT NULL,
  p_change_given NUMERIC(12,2) DEFAULT NULL,
  p_reference TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_order RECORD;
  v_item RECORD;
  v_menu_item RECORD;
  v_recipe RECORD;
  v_already_consumed INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: missing tenant_id claim in app_metadata';
  END IF;

  -- 1. Fetch Order
  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id AND tenant_id = v_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status = 'PAID' THEN
    RETURN jsonb_build_object('order_id', p_order_id, 'status', 'PAID', 'already_settled', true);
  END IF;

  -- 2. Insert Payment Record
  INSERT INTO payments (
    tenant_id, branch_id, order_id, method, amount, tendered, change_given, reference
  ) VALUES (
    v_tenant_id, v_order.branch_id, p_order_id, p_payment_method, p_amount, p_tendered, p_change_given, p_reference
  );

  -- 3. Mark Order as PAID
  UPDATE orders
  SET status = 'PAID', billed_at = now(), updated_at = now()
  WHERE id = p_order_id AND tenant_id = v_tenant_id;

  -- 4. Free Table if assigned
  IF v_order.table_id IS NOT NULL THEN
    UPDATE tables
    SET status = 'AVAILABLE', status_since = now(), updated_at = now()
    WHERE id = v_order.table_id AND tenant_id = v_tenant_id;
  END IF;

  -- 5. Deduct Inventory on Settlement (if not already logged for this order)
  SELECT COUNT(*) INTO v_already_consumed
  FROM stock_movements
  WHERE order_id = p_order_id AND type = 'CONSUMPTION' AND tenant_id = v_tenant_id;

  IF v_already_consumed = 0 THEN
    FOR v_item IN SELECT menu_item_id, quantity FROM order_items WHERE order_id = p_order_id LOOP
      SELECT * INTO v_menu_item FROM menu_items WHERE id = v_item.menu_item_id AND tenant_id = v_tenant_id;

      IF FOUND THEN
        IF v_menu_item.inventory_tracking = 'DIRECT' AND v_menu_item.stock_ingredient_id IS NOT NULL THEN
          UPDATE ingredients
          SET current_stock = current_stock - (v_menu_item.stock_quantity_per_sale * v_item.quantity)
          WHERE id = v_menu_item.stock_ingredient_id AND tenant_id = v_tenant_id;

          INSERT INTO stock_movements (
            tenant_id, branch_id, ingredient_id, type, quantity, note, order_id
          ) VALUES (
            v_tenant_id, v_order.branch_id, v_menu_item.stock_ingredient_id, 'CONSUMPTION',
            -(v_menu_item.stock_quantity_per_sale * v_item.quantity), 'POS Checkout Settlement', p_order_id
          );
        ELSIF v_menu_item.inventory_tracking = 'RECIPE' THEN
          FOR v_recipe IN SELECT ingredient_id, quantity FROM recipe_ingredients WHERE menu_item_id = v_menu_item.id LOOP
            UPDATE ingredients
            SET current_stock = current_stock - (v_recipe.quantity * v_item.quantity)
            WHERE id = v_recipe.ingredient_id AND tenant_id = v_tenant_id;

            INSERT INTO stock_movements (
              tenant_id, branch_id, ingredient_id, type, quantity, note, order_id
            ) VALUES (
              v_tenant_id, v_order.branch_id, v_recipe.ingredient_id, 'CONSUMPTION',
              -(v_recipe.quantity * v_item.quantity), 'POS Checkout Settlement', p_order_id
            );
          END LOOP;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 6. Minimal Return
  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'status', 'PAID',
    'balance_due', 0
  );
END;
$$;

-- 8.3 Local-First Delta Sync RPC (Egress Minimization for Catalogs)
-- Fetches only items modified since client's last cached timestamp
CREATE OR REPLACE FUNCTION get_catalog_delta(
  p_branch_id UUID,
  p_since TIMESTAMPTZ DEFAULT '-infinity'::timestamptz
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_menu_version INTEGER;
  v_categories JSONB;
  v_items JSONB;
  v_modifiers JSONB;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: missing tenant_id claim';
  END IF;

  SELECT menu_version INTO v_menu_version FROM tenants WHERE id = v_tenant_id;

  -- Only return rows modified strictly after p_since, selecting strictly needed UI columns
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'description', description, 'sort_order', sort_order, 'is_active', is_active
  )), '[]'::jsonb)
  INTO v_categories
  FROM menu_categories
  WHERE tenant_id = v_tenant_id AND updated_at > p_since;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'category_id', category_id, 'station_id', station_id,
    'name', name, 'price', price, 'tax_rate_percent', tax_rate_percent,
    'half_price', half_price, 'is_veg', is_veg, 'is_active', is_active,
    'image_url', image_url, 'sort_order', sort_order
  )), '[]'::jsonb)
  INTO v_items
  FROM menu_items
  WHERE tenant_id = v_tenant_id AND updated_at > p_since;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'group_id', group_id, 'name', name,
    'price_adjustment', price_adjustment, 'sort_order', sort_order
  )), '[]'::jsonb)
  INTO v_modifiers
  FROM modifiers
  WHERE tenant_id = v_tenant_id AND updated_at > p_since;

  RETURN jsonb_build_object(
    'menu_version', v_menu_version,
    'synced_at', now(),
    'categories', v_categories,
    'items', v_items,
    'modifiers', v_modifiers
  );
END;
$$;

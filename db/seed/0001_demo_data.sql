-- =============================================================================
-- Development seed. Safe to run on an empty database only.
--
-- The admin user is deliberately NOT seeded here — a password hash committed to
-- git is a backdoor. The API bootstraps it from ADMIN_EMAIL / ADMIN_PASSWORD on
-- first boot (see apps/api/src/auth/bootstrap.service.ts).
-- =============================================================================

INSERT INTO kh.customers (code, name, contact_name, contact_phone, address_line, city, region, location)
VALUES
  ('CUS-1001', 'Marmara Market Zinciri', 'Selin Aydın', '+90 532 000 1001',
   'Organize Sanayi Bölgesi 4. Cad. No:12', 'İzmit', 'Kocaeli',
   ST_SetSRID(ST_MakePoint(29.9187, 40.7654), 4326)::geography),
  ('CUS-1002', 'Ege Toptan Gıda', 'Murat Koç', '+90 533 000 1002',
   'Kemalpaşa OSB 102 Sk. No:7', 'İzmir', 'İzmir',
   ST_SetSRID(ST_MakePoint(27.4210, 38.4192), 4326)::geography),
  ('CUS-1003', 'Anadolu Temizlik Ürünleri', 'Ayşe Demirtaş', '+90 534 000 1003',
   'Ostim Mah. 1234. Sk. No:3', 'Ankara', 'Ankara',
   ST_SetSRID(ST_MakePoint(32.7480, 39.9723), 4326)::geography)
ON CONFLICT (code) DO NOTHING;

INSERT INTO kh.shipping_companies (code, name, tax_number, contact_name, contact_phone, sla_hours)
VALUES
  ('CAR-ANK', 'Anadolu Nakliyat A.Ş.',  '1234567890', 'Hakan Yıldız', '+90 542 111 2200', 24),
  ('CAR-EGE', 'Ege Lojistik Ltd. Şti.', '2345678901', 'Deniz Arslan', '+90 542 111 3300', 18),
  ('CAR-IND', 'Bağımsız Kamyoncular Kooperatifi', '3456789012', 'Ömer Şahin', '+90 542 111 4400', 36)
ON CONFLICT (code) DO NOTHING;

INSERT INTO kh.vehicles (shipping_company_id, plate, make_model, capacity_kg)
SELECT sc.id, v.plate, v.model, v.cap
FROM kh.shipping_companies sc
JOIN (VALUES
  ('CAR-ANK', '34 ABC 123', 'Mercedes Actros 1845', 24000),
  ('CAR-ANK', '06 XYZ 456', 'Ford F-Max',           22000),
  ('CAR-EGE', '35 KLM 789', 'MAN TGX 18.480',       24000),
  ('CAR-IND', '41 TRK 321', 'Iveco Stralis',        18000)
) AS v(code, plate, model, cap) ON v.code = sc.code::text
ON CONFLICT (shipping_company_id, plate) DO NOTHING;

INSERT INTO kh.drivers (shipping_company_id, full_name, phone, national_id_last4)
SELECT sc.id, d.name, d.phone, d.nid
FROM kh.shipping_companies sc
JOIN (VALUES
  ('CAR-ANK', 'Mehmet Kaplan',  '+90 555 100 1001', '4471'),
  ('CAR-ANK', 'Emre Doğan',     '+90 555 100 1002', '9032'),
  ('CAR-EGE', 'İbrahim Yalçın', '+90 555 100 1003', '1188'),
  ('CAR-IND', 'Serkan Uzun',    '+90 555 100 1004', '7765')
) AS d(code, name, phone, nid) ON d.code = sc.code::text
ON CONFLICT (shipping_company_id, phone) DO NOTHING;

-- Three orders leaving the (fictional) KaraHoca plant in Gebze.
INSERT INTO kh.orders (
  order_number, customer_id, status, destination_label, destination_address,
  destination, destination_radius_m, total_weight_kg, pallet_count, cargo_summary,
  planned_dispatch_at, planned_delivery_at
)
SELECT
  o.num, c.id, o.st::kh.order_status, o.label, o.addr,
  ST_SetSRID(ST_MakePoint(o.lon, o.lat), 4326)::geography,
  o.radius, o.kg, o.pallets, o.cargo,
  now() + (o.dispatch_in || ' hours')::interval,
  now() + (o.deliver_in || ' hours')::interval
FROM (VALUES
  ('SO-2026-000418', 'CUS-1001', 'DISPATCHED', 'Merkez Depo — İzmit',
   'Organize Sanayi Bölgesi 4. Cad. No:12, İzmit', 29.9187, 40.7654, 250,
   18400.0, 22, '22 pal. KaraFresh Sıvı Deterjan 5 L', 1, 6),
  ('SO-2026-000419', 'CUS-1002', 'PENDING', 'Kemalpaşa Dağıtım Merkezi',
   'Kemalpaşa OSB 102 Sk. No:7, İzmir', 27.4210, 38.4192, 300,
   21200.0, 26, '26 pal. KaraMat Toz Deterjan 10 kg', 4, 16),
  ('SO-2026-000420', 'CUS-1003', 'PENDING', 'Ostim Ana Depo',
   'Ostim Mah. 1234. Sk. No:3, Ankara', 32.7480, 39.9723, 400,
   9800.0, 12, '12 pal. KaraSoft Yumuşatıcı 4 L', 8, 22)
) AS o(num, cus, st, label, addr, lon, lat, radius, kg, pallets, cargo, dispatch_in, deliver_in)
JOIN kh.customers c ON c.code::text = o.cus
ON CONFLICT (order_number) DO NOTHING;

-- Factory geofence: leaving it is what "departed" means.
INSERT INTO kh.geofences (name, kind, area, dwell_sec)
SELECT
  'KaraHoca Gebze Fabrika Sahası', 'FACTORY',
  ST_SetSRID(ST_MakePolygon(ST_GeomFromText(
    'LINESTRING(29.4280 40.8020, 29.4360 40.8020, 29.4360 40.7960, 29.4280 40.7960, 29.4280 40.8020)'
  )), 4326)::geography,
  60
WHERE NOT EXISTS (SELECT 1 FROM kh.geofences WHERE kind = 'FACTORY');

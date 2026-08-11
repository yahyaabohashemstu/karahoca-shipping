import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  CreateCustomerDto,
  CreateDriverDto,
  CreateOrderDto,
  CreateShippingCompanyDto,
  CreateVehicleDto,
  ListQueryDto,
} from './dto';

@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService) {}

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  async listOrders(q: ListQueryDto) {
    const limit = Math.min(q.limit ?? 50, 200);
    const params: unknown[] = [];
    const where: string[] = [];

    if (q.status) {
      params.push(q.status);
      where.push(`o.status = $${params.length}::kh.order_status`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(o.order_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
    }
    if (q.untracked) {
      where.push(`NOT EXISTS (
        SELECT 1 FROM kh.tracking_sessions s
        WHERE s.order_id = o.id
          AND s.status IN ('ASSIGNED','CLAIMED','ACTIVE','PAUSED')
      )`);
    }
    params.push(limit, q.offset ?? 0);

    const rows = await this.db.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.status::text AS status,
              o.destination_label AS "destinationLabel", o.destination_address AS "destinationAddress",
              ST_Y(o.destination::geometry) AS "destinationLat",
              ST_X(o.destination::geometry) AS "destinationLon",
              o.destination_radius_m AS "destinationRadiusM",
              o.total_weight_kg AS "totalWeightKg", o.pallet_count AS "palletCount",
              o.cargo_summary AS "cargoSummary",
              o.planned_dispatch_at AS "plannedDispatchAt",
              o.planned_delivery_at AS "plannedDeliveryAt",
              o.dispatched_at AS "dispatchedAt", o.delivered_at AS "deliveredAt",
              o.created_at AS "createdAt",
              c.id AS "customerId", c.name AS "customerName", c.city AS "customerCity",
              s.id AS "activeSessionId", s.reference AS "activeSessionRef",
              s.status::text AS "activeSessionStatus",
              count(*) OVER () AS total_count
       FROM kh.orders o
       JOIN kh.customers c ON c.id = o.customer_id
       LEFT JOIN LATERAL (
         SELECT id, reference, status FROM kh.tracking_sessions ts
         WHERE ts.order_id = o.id
         ORDER BY (ts.status IN ('ASSIGNED','CLAIMED','ACTIVE','PAUSED')) DESC, ts.created_at DESC
         LIMIT 1
       ) s ON true
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map(({ total_count: _t, ...rest }) => rest),
      total: rows.length ? Number(rows[0].total_count) : 0,
      limit,
      offset: q.offset ?? 0,
    };
  }

  async createOrder(dto: CreateOrderDto, userId: string) {
    try {
      const row = await this.db.one<{ id: string }>(
        `INSERT INTO kh.orders (
           order_number, customer_id, destination_label, destination_address,
           destination, destination_radius_m, total_weight_kg, pallet_count,
           cargo_summary, planned_dispatch_at, planned_delivery_at, external_ref, created_by
         ) VALUES (
           $1, $2, $3, $4,
           CASE WHEN $5::double precision IS NULL OR $6::double precision IS NULL THEN NULL
                ELSE ST_SetSRID(
                       ST_MakePoint($6::double precision, $5::double precision), 4326
                     )::geography END,
           coalesce($7::int, 300), $8, $9, $10, $11, $12, coalesce($13::jsonb, '{}'::jsonb), $14
         )
         RETURNING id`,
        [
          dto.orderNumber,
          dto.customerId,
          dto.destinationLabel ?? null,
          dto.destinationAddress ?? null,
          dto.destinationLat ?? null,
          dto.destinationLon ?? null,
          dto.destinationRadiusM ?? null,
          dto.totalWeightKg ?? null,
          dto.palletCount ?? null,
          dto.cargoSummary ?? null,
          dto.plannedDispatchAt ?? null,
          dto.plannedDeliveryAt ?? null,
          dto.externalRef ? JSON.stringify(dto.externalRef) : null,
          userId,
        ],
      );

      if (dto.items?.length) {
        for (const item of dto.items) {
          await this.db.query(
            `INSERT INTO kh.order_items (order_id, sku, description, quantity, unit, weight_kg)
             VALUES ($1, $2, $3, $4, coalesce($5, 'PCS'), $6)`,
            [row.id, item.sku, item.description ?? null, item.quantity, item.unit ?? null, item.weightKg ?? null],
          );
        }
      }
      return this.getOrder(row.id);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'ORDER_EXISTS',
          message: `Order ${dto.orderNumber} already exists`,
        });
      }
      throw err;
    }
  }

  async getOrder(id: string) {
    const order = await this.db.maybeOne(
      `SELECT o.*, ST_Y(o.destination::geometry) AS destination_lat,
              ST_X(o.destination::geometry) AS destination_lon,
              c.name AS customer_name
       FROM kh.orders o JOIN kh.customers c ON c.id = o.customer_id
       WHERE o.id = $1`,
      [id],
    );
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Unknown order' });

    const [items, sessions] = await Promise.all([
      this.db.query(`SELECT * FROM kh.order_items WHERE order_id = $1`, [id]),
      this.db.query(
        `SELECT id, reference, status::text AS status, started_at, ended_at,
                round(distance_m::numeric/1000, 2) AS distance_km, points_total
         FROM kh.tracking_sessions WHERE order_id = $1 ORDER BY created_at DESC`,
        [id],
      ),
    ]);
    return { ...order, items, sessions };
  }

  // ---------------------------------------------------------------------------
  // Shipping companies
  // ---------------------------------------------------------------------------

  listCompanies() {
    return this.db.query(
      `SELECT sc.id, sc.code::text AS code, sc.name, sc.contact_name AS "contactName",
              sc.contact_phone AS "contactPhone", sc.contact_email::text AS "contactEmail",
              sc.sla_hours AS "slaHours", sc.is_active AS "isActive",
              count(v.id) FILTER (WHERE v.is_active) AS "vehicleCount",
              count(d.id) FILTER (WHERE d.is_active) AS "driverCount"
       FROM kh.shipping_companies sc
       LEFT JOIN kh.vehicles v ON v.shipping_company_id = sc.id
       LEFT JOIN kh.drivers  d ON d.shipping_company_id = sc.id
       GROUP BY sc.id
       ORDER BY sc.name`,
    );
  }

  async createCompany(dto: CreateShippingCompanyDto) {
    try {
      return await this.db.one(
        `INSERT INTO kh.shipping_companies (code, name, tax_number, contact_name, contact_phone, contact_email, sla_hours, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, code::text AS code, name`,
        [
          dto.code, dto.name, dto.taxNumber ?? null, dto.contactName ?? null,
          dto.contactPhone ?? null, dto.contactEmail ?? null, dto.slaHours ?? null, dto.notes ?? null,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'COMPANY_EXISTS', message: `Code ${dto.code} is taken` });
      }
      throw err;
    }
  }

  listVehicles(companyId?: string) {
    return this.db.query(
      `SELECT v.id, v.plate::text AS plate, v.make_model AS "makeModel",
              v.capacity_kg AS "capacityKg", v.is_active AS "isActive",
              v.shipping_company_id AS "shippingCompanyId", sc.name AS "carrierName"
       FROM kh.vehicles v JOIN kh.shipping_companies sc ON sc.id = v.shipping_company_id
       WHERE ($1::uuid IS NULL OR v.shipping_company_id = $1)
       ORDER BY sc.name, v.plate`,
      [companyId ?? null],
    );
  }

  createVehicle(dto: CreateVehicleDto) {
    return this.db.one(
      `INSERT INTO kh.vehicles (shipping_company_id, plate, make_model, capacity_kg)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shipping_company_id, plate) DO UPDATE
         SET make_model = EXCLUDED.make_model, capacity_kg = EXCLUDED.capacity_kg, is_active = true
       RETURNING id, plate::text AS plate`,
      [dto.shippingCompanyId, dto.plate, dto.makeModel ?? null, dto.capacityKg ?? null],
    );
  }

  listDrivers(companyId?: string) {
    return this.db.query(
      `SELECT d.id, d.full_name AS "fullName", d.phone, d.is_active AS "isActive",
              d.shipping_company_id AS "shippingCompanyId", sc.name AS "carrierName"
       FROM kh.drivers d JOIN kh.shipping_companies sc ON sc.id = d.shipping_company_id
       WHERE ($1::uuid IS NULL OR d.shipping_company_id = $1)
       ORDER BY sc.name, d.full_name`,
      [companyId ?? null],
    );
  }

  createDriver(dto: CreateDriverDto) {
    return this.db.one(
      `INSERT INTO kh.drivers (shipping_company_id, full_name, phone, national_id_last4)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shipping_company_id, phone) DO UPDATE
         SET full_name = EXCLUDED.full_name, is_active = true
       RETURNING id, full_name AS "fullName", phone`,
      [dto.shippingCompanyId, dto.fullName, dto.phone, dto.nationalIdLast4 ?? null],
    );
  }

  // ---------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------

  listCustomers(search?: string) {
    return this.db.query(
      `SELECT id, code::text AS code, name, city, region,
              contact_name AS "contactName", contact_phone AS "contactPhone",
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon,
              is_active AS "isActive"
       FROM kh.customers
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR code::text ILIKE '%' || $1 || '%')
       ORDER BY name
       LIMIT 200`,
      [search ?? null],
    );
  }

  createCustomer(dto: CreateCustomerDto) {
    return this.db.one(
      `INSERT INTO kh.customers (code, name, contact_name, contact_phone, contact_email,
                                 address_line, city, region, country_code, location, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::text, 'TR'),
               CASE WHEN $10::double precision IS NULL OR $11::double precision IS NULL THEN NULL
                    ELSE ST_SetSRID(
                           ST_MakePoint($11::double precision, $10::double precision), 4326
                         )::geography END,
               $12)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true
       RETURNING id, code::text AS code, name`,
      [
        dto.code, dto.name, dto.contactName ?? null, dto.contactPhone ?? null,
        dto.contactEmail ?? null, dto.addressLine ?? null, dto.city ?? null,
        dto.region ?? null, dto.countryCode ?? null, dto.lat ?? null, dto.lon ?? null,
        dto.notes ?? null,
      ],
    );
  }
}

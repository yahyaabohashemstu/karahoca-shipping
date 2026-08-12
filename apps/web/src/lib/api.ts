'use client';

/**
 * Thin REST client for the dispatcher dashboard.
 *
 * Deliberately not a generated SDK: the surface is a dozen endpoints and a
 * hand-written client keeps the token-refresh logic (the only genuinely subtle
 * part) in one readable place.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const ACCESS_KEY = 'kh.access';
const REFRESH_KEY = 'kh.refresh';

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const tokens = {
  get access() {
    return typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * Single-flight refresh.
 *
 * A dashboard fires several requests at once (fleet, sessions, stats). Without
 * this, an expired token means N parallel refreshes — and because the server
 * rotates refresh tokens with reuse detection, the 2nd through Nth would look
 * like a stolen-token replay and nuke the whole family, logging the dispatcher
 * out. One in-flight promise, shared by every caller.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exported because the WebSocket needs it too. When the socket is rejected for
 * an expired token it must refresh before retrying, or `reconnectionAttempts:
 * Infinity` becomes an infinite loop against a credential that will never work
 * again — which is exactly what happened to a laptop that slept overnight.
 */
export async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = tokens.refresh;
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        tokens.clear();
        return false;
      }
      const data = await res.json();
      tokens.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const access = tokens.access;
  if (access) headers.set('Authorization', `Bearer ${access}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401 && retry) {
    if (await refreshTokens()) return apiFetch<T>(path, init, false);
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error = (body?.error ?? {}) as ApiErrorShape;
    throw new ApiError(res.status, error.code ?? 'ERROR', error.message ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// -----------------------------------------------------------------------------
// Domain types (mirror the API's response shapes)
// -----------------------------------------------------------------------------

export type SignalState = 'LIVE' | 'DELAYED' | 'STALE' | 'LOST' | 'NO_SIGNAL';

export interface FleetPosition {
  sessionId: string;
  reference: string;
  status: string;
  lat: number | null;
  lon: number | null;
  speedMps: number | null;
  bearingDeg: number | null;
  accuracyM: number | null;
  batteryPct: number | null;
  isCharging: boolean | null;
  recordedAt: string | null;
  signalState: SignalState;
  secondsSinceFix: number | null;
  pointsTotal: number;
  distanceKm: number | null;
  remainingKm: number | null;
  startedAt: string | null;
  mockLocationCount: number;
  orderId: string;
  orderNumber: string;
  destinationLabel: string | null;
  destinationLat: number | null;
  destinationLon: number | null;
  plannedDeliveryAt: string | null;
  customerName: string;
  customerCity: string | null;
  carrierName: string;
  driverName: string | null;
  driverPhone: string | null;
  vehiclePlate: string | null;
}

export interface SessionHandoff {
  code: string;
  prettyCode: string;
  expiresAt: string | null;
  deepLink: string;
  webLink: string;
  qrDataUrl: string;
}

export interface SessionEvent {
  type: string;
  occurred_at: string;
  actor: string | null;
  message: string | null;
  payload: Record<string, unknown>;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2. Stored since the first migration, surfaced only now. */
  countryCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  lat: number | null;
  lon: number | null;
  isActive: boolean;
}

export interface ShippingCompany {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  slaHours: number | null;
  isActive: boolean;
  vehicleCount: number;
  driverCount: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: string;
  destinationLabel: string | null;
  destinationAddress: string | null;
  destinationLat: number | null;
  destinationLon: number | null;
  destinationRadiusM: number | null;
  totalWeightKg: number | null;
  palletCount: number | null;
  cargoSummary: string | null;
  plannedDispatchAt: string | null;
  plannedDeliveryAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  customerId: string;
  customerName: string;
  customerCity: string | null;
  activeSessionId: string | null;
  activeSessionRef: string | null;
  activeSessionStatus: string | null;
}

export interface OrderItem {
  id: string;
  /** The column is `sku`, but the dashboard lets a dispatcher type a product name. */
  sku: string;
  description: string | null;
  quantity: number;
  unit: string;
  weightKg: number | null;
}

export interface Vehicle {
  id: string;
  shippingCompanyId: string;
  plate: string;
  makeModel: string | null;
  capacityKg: number | null;
}

export interface Driver {
  id: string;
  shippingCompanyId: string;
  fullName: string;
  phone: string;
  nationalIdLast4: string | null;
}

export interface CarrierPerformance {
  id: string;
  name: string;
  sessions: number;
  completed: number;
  sessionsWithMockGps: number;
  avgDistanceKm: number | null;
  avgDurationH: number | null;
  avgLargestGapSec: number | null;
  avgCoveragePct: number | null;
  onTime: number;
}

export interface SessionDetail extends FleetPosition {
  policy: { pingIntervalSec: number; idleIntervalSec: number; minDistanceM: number };
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  pointsRejected: number;
  offlineBatches: number;
  notes: string | null;
  handoff: SessionHandoff | null;
  device: Record<string, unknown> | null;
  events: SessionEvent[];
}

// -----------------------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------------------

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ accessToken: string; refreshToken: string; user: { fullName: string; role: string } }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
    ),

  liveFleet: () =>
    apiFetch<{ at: string; count: number; positions: FleetPosition[] }>('/tracking/live'),

  sessions: (query: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return apiFetch<{ items: FleetPosition[]; total: number }>(`/sessions?${params}`);
  },

  session: (id: string) => apiFetch<SessionDetail>(`/sessions/${id}`),

  createSession: (body: Record<string, unknown>) =>
    apiFetch<SessionDetail>('/sessions', { method: 'POST', body: JSON.stringify(body) }),

  regenerateCode: (id: string) =>
    apiFetch<SessionHandoff>(`/sessions/${id}/claim-code`, { method: 'POST' }),

  sessionAction: (id: string, action: 'pause' | 'resume' | 'complete' | 'cancel', reason?: string) =>
    apiFetch<unknown>(`/sessions/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  route: (id: string, opts: { raw?: boolean; toleranceM?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.raw) params.set('raw', 'true');
    if (opts.toleranceM !== undefined) params.set('toleranceM', String(opts.toleranceM));
    return apiFetch<GeoJSON.FeatureCollection & { pointCount: number; renderedPointCount: number }>(
      `/tracking/sessions/${id}/route?${params}`,
    );
  },

  playback: (id: string, maxPoints = 4000) =>
    apiFetch<{
      total: number;
      stride: number;
      returned: number;
      points: Array<[number, number, number, number | null, number | null, number | null]>;
    }>(`/tracking/sessions/${id}/playback?maxPoints=${maxPoints}`),

  gaps: (id: string, minGapSec = 120) =>
    apiFetch<
      Array<{ from: string; to: string; durationSec: number; straightLineM: number }>
    >(`/tracking/sessions/${id}/gaps?minGapSec=${minGapSec}`),

  // ---- Catalogue ------------------------------------------------------------
  // Every one of these endpoints existed on the API from the first release and
  // had no screen behind it, which meant a dispatcher could not enter a
  // customer, an order or a carrier without someone running curl for them.

  orders: (query: Record<string, string | number | boolean | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return apiFetch<{ items: Order[]; total: number; limit: number; offset: number }>(`/orders?${params}`);
  },

  order: (id: string) => apiFetch<Order & { items: OrderItem[] }>(`/orders/${id}`),

  createOrder: (body: Record<string, unknown>) =>
    apiFetch<Order>('/orders', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Edit the consignee and the load.
   *
   * `items` is replace-all and an empty array CLEARS the list, so omit the key
   * entirely rather than sending `[]` when a form did not touch the manifest.
   */
  updateOrder: (
    id: string,
    body: {
      customerId?: string;
      cargoSummary?: string;
      totalWeightKg?: number;
      palletCount?: number;
      items?: Array<{ sku: string; quantity: number; unit?: string; description?: string; weightKg?: number }>;
    },
  ) =>
    apiFetch<Order & { items: OrderItem[] }>(`/orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  customers: (query: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return apiFetch<Customer[]>(`/customers?${params}`);
  },

  createCustomer: (body: Record<string, unknown>) =>
    apiFetch<Customer>('/customers', { method: 'POST', body: JSON.stringify(body) }),

  companies: () => apiFetch<ShippingCompany[]>('/shipping-companies'),

  createCompany: (body: Record<string, unknown>) =>
    apiFetch<ShippingCompany>('/shipping-companies', { method: 'POST', body: JSON.stringify(body) }),

  vehicles: (shippingCompanyId?: string) =>
    apiFetch<Vehicle[]>(
      `/shipping-companies/vehicles${shippingCompanyId ? `?shippingCompanyId=${shippingCompanyId}` : ''}`,
    ),

  createVehicle: (body: Record<string, unknown>) =>
    apiFetch<Vehicle>('/shipping-companies/vehicles', { method: 'POST', body: JSON.stringify(body) }),

  drivers: (shippingCompanyId?: string) =>
    apiFetch<Driver[]>(
      `/shipping-companies/drivers${shippingCompanyId ? `?shippingCompanyId=${shippingCompanyId}` : ''}`,
    ),

  createDriver: (body: Record<string, unknown>) =>
    apiFetch<Driver>('/shipping-companies/drivers', { method: 'POST', body: JSON.stringify(body) }),

  carrierPerformance: () => apiFetch<CarrierPerformance[]>('/tracking/carriers/performance'),

  stats: () =>
    apiFetch<{
      activeSessions: number;
      awaitingClaim: number;
      silentSessions: number;
      batchesLastHour: number;
      pointsLastHour: number;
      offlineSyncsLastHour: number;
    }>('/health/stats'),
};

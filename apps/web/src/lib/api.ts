'use client';

/**
 * Thin REST client for the dispatcher dashboard.
 *
 * Deliberately not a generated SDK: the surface is a dozen endpoints and a
 * hand-written client keeps the token-refresh logic (the only genuinely subtle
 * part) in one readable place.
 */

import { describeHttp, recordFailure } from './diagnostics';

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
  /*
   * Only when there IS a body.
   *
   * Setting it unconditionally routes a bodyless POST into Fastify's JSON
   * parser, which rejects it: 400 "Body cannot be empty when content-type is
   * set to 'application/json'". Verified against production — that is exactly
   * why "Yeni kod üret" on the session detail page has never worked, and the
   * alert acknowledge button would have shipped with the same fault. Both are
   * bodyless POSTs whose meaning is entirely in the URL.
   */
  if (init.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json');
  }
  const access = tokens.access;
  if (access) headers.set('Authorization', `Bearer ${access}`);

  const method = (init.method ?? 'GET').toUpperCase();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (cause) {
    /*
     * The request never got a response: offline, DNS, a CORS rejection, the
     * proxy dropping the connection mid-deploy. fetch rejects with a bare
     * "Failed to fetch", which is both untranslated and useless, and until now
     * nothing anywhere recorded that it happened.
     */
    const message = describeHttp(0);
    recordFailure({
      at: new Date().toISOString(),
      method,
      path,
      status: 0,
      code: 'NETWORK',
      message: `${message} (${(cause as Error).message})`,
    });
    throw new ApiError(0, 'NETWORK', message);
  }

  if (res.status === 401 && retry) {
    if (await refreshTokens()) return apiFetch<T>(path, init, false);
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  if (!res.ok) {
    /*
     * The message must never come out blank, and it used to.
     *
     * `error.message ?? res.statusText` fails twice over: `??` passes an empty
     * string straight through, and res.statusText is ALWAYS empty over HTTP/2
     * — RFC 9113 removed the reason phrase, and h2 is what the browser
     * negotiates against this API. So a 502 from the proxy during a deploy,
     * whose HTML body json() cannot parse, rendered as a red box with a title
     * and nothing underneath it. That is the report that started this.
     */
    const body = (await res.json().catch(() => null)) as
      | { error?: ApiErrorShape; message?: string }
      | null;
    const shape = body?.error;
    const code = shape?.code?.trim() || `HTTP_${res.status}`;
    const message = describeHttp(res.status, shape?.message ?? body?.message);

    recordFailure({
      at: new Date().toISOString(),
      method,
      path,
      status: res.status,
      code,
      message,
      requestId: res.headers.get('x-request-id') ?? undefined,
    });

    throw new ApiError(res.status, code, message);
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
  /*
   * The consignee's tracking link, minted with the session and returned ONCE.
   * Only its sha256 is stored, so this is null on every later read of the
   * session — a dispatcher who needs it again mints a fresh one.
   */
  shareUrl?: string | null;
}

export interface ShareLinkRow {
  id: string;
  label: string | null;
  /** Null for links minted before migration 0010; those cannot be recovered. */
  url: string | null;
  showRoute: boolean;
  showDriver: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  active: boolean;
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
  /**
   * Arrival radius for this consignee's own gate, in metres.
   *
   * Null means the order-level default applies. Carried on the customer so the
   * order form can inherit both halves of a destination — a point without a
   * radius cannot answer "has it arrived".
   */
  defaultRadiusM: number | null;
  addressLine: string | null;
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
  /**
   * Telemetry sampling rate, NOT a driver-behaviour score. Renamed in 0009
   * because the old formula ignored idle_interval_sec, so a truck legitimately
   * waiting four hours at a customs gate scored ~58% on a perfect trace — and
   * the page told the dispatcher that meant the driver had closed the app.
   */
  avgSamplingPct: number | null;
  onTime: number;
  /** Completed sessions whose order actually had a planned delivery time. The
   *  on-time percentage is meaningless without it, and was previously divided
   *  by every completed session. */
  onTimeMeasurable: number;
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
// Alerts — the exception desk
// -----------------------------------------------------------------------------

export type AlertKind =
  | 'SIGNAL_LOST'
  | 'ARRIVED'
  | 'BATTERY_LOW'
  | 'MOCK_LOCATION'
  | 'NOT_STARTED'
  | 'STOPPED_TOO_LONG';

/** Declared INFO < WARNING < CRITICAL in the database, and ranked that way here. */
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * One row of the exception desk, with the session context already joined on.
 *
 * The truck, the order, the consignee and the driver's number travel with the
 * alert because an exception you have to click through before you can identify
 * it is an exception nobody works at 02:00. This mirrors the API's projection
 * in full rather than only the fields today's panel paints — a partial mirror
 * is how a type stops describing the wire.
 */
export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Written in Turkish by the detector at raise time, ready to display. */
  title: string;
  detail: string | null;
  payload: Record<string, unknown>;
  raisedAt: string;
  /** Resolved BY THE WORLD — the signal came back, the truck arrived. */
  resolvedAt: string | null;
  /** Acknowledged BY A PERSON. Orthogonal to resolvedAt: both, either, neither. */
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;

  sessionId: string;
  sessionReference: string;
  sessionStatus: string;
  lat: number | null;
  lon: number | null;
  lastPointAt: string | null;
  signalState: SignalState;
  secondsSinceFix: number | null;
  batteryPct: number | null;
  isCharging: boolean | null;

  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
  destinationLabel: string | null;
  remainingKm: number | null;
  plannedDeliveryAt: string | null;

  customerName: string | null;
  customerCity: string | null;
  carrierName: string | null;
  driverName: string | null;
  driverPhone: string | null;
  vehiclePlate: string | null;
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

  /*
   * Consignee links. `url` comes back populated on list() since migration
   * 0010 — before that the token was only ever hashed, so a link could be
   * read exactly once and then never again.
   */
  listShareLinks: (sessionId: string) =>
    apiFetch<ShareLinkRow[]>(`/sessions/${sessionId}/share`),

  createShareLink: (sessionId: string, body: { label?: string; showRoute?: boolean; showDriver?: boolean }) =>
    apiFetch<ShareLinkRow>(`/sessions/${sessionId}/share`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  revokeShareLink: (id: string) => apiFetch<void>(`/share/${id}`, { method: 'DELETE' }),

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

  /**
   * PATCH, so a picker that only moved a pin sends a pin.
   *
   * Every consignee in production predates the destination picker, so this is
   * the only way any of them will ever acquire one.
   */
  updateCustomer: (id: string, body: Record<string, unknown>) =>
    apiFetch<Customer>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

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

  // ---- The exception desk ---------------------------------------------------

  /**
   * What is wrong right now, plus what the world fixed recently.
   *
   * `resolvedWithinHours` is deliberately never sent. The list and the count
   * both default to the same server-side window, so leaving it alone is what
   * guarantees the badge cannot count something the panel does not show; pass
   * it here and you have to remember to pass the identical value there.
   */
  alerts: (query: { unacknowledgedOnly?: boolean; sessionId?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return apiFetch<{ items: Alert[]; total: number; limit: number; offset: number }>(`/alerts?${params}`);
  },

  /**
   * The badge number, straight off a partial index. Cheap enough to poll, and
   * unlike the list it is never truncated by a page size.
   */
  alertCount: () =>
    apiFetch<{ unacknowledged: number; critical: number; open: number; windowHours: number }>(
      '/alerts/count',
    ),

  /** "I have seen this and I am dealing with it." Returns the updated row. */
  acknowledgeAlert: (id: string) => apiFetch<Alert>(`/alerts/${id}/acknowledge`, { method: 'POST' }),

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

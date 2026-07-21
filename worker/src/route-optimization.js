const PROJECT_ID = /^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|\d{6,20})$/;
const TASK_ID = /^(?:stop|ord)_[A-Za-z0-9]+$/;
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_ACCESS_TOKEN_CACHE = new Map();
const TERMINAL_STATES = new Set([
  'completed', 'failed', 'cancelled', 'skipped_by_dispatch',
]);

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'route_optimizer_configuration' });
}

function optimizationError(message, code = 'route_optimization_failed') {
  return Object.assign(new Error(message), { code });
}

function base64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function serviceAccountCredentials(env) {
  let credentials;
  try {
    credentials = JSON.parse(env.GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw configurationError('Google Route Optimization service-account credentials are invalid.');
  }
  if (credentials?.type !== 'service_account'
    || credentials.project_id !== env.GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID
    || typeof credentials.client_email !== 'string'
    || !credentials.client_email.endsWith('.iam.gserviceaccount.com')
    || typeof credentials.private_key_id !== 'string'
    || !/^[a-f0-9]{40}$/.test(credentials.private_key_id)
    || typeof credentials.private_key !== 'string'
    || !credentials.private_key.includes('BEGIN PRIVATE KEY')) {
    throw configurationError('Google Route Optimization service-account credentials are invalid.');
  }
  return credentials;
}

async function importPrivateKey(pem) {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  let binary;
  try { binary = atob(encoded); } catch {
    throw configurationError('Google Route Optimization private key is invalid.');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw configurationError('Google Route Optimization private key is invalid.');
  }
}

function createGoogleAccessTokenProvider(env, fetchFn, options = {}) {
  const credentials = serviceAccountCredentials(env);
  const now = options.now || (() => Date.now());

  return async () => {
    const cached = GOOGLE_ACCESS_TOKEN_CACHE.get(credentials.private_key_id);
    if (cached?.expiresAt > now() + 60_000) return cached.token;
    const issuedAt = Math.floor(now() / 1000);
    const header = base64Url(JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      kid: credentials.private_key_id,
    }));
    const claims = base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: GOOGLE_CLOUD_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const unsignedAssertion = `${header}.${claims}`;
    const privateKey = await importPrivateKey(credentials.private_key);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(unsignedAssertion),
    );
    let response;
    try {
      response = await fetchFn(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsignedAssertion}.${base64Url(new Uint8Array(signature))}`,
        }).toString(),
      });
    } catch {
      throw optimizationError('Google authentication is unavailable.');
    }
    if (!response.ok) throw optimizationError('Google authentication failed.');
    let payload;
    try { payload = await response.json(); } catch {
      throw optimizationError('Google authentication returned an invalid response.');
    }
    if (typeof payload.access_token !== 'string' || payload.access_token.length < 20
      || payload.token_type !== 'Bearer') {
      throw optimizationError('Google authentication returned an invalid response.');
    }
    const expiresIn = Number.isFinite(Number(payload.expires_in))
      ? Math.min(Math.max(Number(payload.expires_in), 60), 3600) : 3600;
    GOOGLE_ACCESS_TOKEN_CACHE.set(credentials.private_key_id, {
      token: payload.access_token,
      expiresAt: now() + expiresIn * 1000,
    });
    return payload.access_token;
  };
}

function validLocation(location) {
  return location
    && Number.isFinite(location.latitude)
    && location.latitude >= -90
    && location.latitude <= 90
    && Number.isFinite(location.longitude)
    && location.longitude >= -180
    && location.longitude <= 180;
}

function googleTimestamp(timestamp) {
  return new Date(Math.floor(timestamp / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function waypoint(location) {
  if (!validLocation(location)) throw optimizationError('A route task has invalid coordinates.', 'invalid_route_plan');
  return { location: { latLng: { latitude: location.latitude, longitude: location.longitude } } };
}

function visitRequest(task, plan) {
  const visit = {
    arrivalWaypoint: waypoint(task.location),
    duration: `${Number.isInteger(task.serviceDurationSeconds) && task.serviceDurationSeconds >= 0
      ? task.serviceDurationSeconds : 300}s`,
    label: task.stopId,
  };
  if (task.promisedWindow) {
    const start = Date.parse(task.promisedWindow.from);
    const end = Date.parse(task.promisedWindow.to);
    const globalStart = Date.parse(plan.routeStartTime);
    const globalEnd = Date.parse(plan.routeEndTime);
    if (![start, end, globalStart, globalEnd].every(Number.isFinite)
      || start > end || start < globalStart || end > globalEnd) {
      throw optimizationError('A promised window is outside the route horizon.', 'invalid_route_plan');
    }
    visit.timeWindows = [{
      startTime: googleTimestamp(start),
      endTime: googleTimestamp(end),
    }];
  }
  return visit;
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw optimizationError('At least one route task is required.', 'invalid_route_plan');
  }
  const routeStart = Date.parse(plan.routeStartTime);
  const routeEnd = Date.parse(plan.routeEndTime);
  if (!Number.isFinite(routeStart) || !Number.isFinite(routeEnd) || routeStart >= routeEnd) {
    throw optimizationError('The route horizon is invalid.', 'invalid_route_plan');
  }
  if (!validLocation(plan.vehicleLocation)) {
    throw optimizationError('The driver location is invalid.', 'invalid_route_plan');
  }
  const stopIds = new Set();
  for (const task of plan.tasks) {
    if (!TASK_ID.test(task.stopId || '') || !TASK_ID.test(task.orderId || '')
      || !['pickup', 'dropoff'].includes(task.taskType)
      || !validLocation(task.location) || stopIds.has(task.stopId)
      || (task.requiredPredecessorStopId != null
        && !TASK_ID.test(task.requiredPredecessorStopId))) {
      throw optimizationError('A route task is invalid.', 'invalid_route_plan');
    }
    stopIds.add(task.stopId);
  }
  if (plan.currentStopLocked && !stopIds.has(plan.currentStopId)) {
    throw optimizationError('The locked current stop is missing.', 'invalid_route_plan');
  }
}

function buildShipments(plan, remainingTasks, lockedTask) {
  const onboard = new Set(plan.onboardOrderIds || []);
  if (lockedTask?.taskType === 'pickup') onboard.add(lockedTask.orderId);
  const byOrder = new Map();
  for (const task of remainingTasks) {
    if (TERMINAL_STATES.has(task.state)) continue;
    if (!byOrder.has(task.orderId)) byOrder.set(task.orderId, []);
    byOrder.get(task.orderId).push(task);
  }

  const shipments = [];
  for (const [orderId, tasks] of byOrder) {
    const pickups = tasks.filter((task) => task.taskType === 'pickup');
    const deliveries = tasks.filter((task) => task.taskType === 'dropoff');
    if (pickups.length > 1 || deliveries.length > 1) {
      throw optimizationError('An order has duplicate route tasks.', 'invalid_route_plan');
    }
    const pickup = pickups[0];
    const delivery = deliveries[0];
    if (!pickup && !delivery) continue;
    if (pickup && onboard.has(orderId)) {
      throw optimizationError('An onboard order still has an active pickup.', 'invalid_route_plan');
    }
    if (delivery && !pickup && !onboard.has(orderId)) {
      throw optimizationError('A delivery has no completed or planned pickup.', 'invalid_route_plan');
    }
    const shipment = { label: orderId };
    if (pickup && !onboard.has(orderId)) shipment.pickups = [visitRequest(pickup, plan)];
    if (delivery) shipment.deliveries = [visitRequest(delivery, plan)];
    if (!shipment.pickups && !shipment.deliveries) continue;
    shipments.push(shipment);
  }
  return shipments;
}

export function buildRouteOptimizationRequest(plan) {
  validatePlan(plan);
  const lockedTask = plan.currentStopLocked
    ? plan.tasks.find((task) => task.stopId === plan.currentStopId)
    : null;
  const remainingTasks = plan.tasks.filter((task) => task.stopId !== lockedTask?.stopId);
  const shipments = buildShipments(plan, remainingTasks, lockedTask);
  if (shipments.length === 0) {
    return {
      request: null,
      context: { lockedTask, optimizedTasks: [], onboardOrderIds: plan.onboardOrderIds || [] },
    };
  }
  const startLocation = lockedTask?.location || plan.vehicleLocation;
  return {
    request: {
      timeout: `${Number.isInteger(plan.solverTimeoutSeconds)
        ? Math.min(Math.max(plan.solverTimeoutSeconds, 1), 15) : 5}s`,
      searchMode: 'RETURN_FAST',
      considerRoadTraffic: true,
      model: {
        globalStartTime: googleTimestamp(Date.parse(plan.routeStartTime)),
        globalEndTime: googleTimestamp(Date.parse(plan.routeEndTime)),
        shipments,
        vehicles: [{
          label: 'eden-driver',
          travelMode: 'DRIVING',
          startWaypoint: waypoint(startLocation),
          costPerKilometer: 1,
        }],
      },
    },
    context: {
      lockedTask,
      optimizedTasks: remainingTasks.filter((task) => !TERMINAL_STATES.has(task.state)),
      onboardOrderIds: plan.onboardOrderIds || [],
    },
  };
}

export function parseRouteOptimizationResponse(context, payload) {
  if (!payload || !Array.isArray(payload.routes) || payload.routes.length !== 1
    || (payload.skippedShipments?.length || 0) > 0) {
    throw optimizationError('The optimizer returned an incomplete route.');
  }
  const visits = payload.routes[0].visits || [];
  const expectedIds = new Set(context.optimizedTasks.map((task) => task.stopId));
  const optimizedStopIds = visits.map((visit) => visit.visitLabel);
  if (optimizedStopIds.some((stopId) => !expectedIds.has(stopId))
    || new Set(optimizedStopIds).size !== optimizedStopIds.length
    || optimizedStopIds.length !== expectedIds.size) {
    throw optimizationError('The optimizer returned unexpected route tasks.');
  }
  const stopIds = [
    ...(context.lockedTask ? [context.lockedTask.stopId] : []),
    ...optimizedStopIds,
  ];
  const positions = new Map(stopIds.map((stopId, index) => [stopId, index]));
  const onboard = new Set(context.onboardOrderIds);
  if (context.lockedTask?.taskType === 'pickup') onboard.add(context.lockedTask.orderId);
  for (const task of context.optimizedTasks) {
    if (task.taskType !== 'dropoff') continue;
    const pairedPickup = context.optimizedTasks.find((candidate) => (
      candidate.orderId === task.orderId && candidate.taskType === 'pickup'
    ));
    if (task.requiredPredecessorStopId && pairedPickup
      && task.requiredPredecessorStopId !== pairedPickup.stopId) {
      throw optimizationError('The route plan has an invalid pickup predecessor.');
    }
    const predecessorStopId = task.requiredPredecessorStopId || pairedPickup?.stopId;
    const predecessorPosition = positions.get(predecessorStopId);
    const deliveryPosition = positions.get(task.stopId);
    if (predecessorPosition == null) {
      if (!onboard.has(task.orderId)) {
        throw optimizationError('The optimized route violates pickup precedence.');
      }
    } else if (predecessorPosition >= deliveryPosition) {
      throw optimizationError('The optimized route violates pickup precedence.');
    }
  }
  return {
    stopIds,
    etaByStopId: Object.fromEntries(visits
      .filter((visit) => typeof visit.startTime === 'string')
      .map((visit) => [visit.visitLabel, visit.startTime])),
    totalDistanceMeters: payload.routes[0].metrics?.travelDistanceMeters ?? null,
    totalDuration: payload.routes[0].metrics?.totalDuration ?? null,
  };
}

export function createGoogleRouteOptimizer(env, options = {}) {
  if (env.ROUTE_OPTIMIZATION_PROVIDER !== 'google') return null;
  if (!PROJECT_ID.test(env.GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID || '')) {
    throw configurationError('Google Route Optimization project is not configured.');
  }
  const fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
  if (!options.getAccessToken && !env.GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON) {
    throw configurationError('Google Route Optimization credentials are not configured.');
  }
  const getAccessToken = options.getAccessToken
    || createGoogleAccessTokenProvider(env, fetchFn, options);
  const projectId = env.GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID;

  return {
    async optimize(plan) {
      const { request, context } = buildRouteOptimizationRequest(plan);
      if (request == null) {
        return { stopIds: context.lockedTask ? [context.lockedTask.stopId] : [], etaByStopId: {}, totalDistanceMeters: 0, totalDuration: '0s' };
      }
      let res;
      try {
        const accessToken = await getAccessToken();
        res = await fetchFn(
          `https://routeoptimization.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:optimizeTours`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(request),
          },
        );
      } catch {
        throw optimizationError('The route optimization service is unavailable.');
      }
      if (!res.ok) {
        throw optimizationError(`The route optimization service returned HTTP ${res.status}.`);
      }
      let payload;
      try { payload = await res.json(); } catch {
        throw optimizationError('The route optimization service returned an invalid response.');
      }
      return parseRouteOptimizationResponse(context, payload);
    },
  };
}

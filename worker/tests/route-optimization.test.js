import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRouteOptimizationRequest,
  createGoogleRouteOptimizer,
  parseRouteOptimizationResponse,
} from '../src/route-optimization.js';

const task = (stopId, orderId, taskType, overrides = {}) => ({
  stopId,
  orderId,
  taskType,
  state: 'pending',
  location: { latitude: 32.07, longitude: 34.78 },
  serviceDurationSeconds: 300,
  ...overrides,
});

const plan = (overrides = {}) => ({
  routeStartTime: '2026-07-19T08:00:00.000Z',
  routeEndTime: '2026-07-19T18:00:00.000Z',
  vehicleLocation: { latitude: 32.071, longitude: 34.781 },
  currentStopId: 'stop_p1',
  currentStopLocked: true,
  onboardOrderIds: ['ord_0'],
  tasks: [
    task('stop_p1', 'ord_1', 'pickup'),
    task('stop_d0', 'ord_0', 'dropoff', { requiredPredecessorStopId: 'stop_p0' }),
    task('stop_d1', 'ord_1', 'dropoff', { requiredPredecessorStopId: 'stop_p1' }),
    task('stop_p2', 'ord_2', 'pickup'),
    task('stop_d2', 'ord_2', 'dropoff', { requiredPredecessorStopId: 'stop_p2' }),
    task('stop_p3', 'ord_3', 'pickup'),
    task('stop_d3', 'ord_3', 'dropoff', { requiredPredecessorStopId: 'stop_p3' }),
  ],
  ...overrides,
});

test('keeps the active stop fixed and models onboard deliveries without pickups', () => {
  const { request, context } = buildRouteOptimizationRequest(plan());

  assert.equal(context.lockedTask.stopId, 'stop_p1');
  assert.deepEqual(request.model.vehicles[0].startWaypoint.location.latLng, {
    latitude: 32.07,
    longitude: 34.78,
  });
  const byOrder = new Map(request.model.shipments.map((shipment) => [shipment.label, shipment]));
  assert.equal(byOrder.get('ord_0').pickups, undefined);
  assert.equal(byOrder.get('ord_0').deliveries[0].label, 'stop_d0');
  assert.equal(byOrder.get('ord_1').pickups, undefined);
  assert.equal(byOrder.get('ord_1').deliveries[0].label, 'stop_d1');
  assert.equal(byOrder.get('ord_2').pickups[0].label, 'stop_p2');
  assert.equal(byOrder.get('ord_2').deliveries[0].label, 'stop_d2');
  assert.equal(request.searchMode, 'CONSUME_ALL_AVAILABLE_TIME');
  assert.equal(request.timeout, '5s');
  assert.equal(request.model.vehicles[0].costPerKilometer, 1_000);
  assert.equal(request.model.vehicles[0].costPerTraveledHour, 240);
  assert.equal(request.considerRoadTraffic, true);
  assert.equal(request.model.globalStartTime, '2026-07-19T08:00:00Z');
  assert.equal(request.model.globalEndTime, '2026-07-19T18:00:00Z');
});

test('models urgent drop-offs as a bounded secondary soft deadline', () => {
  const urgentPlan = plan();
  urgentPlan.tasks.find((routeTask) => routeTask.stopId === 'stop_d2').urgency = 'urgent';

  const { request } = buildRouteOptimizationRequest(urgentPlan);
  const urgentDelivery = request.model.shipments
    .find((shipment) => shipment.label === 'ord_2').deliveries[0];

  assert.deepEqual(urgentDelivery.timeWindows, [{
    startTime: '2026-07-19T08:00:00Z',
    endTime: '2026-07-19T18:00:00Z',
    softEndTime: '2026-07-19T09:30:00Z',
    costPerHourAfterSoftEndTime: 100,
  }]);
});

test('constrains every shared-batch drop-off behind its one physical pickup', () => {
  const { request } = buildRouteOptimizationRequest(plan({
    currentStopId: null,
    currentStopLocked: false,
    onboardOrderIds: ['ord_2'],
    tasks: [
      task('stop_p1', 'ord_1', 'pickup'),
      task('stop_d1', 'ord_1', 'dropoff', { requiredPredecessorStopId: 'stop_p1' }),
      task('stop_d2', 'ord_2', 'dropoff', { requiredPredecessorStopId: 'stop_p1' }),
    ],
  }));

  assert.deepEqual(request.model.precedenceRules, [{
    firstIndex: 0,
    firstIsDelivery: false,
    secondIndex: 1,
    secondIsDelivery: true,
    offsetDuration: '0s',
  }]);
});

test('accepts a mixed optimized pickup and delivery sequence', () => {
  const { context } = buildRouteOptimizationRequest(plan());
  const result = parseRouteOptimizationResponse(context, {
    routes: [{
      visits: [
        { visitLabel: 'stop_d0', startTime: '2026-07-19T08:10:00Z' },
        { visitLabel: 'stop_p2', startTime: '2026-07-19T08:20:00Z' },
        { visitLabel: 'stop_d1', startTime: '2026-07-19T08:30:00Z' },
        { visitLabel: 'stop_p3', startTime: '2026-07-19T08:40:00Z' },
        { visitLabel: 'stop_d3', startTime: '2026-07-19T08:50:00Z' },
        { visitLabel: 'stop_d2', startTime: '2026-07-19T09:00:00Z' },
      ],
      metrics: { travelDistanceMeters: 12400, totalDuration: '3600s' },
    }],
  });

  assert.deepEqual(result.stopIds, [
    'stop_p1', 'stop_d0', 'stop_p2', 'stop_d1', 'stop_p3', 'stop_d3', 'stop_d2',
  ]);
  assert.equal(result.etaByStopId.stop_d2, '2026-07-19T09:00:00Z');
  assert.equal(result.totalDistanceMeters, 12400);
});

test('rejects an optimizer response that puts a delivery before its pickup', () => {
  const precedencePlan = plan();
  precedencePlan.tasks.find((routeTask) => routeTask.stopId === 'stop_d2')
    .requiredPredecessorStopId = null;
  const { context } = buildRouteOptimizationRequest(precedencePlan);
  assert.throws(() => parseRouteOptimizationResponse(context, {
    routes: [{ visits: [
      { visitLabel: 'stop_d2' }, { visitLabel: 'stop_p2' },
      { visitLabel: 'stop_d0' }, { visitLabel: 'stop_d1' },
      { visitLabel: 'stop_p3' }, { visitLabel: 'stop_d3' },
    ] }],
  }), /pickup precedence/);
});

test('sends an OAuth token only in a header and never sends customer PII', async () => {
  let captured;
  const optimizer = createGoogleRouteOptimizer({
    ROUTE_OPTIMIZATION_PROVIDER: 'google',
    GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID: 'edenmish-routing',
  }, {
    getAccessToken: async () => 'test-access-token',
    fetchFn: async (url, init) => {
      captured = { url, init };
      const { context } = buildRouteOptimizationRequest(plan());
      return new Response(JSON.stringify({ routes: [{
        visits: context.optimizedTasks.map((routeTask) => ({ visitLabel: routeTask.stopId })),
      }] }), { status: 200 });
    },
  });

  await optimizer.optimize(plan({ customerName: 'Never Send', phone: '0500000000' }));

  assert.equal(captured.url.includes('test-access-token'), false);
  assert.equal(captured.init.headers.Authorization, 'Bearer test-access-token');
  assert.equal(captured.init.body.includes('Never Send'), false);
  assert.equal(captured.init.body.includes('0500000000'), false);
});

test('is disabled by default and fails closed when enabled without credentials', () => {
  assert.equal(createGoogleRouteOptimizer({}), null);
  assert.throws(() => createGoogleRouteOptimizer({
    ROUTE_OPTIMIZATION_PROVIDER: 'google',
  }), /project is not configured/);
  assert.throws(() => createGoogleRouteOptimizer({
    ROUTE_OPTIMIZATION_PROVIDER: 'google',
    GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID: 'edenmish-routing',
  }), /credentials are not configured/);
  assert.throws(() => createGoogleRouteOptimizer({
    ROUTE_OPTIMIZATION_PROVIDER: 'google',
    GOOGLE_ROUTE_OPTIMIZATION_PROJECT_ID: 'edenmish-routing',
    GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON: '{}',
  }), /credentials are invalid/);
});

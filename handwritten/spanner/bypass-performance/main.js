#!/usr/bin/env node
'use strict';

const os = require('os');
const {performance} = require('perf_hooks');
const {MetricExporter} = require('@google-cloud/opentelemetry-cloud-monitoring-exporter');
const {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');
const spannerPackage = loadSpannerPackage();
const {Spanner} = spannerPackage;

const cfg = {
  loadMode: envString('LOAD_MODE', '').trim(),
  qps: envNumber('QPS', 400),
  concurrency: envNumber('CONCURRENCY', 0),
  scheduleIntervalMs: envNumber('SCHEDULE_INTERVAL_MS', 10),
  warmupCycles: envNumber('WARMUP_CYCLES', 1000),
  workload: envString('PROBE_TYPE', 'stale_query'),
  projectId: envString('SPANNER_PROJECT_ID', 'span-cloud-testing'),
  instanceId: envString('SPANNER_INSTANCE_ID', 'irahul-load-test'),
  databaseId: envString('SPANNER_DATABASE_ID', 'db'),
  table: envString('TABLE', 'T'),
  keyColumn: envString('KEY_COLUMN', 'Key'),
  valueColumn: envString('VALUE_COLUMN', 'Value'),
  numRows: envNumber('NUM_ROWS', 10000000),
  fixedKey: envString('FIXED_KEY', '').trim(),
  payloadSize: envNumber('PAYLOAD_SIZE', 1000),
  maxStalenessSeconds: envNumber('MAX_STALENESS_SECONDS', 60),
  endpoint: envString('ENDPOINT', '').trim(),
  endpointInsecure: envBool('ENDPOINT_INSECURE', false),
  numChannels: envNumber('SPANNER_NUM_CHANNELS', 0),
  disableBuiltInMetrics: envBool('SPANNER_DISABLE_BUILT_IN_METRICS', true),
  enableExtendedTracing: envBool('SPANNER_ENABLE_EXTENDED_TRACING', false),
  enableEndToEndTracing: envBool('SPANNER_ENABLE_END_TO_END_TRACING', false),
  telemetryProjectId: envString('OTEL_PROJECT_ID', envString('SPANNER_PROJECT_ID', 'span-cloud-testing')),
  serviceName: envString('OTEL_SERVICE_NAME', 'irahul-node-stale-query'),
  comparisonLabel: envString('COMPARISON_LABEL', ''),
  enableCloudMonitoring: envBool('ENABLE_CLOUD_MONITORING', true),
  metricsPrefix: envString('METRICS_PREFIX', 'custom.googleapis.com/irahul/node'),
  metricsIntervalMs: envNumber('METRICS_INTERVAL_MS', 10000),
  logIntervalMs: envNumber('LOG_INTERVAL_MS', 10000),
  logChannelCounts: envBool('SPANNER_LOG_CHANNEL_COUNTS', false),
  channelCountsIntervalMs: envNumber('CHANNEL_COUNTS_INTERVAL_MS', 60000),
};

if (!cfg.loadMode) {
  cfg.loadMode = cfg.concurrency > 0 ? 'concurrency' : 'qps';
}
if (!['qps', 'concurrency'].includes(cfg.loadMode)) {
  throw new Error(`LOAD_MODE must be qps or concurrency, got ${cfg.loadMode}`);
}
if (cfg.loadMode === 'qps' && cfg.qps <= 0) throw new Error(`QPS must be > 0, got ${cfg.qps}`);
if (cfg.loadMode === 'concurrency' && cfg.concurrency <= 0) {
  throw new Error(`CONCURRENCY must be > 0 in concurrency mode, got ${cfg.concurrency}`);
}
if (cfg.numRows <= 0) throw new Error(`NUM_ROWS must be > 0, got ${cfg.numRows}`);

const hostname = os.hostname();
const clientPackage = spannerPackage.packageJson;
const clientVersion = cfg.comparisonLabel || clientPackage.version || 'unknown';
const LATENCY_BUCKET_BOUNDS_MS = [
  0.0, 0.01, 0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55,
  0.575, 0.6, 0.625, 0.65, 0.675, 0.7, 0.725, 0.75, 0.775, 0.8, 0.825,
  0.85, 0.875, 0.9, 0.925, 0.95, 0.975, 1.0, 1.05, 1.1, 1.15, 1.2, 1.25,
  1.3, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.75, 1.8, 1.85,
  1.9, 1.95, 2.0, 2.05, 2.1, 2.15, 2.2, 2.25, 2.3, 2.35, 2.4, 2.45,
  2.5, 2.6, 2.7, 2.8, 2.9, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7,
  3.8, 3.9, 4.0, 4.2, 4.5, 4.8, 5.0, 5.5, 6.0, 7.0, 8.0, 10.0, 13.0,
  16.0, 20.0, 25.0, 30.0, 40.0, 50.0, 65.0, 80.0, 100.0, 130.0, 160.0,
  200.0, 250.0, 300.0, 400.0, 500.0, 650.0, 800.0, 1000.0, 2000.0, 5000.0,
  10000.0, 20000.0, 50000.0, 100000.0,
];

class MetricsReporter {
  constructor() {
    this.baseLabels = {
      service: sanitizeLabel(cfg.serviceName),
      workload: sanitizeLabel(cfg.workload),
      version: sanitizeLabel(clientVersion),
      host: sanitizeLabel(hostname),
    };
    this.reset();
    if (cfg.enableCloudMonitoring) {
      this.exporter = new MetricExporter({
        projectId: cfg.telemetryProjectId,
        prefix: cfg.metricsPrefix,
      });
      this.reader = new PeriodicExportingMetricReader({
        exporter: this.exporter,
        exportIntervalMillis: cfg.metricsIntervalMs,
      });
      this.meterProvider = new MeterProvider({
        readers: [this.reader],
        views: [
          {
            instrumentName: 'latency_ms',
            aggregation: {
              type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
              options: {boundaries: LATENCY_BUCKET_BOUNDS_MS},
            },
          },
        ],
      });
      this.meter = this.meterProvider.getMeter('spanner-bypass-performance');
      this.requestCounter = this.meter.createCounter('op_count', {
        description: 'Total requests processed by the prober.',
        unit: '1',
      });
      this.errorCounter = this.meter.createCounter('error_count', {
        description: 'Total failed requests processed by the prober.',
        unit: '1',
      });
      this.latencyHistogram = this.meter.createHistogram('latency_ms', {
        description: 'Latency of requests processed by the prober.',
        unit: 'ms',
      });
      this.rpsGauge = this.meter.createObservableGauge('ops_per_second', {
        description: 'Requests per second processed by the prober.',
        unit: '1/s',
      });
      this.rpsGauge.addCallback(result => this.observeRps(result));
    }
  }

  reset() {
    this.latencyStats = createLatencyStats();
    this.count = 0;
    this.errors = 0;
    this.windowStart = Date.now();
    this.rpsCount = 0;
    this.rpsWindowStart = Date.now();
  }

  updateProbeStats(start) {
    const latency = normalizeLatency(performance.now() - start);
    this.count++;
    this.rpsCount++;
    recordLogLatencyStats(this.latencyStats, latency);
    this.requestCounter?.add(1, this.baseLabels);
    this.latencyHistogram?.record(latency, this.baseLabels);
  }

  recordError() {
    this.errors++;
    this.errorCounter?.add(1, this.baseLabels);
  }

  observeRps(result) {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - this.rpsWindowStart) / 1000);
    result.observe(this.rpsCount / elapsedSeconds, this.baseLabels);
    this.rpsCount = 0;
    this.rpsWindowStart = now;
  }

  snapshotAndReset() {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - this.windowStart) / 1000);
    const latencyStats = this.latencyStats;
    const snap = {
      elapsedSeconds,
      count: this.count,
      errors: this.errors,
      rps: this.count / elapsedSeconds,
      p50: distributionPercentile(latencyStats, 50),
      p90: distributionPercentile(latencyStats, 90),
      p99: distributionPercentile(latencyStats, 99),
      max: latencyStats.count ? latencyStats.max : 0,
      avg: latencyStats.count ? latencyStats.mean : 0,
    };
    this.count = 0;
    this.errors = 0;
    this.latencyStats = createLatencyStats();
    this.windowStart = now;
    return snap;
  }

  async forceFlush() {
    await this.meterProvider?.forceFlush();
  }

  async shutdown() {
    await this.meterProvider?.shutdown();
  }
}

class ProbeRunner {
  constructor(database, reporter) {
    this.database = database;
    this.reporter = reporter;
    this.inflight = 0;
    this.tokens = 0;
    this.stopped = false;
  }

  async warmup() {
    console.log(JSON.stringify({message: 'warmup_start', cycles: cfg.warmupCycles}));
    for (let i = 0; i < cfg.warmupCycles; i++) {
      await this.probeOnce();
      if ((i + 1) % 100 === 0) {
        console.log(JSON.stringify({message: 'warmup_progress', completed: i + 1}));
      }
    }
    this.reporter.reset();
    console.log(JSON.stringify({message: 'warmup_done'}));
  }

  start() {
    if (cfg.loadMode === 'concurrency') {
      this.startConcurrency();
    } else {
      this.startQps();
    }

    this.reportInterval = setInterval(async () => {
      const snap = this.reporter.snapshotAndReset();
      console.log(
        JSON.stringify({
          message: 'probe_stats',
          workload: cfg.workload,
          load_mode: cfg.loadMode,
          qps_target: cfg.loadMode === 'qps' ? cfg.qps : undefined,
          concurrency_target: cfg.loadMode === 'concurrency' ? cfg.concurrency : undefined,
          version: clientVersion,
          inflight: this.inflight,
          ...roundSnapshot(snap),
        }),
      );
    }, Math.max(cfg.logIntervalMs, cfg.metricsIntervalMs));
  }

  startQps() {
    const intervalMs = Math.max(1, cfg.scheduleIntervalMs);
    this.interval = setInterval(() => {
      if (this.stopped) return;
      this.tokens += (cfg.qps * intervalMs) / 1000;
      let launched = 0;
      while (this.tokens >= 1) {
        this.tokens -= 1;
        launched++;
        this.runOne().catch(err => {
          console.error(JSON.stringify({message: 'probe_run_error', error: err.message}));
        });
      }
    }, intervalMs);
  }

  startConcurrency() {
    this.workers = [];
    for (let i = 0; i < cfg.concurrency; i++) {
      this.workers.push(this.runWorker(i));
    }
  }

  async runWorker(workerIndex) {
    while (!this.stopped) {
      try {
        await this.runOne();
      } catch (err) {
        console.error(
          JSON.stringify({
            message: 'probe_worker_error',
            workerIndex,
            error: err.message,
          }),
        );
      }
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    clearInterval(this.reportInterval);
  }

  async runOne() {
    this.inflight++;
    const start = performance.now();
    try {
      await this.probeOnce();
      this.reporter.updateProbeStats(start);
    } catch (err) {
      this.reporter.recordError();
      console.error(
        JSON.stringify({
          message: 'probe_error',
          workload: cfg.workload,
          error: err.message,
          code: err.code,
        }),
      );
    } finally {
      this.inflight--;
    }
  }

  async probeOnce() {
    switch (cfg.workload) {
      case 'stale_query':
        return this.queryProbe(cfg.maxStalenessSeconds * 1000, 'stale_query');
      case 'strong_query':
        return this.queryProbe(0, 'strong_query');
      case 'stale_read':
        return this.readProbe(cfg.maxStalenessSeconds * 1000, 'stale_read');
      case 'strong_read':
        return this.readProbe(0, 'strong_read');
      case 'write':
        return this.writeProbe('write');
      default:
        throw new Error(`Unsupported PROBE_TYPE: ${cfg.workload}`);
    }
  }

  async queryProbe(maxStalenessMs, probeName) {
    const key = randomKey();
    const query = {
      sql: `SELECT ${cfg.keyColumn}, ${cfg.valueColumn} FROM ${cfg.table} WHERE ${cfg.keyColumn} = @Id`,
      params: {Id: key},
      types: {Id: 'int64'},
      requestOptions: {requestTag: `probe_type=${probeName}`},
      json: true,
    };
    const options = maxStalenessMs > 0 ? {maxStaleness: maxStalenessMs} : {strong: true};
    await this.database.run(query, options);
  }

  async readProbe(maxStalenessMs, probeName) {
    // Node multi-use snapshots reject bounded staleness (`maxStaleness`).
    // For stale read smoke coverage, use single-use SQL with the same bound.
    // `stale_query` remains the primary regression workload.
    if (maxStalenessMs > 0) {
      return this.queryProbe(maxStalenessMs, probeName);
    }
    const key = randomKey();
    const [snapshot] = await this.database.getSnapshot({strong: true});
    try {
      await snapshot.read(cfg.table, {
        keys: [[key]],
        columns: [cfg.keyColumn, cfg.valueColumn],
        requestOptions: {requestTag: `probe_type=${probeName}`},
        json: true,
      });
    } finally {
      snapshot.end();
    }
  }

  async writeProbe(probeName) {
    const key = randomKey();
    const table = this.database.table(cfg.table);
    const row = {};
    row[cfg.keyColumn] = key;
    row[cfg.valueColumn] = randomString(cfg.payloadSize);
    await table.upsert(row, {
      requestOptions: {requestTag: `probe_type=${probeName}`},
    });
  }
}

async function main() {
  const spannerOptions = {
    projectId: cfg.projectId,
    disableBuiltInMetrics: cfg.disableBuiltInMetrics,
    observabilityOptions: {
      enableExtendedTracing: cfg.enableExtendedTracing,
      enableEndToEndTracing: cfg.enableEndToEndTracing,
    },
  };
  if (cfg.numChannels > 0) {
    spannerOptions.numChannels = cfg.numChannels;
  }
  if (cfg.endpoint) {
    const parsed = parseEndpoint(cfg.endpoint);
    spannerOptions.servicePath = parsed.host;
    if (parsed.port) spannerOptions.port = parsed.port;
    if (cfg.endpointInsecure) {
      const {grpc} = require('google-gax');
      spannerOptions.sslCreds = grpc.credentials.createInsecure();
    }
  }

  console.log(
    JSON.stringify({
      message: 'prober_start',
      loadMode: cfg.loadMode,
      qps: cfg.qps,
      concurrency: cfg.concurrency,
      workload: cfg.workload,
      projectId: cfg.projectId,
      instanceId: cfg.instanceId,
      databaseId: cfg.databaseId,
      table: cfg.table,
      keyColumn: cfg.keyColumn,
      valueColumn: cfg.valueColumn,
      numRows: cfg.numRows,
      fixedKey: cfg.fixedKey || '<random>',
      maxStalenessSeconds: cfg.maxStalenessSeconds,
      endpoint: cfg.endpoint || '<default>',
      endpointInsecure: cfg.endpointInsecure,
      telemetryProjectId: cfg.telemetryProjectId,
      serviceName: cfg.serviceName,
      clientVersion,
      packageVersion: clientPackage.version,
      nodeVersion: process.version,
      hostname,
      logChannelCounts: cfg.logChannelCounts,
      channelCountsIntervalMs: cfg.channelCountsIntervalMs,
    }),
  );

  const spanner = new Spanner(spannerOptions);
  const database = spanner.instance(cfg.instanceId).database(cfg.databaseId, {
    min: envNumber('SESSION_POOL_MIN', 25),
    max: envNumber('SESSION_POOL_MAX', 400),
    maxIdle: envNumber('SESSION_POOL_MAX_IDLE', 25),
    incStep: envNumber('SESSION_POOL_INC_STEP', 25),
  });
  const reporter = new MetricsReporter();
  const runner = new ProbeRunner(database, reporter);

  const shutdown = async signal => {
    console.log(JSON.stringify({message: 'shutdown_start', signal}));
    runner.stop();
    try {
      await reporter.forceFlush();
      await reporter.shutdown();
    } catch (err) {
      console.error(JSON.stringify({message: 'metrics_shutdown_error', error: err.message}));
    }
    try {
      await database.close();
    } catch (err) {
      console.error(JSON.stringify({message: 'database_close_error', error: err.message}));
    }
    try {
      spanner.close();
    } catch (err) {
      console.error(JSON.stringify({message: 'spanner_close_error', error: err.message}));
    }
    console.log(JSON.stringify({message: 'shutdown_done'}));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await runner.warmup();
  runner.start();
}


function loadSpannerPackage() {
  try {
    return {
      ...require('@google-cloud/spanner'),
      packageJson: require('@google-cloud/spanner/package.json'),
    };
  } catch (err) {
    try {
      return {
        ...require('../build/src'),
        packageJson: require('../package.json'),
      };
    } catch (fallbackErr) {
      err.message = `${err.message}; fallback failed: ${fallbackErr.message}`;
      throw err;
    }
  }
}



function randomKey() {
  if (cfg.fixedKey) {
    return cfg.fixedKey;
  }
  return Math.floor(Math.random() * cfg.numRows);
}

const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomString(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CHARACTERS.charAt(Math.floor(Math.random() * CHARACTERS.length));
  }
  return out;
}

function createLatencyStats() {
  return {
    count: 0,
    mean: 0,
    sumOfSquaredDeviation: 0,
    max: 0,
    bucketCounts: new Array(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0),
  };
}

function recordLogLatencyStats(stats, value) {
  const latency = normalizeLatency(value);
  const previousMean = stats.mean;
  stats.count++;
  stats.mean += (latency - stats.mean) / stats.count;
  stats.sumOfSquaredDeviation += (latency - previousMean) * (latency - stats.mean);
  stats.max = Math.max(stats.max, latency);
  stats.bucketCounts[findLatencyBucketIndex(latency)]++;
}

function normalizeLatency(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function findLatencyBucketIndex(latency) {
  let low = 0;
  let high = LATENCY_BUCKET_BOUNDS_MS.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (latency < LATENCY_BUCKET_BOUNDS_MS[mid]) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

function distributionPercentile(stats, p) {
  if (!stats.count) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * stats.count));
  let cumulative = 0;
  for (let i = 0; i < stats.bucketCounts.length; i++) {
    cumulative += stats.bucketCounts[i];
    if (cumulative >= rank) {
      return i < LATENCY_BUCKET_BOUNDS_MS.length ? LATENCY_BUCKET_BOUNDS_MS[i] : stats.max;
    }
  }
  return stats.max;
}

function roundSnapshot(snap) {
  return {
    elapsedSeconds: round(snap.elapsedSeconds),
    count: snap.count,
    errors: snap.errors,
    rps: round(snap.rps),
    p50: round(snap.p50),
    p90: round(snap.p90),
    p99: round(snap.p99),
    max: round(snap.max),
    avg: round(snap.avg),
  };
}

function round(value) {
  return Number(value.toFixed(2));
}

function sanitizeLabel(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 100);
}

function parseEndpoint(endpoint) {
  const stripped = endpoint.replace(/^https?:\/\//, '');
  const [host, port] = stripped.split(':');
  return {host, port: port ? Number(port) : undefined};
}

function envString(key, defaultValue) {
  const value = process.env[key];
  return value === undefined || value === '' ? defaultValue : value;
}

function envNumber(key, defaultValue) {
  const value = process.env[key];
  return value === undefined || value === '' ? defaultValue : Number(value);
}

function envBool(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true';
}

main().catch(err => {
  console.error(JSON.stringify({message: 'fatal', error: err.message, stack: err.stack}));
  process.exit(1);
});

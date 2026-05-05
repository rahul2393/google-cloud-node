#!/usr/bin/env node
'use strict';

const os = require('os');
const {performance} = require('perf_hooks');
const {MetricServiceClient} = require('@google-cloud/monitoring').v3;
const spannerPackage = loadSpannerPackage();
const {Spanner} = spannerPackage;

const cfg = {
  qps: envNumber('QPS', 400),
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
};

if (cfg.qps <= 0) throw new Error(`QPS must be > 0, got ${cfg.qps}`);
if (cfg.numRows <= 0) throw new Error(`NUM_ROWS must be > 0, got ${cfg.numRows}`);

const hostname = os.hostname();
const clientPackage = spannerPackage.packageJson;
const clientVersion = cfg.comparisonLabel || clientPackage.version || 'unknown';

class MetricsReporter {
  constructor() {
    this.reset();
    this.client = cfg.enableCloudMonitoring ? new MetricServiceClient() : null;
    this.projectPath = this.client?.projectPath(cfg.telemetryProjectId);
    this.resource = {
      type: 'global',
      labels: {project_id: cfg.telemetryProjectId},
    };
    this.baseLabels = {
      service: sanitizeLabel(cfg.serviceName),
      workload: sanitizeLabel(cfg.workload),
      version: sanitizeLabel(clientVersion),
      host: sanitizeLabel(hostname),
    };
  }

  reset() {
    this.latencies = [];
    this.count = 0;
    this.errors = 0;
    this.windowStart = Date.now();
  }

  recordLatency(ms) {
    this.count++;
    this.latencies.push(ms);
  }

  recordError() {
    this.errors++;
  }

  snapshotAndReset() {
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - this.windowStart) / 1000);
    const values = this.latencies.splice(0, this.latencies.length);
    const snap = {
      elapsedSeconds,
      count: this.count,
      errors: this.errors,
      rps: this.count / elapsedSeconds,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p99: percentile(values, 99),
      max: values.length ? Math.max(...values) : 0,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    };
    this.count = 0;
    this.errors = 0;
    this.windowStart = now;
    return snap;
  }

  async writeCloudMonitoring(snap) {
    if (!this.client) return;
    const endTime = toProtoTimestamp(Date.now());
    const points = [];
    points.push(this.doubleSeries('ops_per_second', {}, snap.rps, endTime));
    points.push(this.doubleSeries('op_count', {}, snap.count, endTime));
    points.push(this.doubleSeries('error_count', {}, snap.errors, endTime));
    for (const [percentileName, value] of Object.entries({
      p50: snap.p50,
      p90: snap.p90,
      p99: snap.p99,
      avg: snap.avg,
      max: snap.max,
    })) {
      points.push(
        this.doubleSeries(
          'latency_ms',
          {percentile: percentileName},
          Number.isFinite(value) ? value : 0,
          endTime,
        ),
      );
    }
    try {
      await this.client.createTimeSeries({
        name: this.projectPath,
        timeSeries: points,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: 'Cloud Monitoring write failed',
          error: err.message,
          code: err.code,
        }),
      );
    }
  }

  doubleSeries(name, labels, value, endTime) {
    return {
      metric: {
        type: `${cfg.metricsPrefix}/${name}`,
        labels: {...this.baseLabels, ...labels},
      },
      resource: this.resource,
      points: [
        {
          interval: {endTime},
          value: {doubleValue: Number(value)},
        },
      ],
    };
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

    this.reportInterval = setInterval(async () => {
      const snap = this.reporter.snapshotAndReset();
      console.log(
        JSON.stringify({
          message: 'probe_stats',
          workload: cfg.workload,
          qps_target: cfg.qps,
          version: clientVersion,
          inflight: this.inflight,
          ...roundSnapshot(snap),
        }),
      );
      await this.reporter.writeCloudMonitoring(snap);
    }, Math.max(cfg.logIntervalMs, cfg.metricsIntervalMs));
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
      this.reporter.recordLatency(performance.now() - start);
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
      qps: cfg.qps,
      workload: cfg.workload,
      projectId: cfg.projectId,
      instanceId: cfg.instanceId,
      databaseId: cfg.databaseId,
      table: cfg.table,
      keyColumn: cfg.keyColumn,
      valueColumn: cfg.valueColumn,
      numRows: cfg.numRows,
      maxStalenessSeconds: cfg.maxStalenessSeconds,
      endpoint: cfg.endpoint || '<default>',
      endpointInsecure: cfg.endpointInsecure,
      telemetryProjectId: cfg.telemetryProjectId,
      serviceName: cfg.serviceName,
      clientVersion,
      packageVersion: clientPackage.version,
      nodeVersion: process.version,
      hostname,
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

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
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

function toProtoTimestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  return {seconds, nanos: (ms - seconds * 1000) * 1e6};
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

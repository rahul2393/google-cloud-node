# Node.js Spanner Kubernetes prober

Runs Java `bypass-performance`-style probes for Node.js Spanner.

Default workload: `stale_query` at `400` QPS against `T(Key, Value)`.

## Build images

```sh
IMAGE_REPO=us-central1-docker.pkg.dev/span-cloud-testing/irahul-images/irahul-node-client \
RELEASE_A=8.6.0 \
RELEASE_B=8.2.2 \
./bypass-performance/build-images.sh
```

Tags pushed:

- `current` and `current-<git-sha>` from this branch
- `release-a` and `release-<RELEASE_A>` from npm
- `release-b` and `release-<RELEASE_B>` from npm

## Run on Kubernetes

```sh
kubectl apply -f k8s/stale_query_compare.yaml
kubectl -n spanner-ns get pods -l workload=stale-query
```

## Useful env vars

- `PROBE_TYPE`: `stale_query`, `strong_query`, `stale_read`, `strong_read`, `write`
- `LOAD_MODE`: `qps` (default) or `concurrency`
- `QPS`: target QPS per pod when `LOAD_MODE=qps`
- `CONCURRENCY`: number of continuously running async probes when `LOAD_MODE=concurrency`
- `SPANNER_PROJECT_ID`, `SPANNER_INSTANCE_ID`, `SPANNER_DATABASE_ID`
- `NUM_ROWS`: random key range `[0, NUM_ROWS)`
- `FIXED_KEY`: if set, query/read/write same key instead of random `[0, NUM_ROWS)`
- `MAX_STALENESS_SECONDS`: stale query/read bound
- `ENABLE_CLOUD_MONITORING`: write custom metrics
- `SPANNER_LOG_CHANNEL_COUNTS`: log per-channel request counts
- `CHANNEL_COUNTS_INTERVAL_MS`: per-channel count interval, default `60000`
- `METRICS_PREFIX`: default `custom.googleapis.com/irahul/node`

Metrics:

- `${METRICS_PREFIX}/ops_per_second`
- `${METRICS_PREFIX}/op_count`
- `${METRICS_PREFIX}/error_count`
- `${METRICS_PREFIX}/latency_ms` as a distribution metric with explicit millisecond buckets.
  Use Cloud Monitoring percentile aligners for p50/p90/p99.

Metrics are recorded with the OpenTelemetry metrics SDK. The prober uses OTel
counter/histogram instruments and a Cloud Monitoring exporter.

Concurrency mode example:

```sh
LOAD_MODE=concurrency CONCURRENCY=110 PROBE_TYPE=stale_query node bypass-performance/main.js
```

In concurrency mode, QPS is emergent: `QPS ~= CONCURRENCY / avg_latency_seconds`.

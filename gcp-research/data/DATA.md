# Google Cloud Data & Storage Services for AI Agent Workloads — 2026 Reference

> **Scope**: Comprehensive 2026 reference for the GCP data and storage surface a TypeScript/Python AI-agent product (RAG, agent memory, event streaming, OLTP for agent state, telemetry) needs to evaluate before standardising. Confirmed against `cloud.google.com` documentation and release notes as of **May 2026**.
>
> **GA flag legend** — GA = Generally Available May 2026 · PRV = Preview · DEP = Deprecated · NEW = Rebranded/renamed in last 12 months.
>
> **Reading order**: skim section 1 (decision tree) → jump to the services you actually need → revisit cross-cutting sections (vector search, memory bank, event bus, cost) at the end.

---

## 0. TL;DR — what to pick for a Claude-Agent-SDK product in 2026

| Need | Pick | Why |
|---|---|---|
| Object store, signed uploads, model artefacts | **Cloud Storage** (with **Rapid Cache** for hot reads) | Default. Hierarchical namespace for atomic folder ops, dual-region for resilience. |
| Agent **memory bank** (per-user facts, recall) | **Firestore Native** (+ Vertex AI Agent Engine Memory Bank) | Firestore is the documented backend for Memory Bank; serverless, scales to zero. |
| **Vector search** for RAG (<10M vectors, batch refresh fine) | **BigQuery** + `AI.GENERATE_EMBEDDING` + `CREATE VECTOR INDEX` | Embeddings, index, retrieval all in SQL. Zero ops. |
| **Vector search** alongside transactional data | **AlloyDB AI** (or Spanner Vector Search at multi-region scale) | Same row = vector + scalar columns; ACID; ScaNN. |
| **Vector search** at extreme low latency, billions of vectors | **Vertex AI Vector Search** (ScaNN) | Purpose-built. <50ms at billion-scale. |
| **In-process / sub-ms vector cache** | **Memorystore for Valkey 8** | Vector search GA, multi-threaded, ~1B vectors. |
| Agent state OLTP (Postgres) | **AlloyDB for PostgreSQL** | 4x faster than community PG, columnar engine + AI built-in. |
| Multi-region transactional core | **Spanner** (Enterprise Plus 99.999%) | The only TrueTime DB. Graph + vector + relational. |
| Analytics warehouse, semantic layer | **BigQuery + Knowledge Catalog** | Cataloged, governed, Gemini-aware. |
| Event bus between agents (A2A) | **Pub/Sub** (Standard, schema-validated) | Exactly-once + ordering keys + schema evolution. |
| Cron/scheduled agent triggers | **Cloud Scheduler → Pub/Sub** or **Cloud Tasks** | Tasks for per-request retry semantics; Scheduler for cron. |
| Streaming ETL into warehouse | **Dataflow** (Prime, at-least-once) | Apache Beam, serverless, GPU support. |
| Iceberg lakehouse / open-table format | **BigLake** + **Knowledge Catalog** + **Managed Service for Apache Spark** | Open formats, central governance. |

---

## 1. Cross-cutting decision trees

### 1.1 Vector search — pick-one decision tree

```
START
  │
  ├─ Are vectors stored alongside *transactional rows you mutate* (user row + their embedding)?
  │     YES → AlloyDB AI (ScaNN)  or Spanner Vector Search (if multi-region/global)
  │     NO  → continue
  │
  ├─ Are vectors derived from rows you *already have in BigQuery*?
  │     YES → BigQuery + AI.GENERATE_EMBEDDING + CREATE VECTOR INDEX (autonomous mode)
  │     NO  → continue
  │
  ├─ Do you need <50 ms p99 at billion-scale, isolated index?
  │     YES → Vertex AI Vector Search (Matching Engine, ScaNN, dedicated endpoint)
  │     NO  → continue
  │
  ├─ Do you need sub-millisecond, in-memory cache of the top-N nearest vectors?
  │     YES → Memorystore for Valkey 8 (vector search GA)
  │     NO  → continue
  │
  ├─ Do you need vector search co-located with document data (per-user collections,
  │   real-time listeners, mobile/web SDK)?
  │     YES → Firestore Native vector search (KNN, COSINE/DOT_PRODUCT/EUCLIDEAN)
  │
  └─ Default for unknown shape: BigQuery (cheapest to start, fits ≤10M vectors easily,
     trivial to wire to Gemini for embeddings).
```

Two heuristics:

1. **Co-location rule** — keep the vector with whichever store *owns* the row of truth. Cross-store joins for retrieval add a network hop you will pay for forever.
2. **Refresh-cadence rule** — if embeddings refresh on every write → AlloyDB / Spanner / Firestore. If refresh is hourly/daily batch → BigQuery autonomous embedding column.

### 1.2 Agent memory backend (confirmed)

Vertex AI **Agent Engine Memory Bank** is the managed memory layer; its **default backend is Firestore Native** for the consolidated user-fact store, with **Vertex AI Vector Search** (or BigQuery, AlloyDB, Spanner) pluggable for the semantic-recall index. Confirmed via Google Cloud Codelabs and the Agent Engine documentation. The split is:

- **Session state** (within-conversation, ephemeral) → Agent Engine Sessions, persisted to Firestore.
- **Long-term memory** (cross-conversation facts) → Memory Bank → Firestore docs + a vector index (default Vertex AI Vector Search; AlloyDB AI is the recommended alternative when you already run Postgres).
- **Graph memory** (relationships between entities) → Spanner Graph with vector columns; surfaced via LangChain `SpannerGraphStore`.

Recommended pairing for social-seeding-v2 today: Firestore Native (user-fact docs) + BigQuery vector index (campaign-knowledge RAG) + Memorystore Valkey (hot recall cache for the orchestrator).

### 1.3 Event bus for agent-to-agent (A2A)

| Question | If yes | If no |
|---|---|---|
| Do you need durable, replayable, fan-out to many subscribers? | **Pub/Sub** | continue |
| Do you need per-target retry policy, rate limit, deduplication at the *task* level (one task = one HTTP call)? | **Cloud Tasks** | continue |
| Do you need to listen to *Google Cloud system events* (GCS upload, Audit Log, Firestore write)? | **Eventarc** (Standard or Advanced) | continue |
| Do you need a deterministic, multi-step orchestration with retries, parallel branches, and error catchers? | **Workflows** (often *behind* Eventarc) | n/a |
| Do you need cron? | **Cloud Scheduler** (publishes to Pub/Sub/HTTP) | n/a |

**Anti-patterns**:

- Don't use Pub/Sub as a job queue with per-task retry limits — Cloud Tasks is built for that.
- Don't use Cloud Tasks for fan-out (one event → N consumers); Pub/Sub does this natively.
- Eventarc Advanced sits *on top* of Pub/Sub and adds CloudEvents routing/filtering/transformation — pick it when you have >5 event sources and want a single channel.

### 1.4 Cost optimisation patterns for high-volume agent telemetry

1. **Tier the telemetry stream**: raw events → Pub/Sub → Dataflow → **partitioned + clustered** BigQuery tables in the `EVENTS` dataset. Apply **dataset-level time-travel = 2 days** (down from default 7) for event tables — saves ~70% on storage for high-churn telemetry.
2. **Use BigQuery's `BI Engine` / capacity-based billing** only for dashboards. For ad-hoc agent debugging, on-demand pricing is cheaper.
3. **Compress Pub/Sub messages** (gzip) when payloads > 1 KB and consumer is in the same region — you pay for egress, not for ingest.
4. **Pin Cloud Storage telemetry to a single-region bucket** in the same region as the consumer; dual-region triples write cost and is only worth it for true DR data.
5. **Use Cloud Storage lifecycle rules** to move agent-trace JSONs from STANDARD → NEARLINE at 30 days → ARCHIVE at 180 days → DELETE at 365 days.
6. **Sample low-value events**: if you emit per-token telemetry, sample 1:10 in Dataflow before writing to BigQuery. Keep 100% in Pub/Sub for short retention (24 h).
7. **Pre-aggregate at write time**: use Dataflow stateful processing to emit per-minute counters into a small fact table; keep raw events only as long as you can replay.
8. **Set `--max-retention-duration` on Pub/Sub topics** to 24-48 h for telemetry; default 7 days is expensive at scale.
9. **Memorystore Valkey** for any counter / leaderboard you'd otherwise increment in BigQuery — BigQuery DML on a hot row is the worst-case cost.

---

## 2. Cloud Storage (GA)

### 2.1 What it is

Globally available object storage. In 2026 the surface includes four "shapes": **Standard buckets** (regional/dual-region/multi-region), **Rapid buckets** (zonal, NVMe-backed, sub-ms read latency, for model loading), **Anywhere Cache → renamed to Rapid Cache** (SSD-backed zonal read cache, transparent), and **Hierarchical Namespace (HNS)** buckets (folders as first-class with atomic rename).

### 2.2 AI-agent use cases

- Model artefacts (LoRA weights, fine-tuned adapters) — Rapid bucket or Rapid Cache fronting Standard.
- Multi-modal inputs for agents (PDFs, screenshots, video) — Standard regional, fed into Gemini.
- Agent trace JSONL archives — Standard with lifecycle to NEARLINE → ARCHIVE.
- Signed-URL uploads from a Next.js frontend (avoid round-tripping through your backend).
- Source for Vertex AI batch inference and BigQuery external tables (BigLake/Iceberg).

### 2.3 Latest features (2026)

- **Rapid Cache** (was *Anywhere Cache*) is GA. Zonal SSD cache; up to **2.5 TB/s aggregate read throughput**; no code change — point your reads at the same bucket URL.
- **Rapid Bucket** is GA. Zone-locked, single-zone SSD storage class; optimised for AI training/inference where compute and storage co-locate.
- **Hierarchical Namespace** is GA with **Autoclass** support.
- **Soft Delete** is enabled by default for new buckets.
- **Cross-bucket replication** for dual-region is now strongly consistent.
- **Managed folders** allow IAM at folder granularity (not just bucket).
- **Object Lifecycle Management** now supports a "set storage class to Archive when number of newer versions > N" rule.

### 2.4 Minimum working code (Python)

```python
# pip install google-cloud-storage>=2.18
from google.cloud import storage
from datetime import timedelta

client = storage.Client(project="my-project")
bucket = client.bucket("my-agent-traces")

# Write
blob = bucket.blob("runs/2026-05-19/run-abc.json")
blob.upload_from_string(b'{"event":"agent.start"}', content_type="application/json")

# Read
data = blob.download_as_bytes()

# Signed URL for direct browser upload (PUT)
upload_url = blob.generate_signed_url(
    version="v4",
    expiration=timedelta(minutes=15),
    method="PUT",
    content_type="application/json",
)
# Frontend can now PUT directly to upload_url with no backend hop.

# Lifecycle rule (idempotent)
bucket.lifecycle_rules = [
    {"action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
     "condition": {"age": 30, "matchesPrefix": ["runs/"]}},
    {"action": {"type": "SetStorageClass", "storageClass": "ARCHIVE"},
     "condition": {"age": 180, "matchesPrefix": ["runs/"]}},
    {"action": {"type": "Delete"},
     "condition": {"age": 365, "matchesPrefix": ["runs/"]}},
]
bucket.patch()
```

### 2.5 Best practices

- **One bucket per blast-radius**, not per environment. Mixing prod and dev in one bucket invites accidental `gsutil rm -r gs://bucket/`.
- **Always enable Soft Delete** (7-day default). It's free and undoes the `rm -r` mistake.
- **Use HNS for any prefix you treat like a directory** (atomic rename is the win — without HNS, "rename" is N copies + N deletes).
- **Sign URLs with V4**, never V2. V2 is being deprecated for new code paths.
- **Compress before uploading** unless the consumer is BigQuery (BigQuery prefers `gzip` for CSV/JSON external tables but **uncompressed Parquet/Avro** for performance).
- **Set `--uniform-bucket-level-access`** — never use object ACLs.
- **Dual-region only when you can defend the 2× cost** with a recovery scenario. Most analytics data does not need it.
- **Use Rapid Cache for any read-heavy workload sharing a bucket across zones** — it pays for itself within ~2 TB of repeated reads.

### 2.6 Docs

- https://cloud.google.com/storage/docs/release-notes
- https://cloud.google.com/storage/docs/introduction
- https://cloud.google.com/storage/docs/hns-overview
- https://cloud.google.com/storage/docs/anywhere-cache

---

## 3. BigQuery (GA) — including BigQuery ML, BigQuery Studio, BigQuery DataFrames

### 3.1 What it is

Serverless petabyte warehouse with built-in ML and vector capabilities. In 2026 BigQuery is the *first* place to put any data you want Gemini, Looker, or agents to query; **BigQuery Studio** is the unified IDE (SQL + Python notebooks + DataFrames + Spark + Dataform) inside the BigQuery console.

### 3.2 AI-agent use cases

- **RAG corpus** for agent retrieval — embeddings co-located with text, no separate vector DB.
- **Agent telemetry warehouse** — partition by `event_date`, cluster by `agent_id, run_id`.
- **Feature store** for any ML model the agent calls.
- **Tool surface** — agents can call BigQuery via the Claude SDK MCP server for analytics questions ("how many emails did campaign X send last week?").
- **Multimodal embedding store** — text, image, audio, video, PDF all in one column via `AI.GENERATE_EMBEDDING(gemini-embedding-2)`.

### 3.3 Latest features (2026)

- **BigQuery Studio** (unified IDE) is GA.
- **BigQuery DataFrames 2.0** (`bigframes`) — pandas API, scales to PB; **Gemini Code Assist for DataFrames** in PRV.
- **`AI.GENERATE_EMBEDDING`** is the modern function (replaces `ML.GENERATE_EMBEDDING` for new code); supports **`gemini-embedding-2-preview`** (multimodal: text/image/audio/video/PDF).
- **Autonomous embedding generation** (PRV → GA in mid-2026): declare a derived column, BigQuery keeps the embeddings in sync with the source column.
- **`AI.SEARCH`** — simplified vector search that auto-uses the table's embedding column.
- **BigQuery AI Query Engine** — natural-language instructions inside SQL (e.g. `... WHERE AI.SCORE(description, 'mentions hiring') > 0.7`).
- **BigLake Iceberg tables** are writable from Spark *and* BigQuery; metastore is unified with Knowledge Catalog.
- **Continuous queries** (streaming SQL on Pub/Sub-fed tables) GA.

### 3.4 Minimum working code

**SQL — create an autonomous-embedding RAG table and search it.**

```sql
-- 1. Connect to a Vertex AI remote model
CREATE OR REPLACE MODEL `proj.rag.text_embed`
  REMOTE WITH CONNECTION `us.vertex-ai-conn`
  OPTIONS (ENDPOINT = 'gemini-embedding-2-preview');

-- 2. Create the source table; declare an *autonomous* embedding column
CREATE OR REPLACE TABLE `proj.rag.docs` (
  doc_id   STRING,
  body     STRING,
  body_vec ARRAY<FLOAT64>
    GENERATED ALWAYS AS (AI.GENERATE_EMBEDDING(MODEL `proj.rag.text_embed`, body))
);

-- 3. Create the vector index (ScaNN)
CREATE OR REPLACE VECTOR INDEX docs_idx
  ON `proj.rag.docs`(body_vec)
  OPTIONS (index_type = 'IVF', distance_type = 'COSINE');

-- 4. Insert; BigQuery generates the embedding automatically
INSERT INTO `proj.rag.docs`(doc_id, body)
VALUES ('d1', 'TikTok creator outreach: …'),
       ('d2', 'Brand campaign onboarding: …');

-- 5. Retrieve with AI.SEARCH
SELECT doc_id, body, distance
FROM AI.SEARCH(
  TABLE `proj.rag.docs`,
  'how do we onboard a new brand?',
  top_k => 5
);
```

**Python — BigQuery DataFrames + Gemini.**

```python
# pip install bigframes>=2
import bigframes.pandas as bpd
import bigframes.ml.llm as llm

bpd.options.bigquery.project = "my-project"
df = bpd.read_gbq("proj.rag.docs")

gem = llm.GeminiTextGenerator(model_name="gemini-3.1-flash-lite")
df["summary"] = gem.predict(df["body"])
df.to_gbq("proj.rag.docs_summary", if_exists="replace")
```

### 3.5 Best practices

- **Always partition large tables by date and cluster by the high-cardinality predicate** you actually filter on. Cuts scan cost 90%+.
- **Use `AI.GENERATE_EMBEDDING` over `ML.GENERATE_EMBEDDING`** for new code; the AI.* family is where multimodal goes.
- **Use autonomous embedding columns** to avoid hand-maintained backfill jobs.
- **Vector index requires ≥5000 rows** to be created and ~10k+ rows to actually help latency; below that, brute-force `VECTOR_SEARCH` is fine.
- **Capacity-based pricing (editions)** is cheaper than on-demand once you cross ~$1k/month of scan cost.
- **Store wide events flat, not nested**, when consumers are agents — agents handle flat schemas far more reliably than RECORD/ARRAY nesting.
- **Use BigQuery Studio notebooks** for any agent prompt-eval pipeline; DataFrames keeps the data in BigQuery and avoids local round-trips.
- **Avoid `SELECT *`** in any agent-generated SQL — use a query-rewriter middleware to inject `LIMIT` and a column whitelist.

### 3.6 Docs

- https://cloud.google.com/bigquery/docs/release-notes
- https://cloud.google.com/bigquery/docs/vector-search-intro
- https://cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-generate-embedding
- https://cloud.google.com/bigquery/docs/autonomous-embedding-generation
- https://cloud.google.com/bigquery/docs/bigquery-dataframes-introduction
- https://cloud.google.com/bigquery/docs/gemini-overview

---

## 4. Firestore (Native mode) (GA) — including Firestore Vector Search

### 4.1 What it is

Serverless document database with real-time listeners, offline SDKs (mobile/web), and ACID transactions. The default operational store for anything user-facing in a GCP product in 2026. Firestore **Enterprise edition** in Native mode (with the **Pipelines** operations interface) is GA; **KNN vector search** is in **Preview**, broadly used in production.

### 4.2 AI-agent use cases

- **Agent Memory Bank persistence** — Vertex AI Agent Engine writes consolidated user facts here by default.
- **Per-user session/state docs** — `users/{uid}/sessions/{sid}`.
- **Real-time agent UI** — Next.js subscribes via the web SDK, shows agent progress as it writes step docs.
- **Vector search** for per-user RAG (small corpora, hot reads) — vectors stored *inside* the doc.
- **Conversation transcripts** with subcollections for messages.

### 4.3 Latest features (2026)

- **Firestore Enterprise edition + Pipelines** — GA. Pipelines = composable stages (filter, transform, vector, aggregate) instead of the legacy query API.
- **Vector search (KNN)** with `COSINE | DOT_PRODUCT | EUCLIDEAN` — Preview, widely used; combine with prefilters and composite indexes.
- **`find_nearest` stage** in Pipelines for vector retrieval.
- **Bundles** GA — pre-computed, signed query results delivered as static assets (huge cost win on read-heavy public reads).
- **Multi-region locations** (`nam5`, `eur3`) with strong consistency and 99.999% SLA.
- **Time-travel reads** (`read_time`) GA — point-in-time queries up to 7 days back.
- **MongoDB-compatible API** (PRV) for Firestore — for lift-and-shift workloads.

### 4.4 Minimum working code (Python)

```python
# pip install google-cloud-firestore>=2.16
from google.cloud import firestore
from google.cloud.firestore_v1.vector import Vector
from google.cloud.firestore_v1.base_vector_query import DistanceMeasure

db = firestore.Client(project="my-project", database="(default)")

# Write a memory-bank fact with an embedding (assume embedding generated upstream)
embedding = [0.01, -0.03, ...]  # 768-dim from Vertex AI text-embedding-005
db.collection("users").document("u1").collection("memories").add({
    "text": "Prefers email outreach over DM",
    "embedding": Vector(embedding),
    "created_at": firestore.SERVER_TIMESTAMP,
})

# Vector search (KNN, top-5, cosine)
query_vec = Vector([0.011, -0.028, ...])
results = (
    db.collection("users").document("u1").collection("memories")
      .find_nearest(
          vector_field="embedding",
          query_vector=query_vec,
          distance_measure=DistanceMeasure.COSINE,
          limit=5,
      )
      .get()
)
for doc in results:
    print(doc.id, doc.to_dict())
```

### 4.5 Best practices

- **Design your document key for the dominant read path** — Firestore hot-spotting is real; never key by monotonic timestamp without a hash prefix.
- **Subcollections, not arrays**, when the inner collection can grow unbounded (messages, events). Arrays cap at ~1 MB doc size.
- **Use Security Rules + App Check** in any client-facing path — IAM alone is not enough on the web SDK.
- **Don't run analytics in Firestore**; mirror to BigQuery via the *Stream Firestore to BigQuery* extension or Dataflow.
- **Index every field you filter on** — Firestore auto-indexes single-field, but composite queries need explicit composite indexes.
- **For vector search, prefilter aggressively** — `where("user_id", "==", uid).find_nearest(...)`. Without prefilters, Firestore vector search is not cheap.
- **Use Bundles** for public RAG corpora — the entire dataset becomes a static asset cached at the CDN edge.
- **Set Firestore TTL fields** on ephemeral data (session docs, draft messages); free GC.

### 4.6 Docs

- https://cloud.google.com/firestore/docs/release-notes
- https://cloud.google.com/firestore/native/docs/vector-search
- https://firebase.google.com/docs/firestore/vector-search
- https://firebase.google.com/docs/firestore/pipelines/stages/transformation/find-nearest

---

## 5. Firestore Datastore mode (GA)

### 5.1 What it is

Same underlying storage as Firestore Native, exposed through the legacy Datastore API. **One-way switch**: you cannot convert a Datastore-mode project to Native mode in place.

### 5.2 When (if ever) to choose Datastore mode in 2026

Almost never for greenfield work. Choose Datastore mode only if:

1. You are migrating an App Engine Standard Python 2.7/Java 8 app that uses the original Datastore API and a rewrite is out of scope.
2. Your workload is server-side only, write-throughput-heavy (>10k QPS sustained on a single namespace), and you do not need real-time listeners, mobile SDKs, or vector search.
3. You explicitly want eventual consistency for some queries to gain throughput.

Otherwise, choose **Firestore Native**. All new GCP AI features (Agent Memory Bank backing, Pipelines, vector search, MongoDB compat) are Native-mode only.

### 5.3 Docs

- https://cloud.google.com/datastore/docs/firestore-or-datastore
- https://cloud.google.com/appengine/migration-center/standard/java/migrate-datastore

---

## 6. Cloud SQL — Postgres, MySQL, SQL Server (GA)

### 6.1 What it is

Managed Postgres / MySQL / SQL Server. In 2026 it remains the "boring choice" for moderate-scale OLTP. For higher performance and AI-native features, **AlloyDB** has eclipsed Cloud SQL for Postgres workloads, but Cloud SQL still wins on MySQL, SQL Server, and "we just need a small database".

### 6.2 AI-agent use cases

- Operational store for the agent-orchestrator backend (workspace, user, run rows).
- Bridge to legacy MySQL or SQL Server apps the agent needs to read/write.
- Cheap Postgres for prototypes that may later graduate to AlloyDB (wire-compatible).

### 6.3 Latest features (2026)

- **Cloud SQL Studio** with **IAM database authentication** GA for Postgres and MySQL.
- **Managed Connection Pooling** GA, with **IAM auth** GA on top of it (no more PgBouncer sidecars).
- **IAM group authentication** GA — assign DB roles to a Google Group.
- **Postgres 17** GA, **Postgres 18** PRV.
- **Database roles for IAM users** — IAM users can be granted PG roles directly.
- **Vertex AI integration** (`google_ml_integration` extension) — call Vertex models from SQL (`SELECT embedding(...)`).
- **Cloud SQL `gen_ai` extension** for vector storage with pgvector (HNSW), 16k dimensions.

### 6.4 Minimum working code (Python, Postgres)

```python
# pip install "cloud-sql-python-connector[pg8000]>=1.10" SQLAlchemy
from google.cloud.sql.connector import Connector, IPTypes
import sqlalchemy

connector = Connector(refresh_strategy="LAZY")
def getconn():
    return connector.connect(
        "my-project:us-central1:my-instance",
        "pg8000",
        user="agent-svc@my-project.iam",   # IAM service-account user
        db="agentdb",
        enable_iam_auth=True,
        ip_type=IPTypes.PRIVATE,
    )

engine = sqlalchemy.create_engine("postgresql+pg8000://", creator=getconn)

with engine.begin() as conn:
    conn.execute(sqlalchemy.text(
        "CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW())"
    ))
    conn.execute(sqlalchemy.text("INSERT INTO runs(id,status) VALUES (:i,:s)"),
                 [{"i": "run-1", "s": "ok"}])
```

### 6.5 Best practices

- **Default to IAM database auth + Cloud SQL Auth Proxy / Connector**. Never expose password-only auth to the internet.
- **Private IP + Private Service Connect** for production; public IP only behind explicit allow-lists for ops.
- **Managed Connection Pooling** for any serverless front-end (Cloud Run, Cloud Functions) — these create connections faster than Postgres can recycle them.
- **Read replicas in another region** for DR, not for read scale (latency hides bugs).
- **Use `pgvector` HNSW** for vector data <1M rows. Past that, move to AlloyDB AI.
- **Enable Insights / Query Insights** — catch the long-tail query before it pages you.
- **Don't run reporting on the primary**; replicate to BigQuery via Datastream.
- **Cloud SQL for SQL Server is the only Google-managed SQL Server**; pricing reflects that — only choose it for true SQL-Server dependencies.

### 6.6 Docs

- https://cloud.google.com/sql/docs/release-notes
- https://cloud.google.com/sql/docs/postgres/iam-authentication
- https://cloud.google.com/sql/docs/postgres/release-notes

---

## 7. AlloyDB for PostgreSQL (GA) — including AlloyDB AI

### 7.1 What it is

Postgres-compatible, Google-engineered fork with columnar engine, ML-built-in, and a vector subsystem (**AlloyDB AI**). In 2026 it is the recommended Postgres on GCP for any workload that touches AI: agent state, RAG-co-located-with-rows, HTAP analytics. Up to 4× faster than community Postgres on transactional workloads and up to 100× faster on analytical queries (thanks to the columnar engine).

### 7.2 AI-agent use cases

- **Agent transactional state** with **vector recall in the same row** — `users(id, profile, profile_vec VECTOR(768))` and a ScaNN index.
- **RAG** for documents you also need to update transactionally (legal contracts, support tickets).
- **Model endpoint management** — call Vertex AI / external LLMs from SQL via `google_ml.embedding(...)`.
- **Auto vector embeddings** — declare a column; AlloyDB keeps it in sync with the source column.

### 7.3 Latest features (2026)

- **ScaNN index** GA (the same algorithm behind Google Search) — up to **16× faster index build**, **6× faster vector queries**, **10× faster filtered vector queries** vs HNSW; scales to **10 billion vectors** with four-level trees.
- **Auto vector embeddings** GA — `CREATE TABLE ... embedding VECTOR(768) GENERATED ALWAYS AS (...)` with incremental refresh; **bulk mode is up to 130× faster** than row-by-row.
- **Model endpoint management** GA — register any HTTP-callable embedding/LLM endpoint, then call `google_ml.embedding('my_model', text)`.
- **Parallel index build, auto-maintenance, observability** for vector indexes.
- **AlloyDB AI Query Engine** — natural-language-in-SQL functions parallel to BigQuery's.
- **AlloyDB Studio** with Gemini SQL assistance GA.

### 7.4 Minimum working code (SQL, run via psql or the Cloud SQL Connector)

```sql
-- Enable AlloyDB AI extensions
CREATE EXTENSION IF NOT EXISTS google_ml_integration;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS alloydb_scann;

-- Register a Vertex AI embedding model
SELECT google_ml.create_model(
  model_id   => 'text-embed-005',
  model_provider => 'google',
  model_type => 'text_embedding',
  model_qualified_name => 'text-embedding-005',
  model_auth_type => 'alloydb_service_agent_iam'
);

-- Schema with an auto-embedded column
CREATE TABLE memories (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  text_vec vector(768) GENERATED ALWAYS AS (
    google_ml.embedding('text-embed-005', text)::vector
  ) STORED
);

-- ScaNN index, cosine distance
CREATE INDEX ON memories USING scann (text_vec cosine);

-- Query
SELECT id, text, text_vec <=> google_ml.embedding('text-embed-005', 'their email preference')::vector AS dist
FROM memories
WHERE user_id = 'u1'
ORDER BY dist ASC
LIMIT 5;
```

### 7.5 Best practices

- **Use ScaNN, not HNSW**, in 2026 — better build time, lower memory, faster filtered queries.
- **Filtered ANN**: put your `WHERE user_id = ...` *before* the vector predicate; ScaNN's filtered-search path is the main reason to choose AlloyDB over Vertex Vector Search for per-tenant RAG.
- **Use the columnar engine** for any reporting query — enable per-table or let it auto-select.
- **Auto embeddings + incremental refresh** is the default; never write a backfill cron yourself.
- **Read pools** for read scale; don't add traditional read replicas.
- **Use Private Service Connect + IAM auth**.
- **AlloyDB Omni** lets you run the same engine locally / on-prem / in another cloud — handy for staging without a cloud bill, and for compliance with data-residency.
- **Cost** — AlloyDB is more expensive than Cloud SQL per vCPU but typically ~50% cheaper *per workload* due to the speedup. Benchmark before deciding.

### 7.6 Docs

- https://cloud.google.com/alloydb/docs/release-notes
- https://cloud.google.com/alloydb/ai
- https://cloud.google.com/alloydb/docs/ai/store-index-query-vectors
- https://cloud.google.com/alloydb/docs/ai/create-scann-index
- https://cloud.google.com/blog/products/databases/alloydb-ai-auto-vector-embeddings-and-auto-vector-index

---

## 8. AlloyDB Omni (GA)

### 8.1 What it is

The AlloyDB engine packaged as a container (Docker, Kubernetes operator) or RPM. Run AlloyDB on-prem, on a developer laptop, on another cloud, or at the edge. Wire-compatible with managed AlloyDB.

### 8.2 AI-agent use cases

- **Local dev parity** — run the same DB engine on your laptop that prod uses; no `pg_dump` surprises.
- **Edge / on-prem** inference where data cannot leave a customer DC.
- **Multi-cloud** — keep one Postgres flavor across AWS/Azure/GCP.
- **Air-gapped vector search** with ScaNN + model endpoint management pointed at a local embedding model.

### 8.3 Latest features (2026)

- **Kubernetes operator** GA, CNCF-compliant.
- **Columnar engine** GA in Omni — up to 100× analytical speedup vs community Postgres.
- **AlloyDB AI in Omni** — ScaNN, auto embeddings, model endpoint management (all the AI bits run on-prem).
- **Linux 18.1.0** runtime GA; **container 16.3.0** GA.
- **Red Hat Ecosystem certified** images.

### 8.4 Minimum working code (Docker)

```bash
# Pull and run a single-node AlloyDB Omni
docker run --name alloydb-omni \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  -v alloydb-data:/var/lib/postgresql/data \
  -d google/alloydbomni:16.3.0

# Connect (psql client)
psql -h localhost -U postgres -d postgres
# … same SQL as managed AlloyDB above (CREATE EXTENSION vector; …)
```

### 8.5 Best practices

- **Use the Kubernetes operator** for HA, not raw containers.
- **Pin the image SHA**, never `:latest`.
- **For production on-prem**, run on bare-metal or VM with NVMe; AlloyDB's columnar engine assumes fast random IO.
- **Use the same backup tooling** as community Postgres (`pg_basebackup`, WAL archiving) — AlloyDB Omni is wire-compatible.
- **Mind the licensing** — Omni is included for managed-AlloyDB customers in a hybrid setup; standalone Omni has its own commercial terms.

### 8.6 Docs

- https://cloud.google.com/alloydb/omni
- https://cloud.google.com/alloydb/omni/docs/overview

---

## 9. Spanner (GA) — including Spanner Graph and Spanner Vector Search

### 9.1 What it is

Globally distributed, strongly consistent SQL database. The only general-purpose database that gives you **TrueTime + external consistency + 99.999% multi-region SLA**. In 2026 Spanner is a *multi-model* database: relational + key-value + **graph** + **vector** + **full-text**.

### 9.2 AI-agent use cases

- **Globally consistent agent state** (multi-region workspaces, financial / payments).
- **GraphRAG** — Spanner Graph + vector columns + LangChain `SpannerGraphStore`.
- **Hybrid retrieval** — full-text + vector in one query, low-latency.
- **Lightweight transactions at planetary scale** (Gartner ranks Spanner #1 in 2026 for this use case).

### 9.3 Latest features (2026)

- **Spanner Graph** GA — declarative graph schema (`CREATE PROPERTY GRAPH ...`) over relational tables; GQL queries.
- **Spanner Vector Search** GA — `KNN` and `ANN` with `COSINE_DISTANCE`, `EUCLIDEAN_DISTANCE`, `DOT_PRODUCT`.
- **Hybrid search** GA — full-text + vector in a single query.
- **Enterprise Plus edition** — 99.999% SLA on multi-region configs, point-in-time recovery, sharded-MySQL/Cassandra migration tools.
- **Spanner Omni** — Spanner-compatible engine for on-prem/edge (PRV).
- **LangChain integrations** GA for vector store and graph store.

### 9.4 Minimum working code (Python)

```python
# pip install google-cloud-spanner>=3.50
from google.cloud import spanner

client = spanner.Client(project="my-project")
inst   = client.instance("agent-inst")
db     = inst.database("agentdb")

# DDL — vector column + ANN index
db.update_ddl([
    """CREATE TABLE Memories (
         MemoryId  STRING(36) NOT NULL,
         UserId    STRING(64) NOT NULL,
         Text      STRING(MAX),
         Embedding ARRAY<FLOAT32>(vector_length=>768)
       ) PRIMARY KEY (UserId, MemoryId)""",
    """CREATE VECTOR INDEX MemoriesEmbIdx ON Memories(Embedding)
       OPTIONS (distance_type='COSINE', tree_depth=3)""",
]).result(120)

# Write
def insert(tx):
    tx.insert("Memories",
        columns=("MemoryId","UserId","Text","Embedding"),
        values=[("m1","u1","Prefers email", [0.01]*768)])
db.run_in_transaction(insert)

# KNN search
with db.snapshot() as snap:
    rows = snap.execute_sql(
        """SELECT MemoryId, Text,
                  COSINE_DISTANCE(Embedding, @q) AS dist
           FROM Memories
           WHERE UserId = @uid
           ORDER BY dist
           LIMIT 5""",
        params={"q": [0.011]*768, "uid": "u1"},
        param_types={"q": spanner.param_types.Array(spanner.param_types.FLOAT32),
                     "uid": spanner.param_types.STRING})
    for r in rows: print(r)
```

### 9.5 Best practices

- **Interleave** child tables in their parent for locality (the equivalent of a "primary key shard").
- **Avoid monotonic keys** — UUIDv7 or hash-prefix to spread writes across splits.
- **Use staleness reads** (`max_staleness=10s`) when you don't need strong consistency — they hit local replicas and are dramatically cheaper.
- **Enterprise Plus + multi-region** is overkill for ≤5 regions of activity; use Enterprise + dual-region.
- **Spanner Vector Search** is for cases where the vector lives next to data you already store in Spanner. For "we have 1B vectors with no other data" — pick Vertex AI Vector Search.
- **Use the Graph schema** only when relationships are first-class. Otherwise plain SQL with foreign keys is cheaper.
- **Capacity is granular** — scale processing units in increments of 100; don't over-provision.

### 9.6 Docs

- https://cloud.google.com/spanner/docs/release-notes
- https://cloud.google.com/spanner/docs/vector-search-overview
- https://cloud.google.com/products/spanner/graph
- https://cloud.google.com/spanner/sla
- https://cloud.google.com/blog/products/databases/spanner-graph-is-now-ga

---

## 10. Memorystore — Redis, Valkey, Memcached

### 10.1 What it is

Three flavors of managed in-memory store:

- **Memorystore for Valkey 8** (GA) — the Google-recommended successor to Redis (Valkey is the OSS fork after Redis changed licenses).
- **Memorystore for Redis Cluster** (GA) — managed Redis OSS clustered mode.
- **Memorystore for Redis** (GA, classic single-shard) — being eclipsed by Valkey for new workloads.
- **Memorystore for Memcached** (GA but **deprecated**) — shutdown **Jan 31 2029**; new instances blocked in new projects after **Feb 1 2027**. Migrate to Valkey.

### 10.2 AI-agent use cases

- **Top-N vector cache** — Valkey vector search GA, sub-ms p99 over 1B+ vectors.
- **Session store** for agent orchestrators (Inngest, BullMQ-style queues).
- **Rate limiting / token bucket** for LLM API quota management.
- **Leaderboards / counters** that would otherwise hammer BigQuery.
- **Pub/Sub-style ephemeral fan-out** within a single workspace (cheaper than full Pub/Sub for in-process worker coordination).

### 10.3 Latest features (2026)

- **Valkey 8** — vector search GA, **2× QPS vs Redis Cluster**, **99.99% SLA**, zero-downtime scale, **1–250 nodes**.
- **Vector search GA** also on **Memorystore for Redis Cluster**.
- **Remote MCP server for Memorystore for Redis** GA — agents can connect natively (Model Context Protocol).
- **Self-service maintenance** GA.
- **Memcached version-upgrade** GA, but the product is on a deprecation path.

### 10.4 Minimum working code (Python, Valkey via redis-py)

```python
# pip install "redis>=5.0"  (redis-py works as a Valkey client; wire-compatible)
import redis, struct, numpy as np

r = redis.Redis(host="10.x.x.x", port=6379, decode_responses=False)

# Define an index
r.execute_command(
    "FT.CREATE", "memidx",
    "ON", "HASH", "PREFIX", "1", "mem:",
    "SCHEMA",
      "user_id", "TAG",
      "embedding", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32",
      "DIM", "768", "DISTANCE_METRIC", "COSINE"
)

# Insert
vec = np.random.rand(768).astype(np.float32).tobytes()
r.hset("mem:1", mapping={"user_id":"u1","text":"Prefers email","embedding":vec})

# KNN top-5 with prefilter
qvec = np.random.rand(768).astype(np.float32).tobytes()
res = r.execute_command(
    "FT.SEARCH", "memidx",
    "(@user_id:{u1})=>[KNN 5 @embedding $q AS dist]",
    "PARAMS", "2", "q", qvec,
    "SORTBY", "dist", "DIALECT", "2"
)
print(res)
```

### 10.5 Best practices

- **Default to Valkey 8** for new workloads. Redis Cluster only if you need a specific Redis-OSS module Valkey doesn't have.
- **Don't use Memcached for new work** — it's on a death timeline; Valkey is faster, has more features, and Google has stopped investing in Memcached.
- **Use dedicated nodes for vector workloads** — vector search is CPU-heavy and will starve cache reads if mixed.
- **Persist nothing critical** to Memorystore — even with AOF/RDB, treat it as a cache.
- **Cluster mode for HA** — single-shard Redis loses data on failover for new writes.
- **Private Service Access** only; never put Memorystore on a public IP.
- **Set `maxmemory-policy=allkeys-lru`** for cache use cases; default `noeviction` will OOM you.
- **Read replicas** for read fan-out within the same cluster.

### 10.6 Docs

- https://cloud.google.com/memorystore/docs/valkey/release-notes
- https://cloud.google.com/memorystore/docs/valkey/about-vector-search
- https://cloud.google.com/memorystore/docs/redis/release-notes
- https://cloud.google.com/memorystore/docs/cluster/release-notes
- https://cloud.google.com/memorystore/docs/memcached/release-notes

---

## 11. Bigtable (GA) — including Bigtable for ML

### 11.1 What it is

Petabyte-scale wide-column NoSQL with single-digit-ms reads. The store behind Google Search, Maps, Analytics. In 2026 Bigtable also has GA **GoogleSQL** support and **vector search**, plus an **Enterprise Plus edition** with an **in-memory tier** for sub-ms reads.

### 11.2 AI-agent use cases

- **Massive agent event log** — append-only, time-series, billions of rows per agent.
- **Feature store** for ML models the agent calls (low-latency lookup by entity key).
- **Vector search at scale** with COSINE/EUCLIDEAN — when AlloyDB / Spanner are too slow at >10B vectors.
- **Materialised views from streaming sources** (Dataflow → Bigtable) — agents read pre-aggregated KPIs.

### 11.3 Latest features (2026)

- **GoogleSQL on Bigtable** GA — 200+ functions, aggregations, JSON, geo, vector.
- **KNN vector search** GA (`COSINE_DISTANCE`, `EUCLIDEAN_DISTANCE`).
- **Bigtable Studio + Gemini SQL assistance** PRV.
- **JDBC driver** GA.
- **Protobuf-typed columns** GA — query individual proto fields in SQL.
- **Enterprise Plus edition** with **in-memory storage tier** (sub-ms p99) PRV.
- **Continuous materialised views** GA — incremental aggregation maintained by Bigtable.
- **Logical views** GA — saved SQL view over raw tables.

### 11.4 Minimum working code (Python)

```python
# pip install google-cloud-bigtable>=2.27
from google.cloud import bigtable
from google.cloud.bigtable.row_set import RowSet

client = bigtable.Client(project="my-project", admin=True)
inst   = client.instance("agent-bt")
table  = inst.table("events")

# Write
row = table.direct_row("u1#2026-05-19T13:00:00Z#evt-1")
row.set_cell("d", "kind", "agent.start")
row.set_cell("d", "payload", '{"run_id":"r1"}')
row.commit()

# Read a row range for user 'u1' on 2026-05-19
rs = RowSet()
rs.add_row_range_from_keys(start_key=b"u1#2026-05-19", end_key=b"u1#2026-05-20")
for r in table.read_rows(row_set=rs):
    print(r.row_key, r.cells)

# SQL (GoogleSQL) — vector search
from google.cloud.bigtable import data_client
dc = data_client.BigtableDataClient(project="my-project")
sql = """SELECT _key, COSINE_DISTANCE(emb, @q) AS d
         FROM events_vec
         WHERE family('d') AND _key LIKE 'u1#%'
         ORDER BY d LIMIT 5"""
# (use the GoogleSQL execute_query endpoint, GA in 2026)
```

### 11.5 Best practices

- **Design the row key like an index**, not like a primary key — `{tenant}#{reverse_ts}#{event_id}` to scan recent-first.
- **Never use monotonic prefixes** — you'll hot-spot a single tablet server.
- **One column family per access pattern**; column families are physical files.
- **Garbage-collect old versions** with TTL/version policies (not at the app).
- **Use replicated clusters** for HA, app-profile routing for active-active.
- **GoogleSQL is great for ad-hoc**, but the HBase/native API is what your hot path should use — SQL adds parsing overhead.
- **Vector search in Bigtable** is for cases where the vector is *one column of many* on a row you already store there — don't pick Bigtable just for vectors.
- **Continuous materialized views** kill an entire class of Dataflow jobs — use them.

### 11.6 Docs

- https://cloud.google.com/bigtable/docs/release-notes
- https://cloud.google.com/bigtable/docs/find-k-nearest-neighbors
- https://cloud.google.com/bigtable

---

## 12. Dataform (GA)

### 12.1 What it is

Managed SQL transformation framework for BigQuery. Open-source roots, fully GitHub/GitLab-integrated, with compile-time dependency resolution and assertions. The dbt-like layer baked into BigQuery Studio.

### 12.2 AI-agent use cases

- **Versioned RAG pipeline** — declare embedding tables and indexes as Dataform SQLX with dependencies; CI catches schema drift before agents read stale data.
- **Agent telemetry transforms** — raw event tables → cleaned + enriched fact tables → daily roll-ups, all checked into git.
- **Data contracts** between agents and downstream BI — Dataform assertions fail the build when a contract breaks.

### 12.3 Latest features (2026)

- **Strict act-as mode** GA — Dataform must run as a specific service account; no implicit identity.
- **BigLake Iceberg table creation** GA from Dataform.
- **Job priority** (interactive vs batch) GA.
- **Real-time validation of compiled queries** PRV — find errors before you commit.
- **SQL workflow visual graph** PRV.
- **Auto cataloging into Knowledge Catalog** GA — metadata flows from Dataform into the catalog.
- **Policy tag config in `config{}`** PRV.

### 12.4 Minimum working code (SQLX in `definitions/memory_embeddings.sqlx`)

```sqlx
config {
  type: "incremental",
  schema: "rag",
  uniqueKey: ["doc_id"],
  bigquery: { partitionBy: "DATE(updated_at)", clusterBy: ["user_id"] },
  assertions: { uniqueKey: ["doc_id"], nonNull: ["doc_id","body"] }
}

pre_operations { CREATE MODEL IF NOT EXISTS ${self()}_model … }

SELECT
  doc_id,
  user_id,
  body,
  AI.GENERATE_EMBEDDING(MODEL `proj.rag.text_embed`, body) AS body_vec,
  CURRENT_TIMESTAMP() AS updated_at
FROM `proj.raw.docs`
${when(incremental(), `WHERE updated_at > (SELECT MAX(updated_at) FROM ${self()})`)}
```

### 12.5 Best practices

- **Always pin a Dataform Core version** in `dataform.json` — non-pinned upgrades break builds.
- **Use the workspace's service account explicitly** (Strict act-as) — easier audit, easier rotation.
- **Tag every table** with `tags: ["pii"]` or similar so policy tags propagate.
- **Run a separate Dataform schedule for backfills** — backfill jobs are batch priority; live jobs are interactive.
- **Tests, not just assertions** — Dataform has `manual` types you can use as unit tests for transforms.
- **Don't fork the OSS Dataform Core** unless absolutely necessary — Google's managed core has Iceberg + Knowledge Catalog hooks the OSS does not.

### 12.6 Docs

- https://cloud.google.com/dataform/docs/release-notes
- https://cloud.google.com/dataform/docs/overview
- https://cloud.google.com/dataform

---

## 13. Dataplex → Knowledge Catalog (GA, renamed April 2026)

### 13.1 What it is

The unified catalog, governance, lineage, profiling, and quality layer over BigQuery + Cloud Storage + BigLake + Spark. **Renamed to "Knowledge Catalog"** on **April 10 2026**; API/CLI/IAM names unchanged.

### 13.2 AI-agent use cases

- **Semantic layer for agents** — agents ask "what tables exist for campaign metrics?" and Knowledge Catalog answers via Gemini-generated descriptions.
- **Policy enforcement** — central PII tags propagate to BigQuery row/column policies.
- **Lineage** — when an agent suggests a SQL query, lineage tells you which upstream sources to verify.
- **Data quality gates** — Dataform job won't promote a table until DQ checks pass.

### 13.3 Latest features (2026)

- **Renamed to Knowledge Catalog**.
- **Gemini-inferred business context** — analyzes schemas, query logs, and semantic models to generate descriptions, infer relationships, suggest SQL patterns.
- **Knowledge Catalog premium processing tier** — exploration workbench, lineage, data quality, profiling.
- **Cross-engine governance** — same policy applies to BigQuery and Managed Service for Apache Spark.
- **Semantic search across catalog** in natural language.

### 13.4 Minimum working code (gcloud + Python)

```bash
# Tag a table as PII (gcloud)
gcloud data-catalog tags create \
  --entry=//bigquery.googleapis.com/projects/p/datasets/d/tables/t \
  --tag-template=projects/p/locations/us/tagTemplates/pii \
  --content='{"contains_pii":true,"classification":"high"}'
```

```python
# pip install google-cloud-datacatalog
from google.cloud import datacatalog_v1
dc = datacatalog_v1.DataCatalogClient()
search = dc.search_catalog(
    request={"scope": {"include_project_ids": ["my-project"]},
             "query": "system=bigquery type=table tag:pii"},
)
for r in search:
    print(r.relative_resource_name, r.display_name)
```

### 13.5 Best practices

- **One tag template per policy domain** (PII, financial, GDPR-restricted) — keep them simple.
- **Set quality rules as code** — DQ rules live in Dataform / Terraform, not the console.
- **Bind policy tags to BigQuery column-level access** — that's the enforcement edge.
- **Use semantic search in the catalog** as the canonical "what tables do we have" answer for new engineers and agents alike.
- **Lineage is automatic for BigQuery/Spark** — don't fight it; just consume it.

### 13.6 Docs

- https://cloud.google.com/dataplex
- https://cloud.google.com/dataplex/docs/introduction
- https://cloud.google.com/dataplex/docs/release-notes

---

## 14. Dataflow (GA) — Apache Beam, streaming + batch

### 14.1 What it is

Managed Apache Beam: serverless data processing for streaming and batch. Dataflow **Prime** (the autoscaling-by-state-separation flavor) is the recommended runtime in 2026.

### 14.2 AI-agent use cases

- **Stream Pub/Sub → BigQuery** for agent telemetry, with windowed aggregations.
- **Embedding pipelines** — read raw text from Pub/Sub, call Vertex AI, write vector to AlloyDB / BigQuery.
- **CDC** from Cloud SQL via Datastream → Dataflow → BigQuery.
- **GPU pipelines** — image preprocessing for multimodal agents.

### 14.3 Latest features (2026)

- **Dataflow Prime** GA.
- **At-least-once streaming mode** GA — cheaper, lower latency, allows duplicates.
- **Apache Beam Go SDK** GA on Dataflow.
- **Data sampling** GA — inspect per-step records in the UI.
- **Cloud Profiler integration** GA.
- **Vertical autoscaling for memory** GA in Java, Python, Go.

### 14.4 Minimum working code (Python, streaming Pub/Sub → BigQuery)

```python
# pip install apache-beam[gcp]>=2.62
import apache_beam as beam
from apache_beam.options.pipeline_options import PipelineOptions, StandardOptions, GoogleCloudOptions

opts = PipelineOptions(streaming=True)
opts.view_as(StandardOptions).runner = "DataflowRunner"
gco = opts.view_as(GoogleCloudOptions)
gco.project = "my-project"
gco.region  = "us-central1"
gco.staging_location = "gs://my-bucket/staging"
gco.temp_location    = "gs://my-bucket/temp"
gco.job_name         = "agent-events-stream"

schema = "event_id:STRING,user_id:STRING,kind:STRING,ts:TIMESTAMP,payload:STRING"

with beam.Pipeline(options=opts) as p:
    (p
     | "Read" >> beam.io.ReadFromPubSub(subscription="projects/my-project/subscriptions/agent-events-sub")
     | "Decode" >> beam.Map(lambda b: __import__("json").loads(b.decode()))
     | "Write" >> beam.io.WriteToBigQuery(
            table="my-project:agent.events",
            schema=schema,
            write_disposition="WRITE_APPEND",
            create_disposition="CREATE_NEVER",
            method="STREAMING_INSERTS"))
```

### 14.5 Best practices

- **Prime + at-least-once** for telemetry — the cost win is real, and idempotent writes mitigate the duplicate risk.
- **Use Streaming Engine + Runner v2** (default in Prime).
- **Side inputs for slowly-changing config** — don't re-read from BigQuery per element.
- **Windowed exact-once** only if downstream cannot dedupe — and write to BigQuery via `STORAGE_WRITE_API` with idempotent keys.
- **Templates (Flex)** for repeatable launches; never `python script.py` from a workstation in prod.
- **VPC-SC** Dataflow workers need their service account in the perimeter — common foot-gun.
- **Drain, don't cancel**, when updating streaming jobs to avoid data loss.
- **Use the new GoogleSQL pipelines** (DataflowSQL) for trivial transforms — saves writing Java/Python.

### 14.6 Docs

- https://cloud.google.com/dataflow/docs/release-notes
- https://cloud.google.com/dataflow/docs/guides/enable-dataflow-prime
- https://cloud.google.com/dataflow/docs

---

## 15. Dataproc → Managed Service for Apache Spark (GA, rebranded)

### 15.1 What it is

Managed Spark, Hadoop, Hive, Flink. **Rebranded** in 2026 as **Managed Service for Apache Spark** with two deployment modes:

- **Serverless** (formerly Dataproc Serverless) — jobs-as-a-service, pay-per-runtime.
- **Cluster** (formerly Dataproc clusters) — Spark-on-Compute-Engine, pay per cluster uptime.

### 15.2 AI-agent use cases

- **Heavy ML preprocessing** on parquet/iceberg in Cloud Storage / BigLake.
- **GraphFrames** computations the agent consumes.
- **PySpark notebooks** in BigQuery Studio.
- **Iceberg writes** that need Spark compute (Dataform handles SQL-only).

### 15.3 Latest features (2026)

- **Unified brand** — Managed Service for Apache Spark.
- **Lightning Engine** PRV → GA — C++ vectorised execution, up to **4.9× faster** than OSS Spark, zero code changes.
- **Premium tier** with Lightning Engine + intelligent caching.
- **BigQuery Studio integration** for Spark notebooks GA.
- **Knowledge Catalog governance** applied to Spark reads/writes.

### 15.4 Minimum working code (gcloud, serverless batch)

```bash
gcloud dataproc batches submit pyspark gs://my-bucket/jobs/clean_events.py \
  --region=us-central1 \
  --version=2.2 \
  --properties=spark.executor.memory=8g,spark.dynamicAllocation.enabled=true
```

```python
# clean_events.py
from pyspark.sql import SparkSession, functions as F
spark = SparkSession.builder.appName("clean_events").getOrCreate()
df = spark.read.json("gs://my-bucket/raw/events/*.json")
df = df.withColumn("ts", F.to_timestamp("ts"))
df.write.mode("append").saveAsTable("agent.events_clean")  # writes Iceberg in 2026 setup
```

### 15.5 Best practices

- **Serverless first**, cluster only for long-running notebook sessions or non-Spark Hadoop workloads.
- **Lightning Engine + premium tier** for any production ETL — the speedup is free for paying customers.
- **Always specify the runtime version** (`--version=2.2`) — don't drift.
- **Iceberg or Delta**, not raw Parquet, for any table you'll re-write.
- **Connect to Knowledge Catalog** so lineage / policy works for Spark too.

### 15.6 Docs

- https://cloud.google.com/dataproc-serverless/docs/overview
- https://cloud.google.com/dataproc-serverless/docs/release-notes
- https://cloud.google.com/products/managed-service-for-apache-spark

---

## 16. Pub/Sub (GA) — including Schema Registry, Schema Evolution

### 16.1 What it is

Managed, globally-distributed pub/sub messaging with at-least-once and (optionally) exactly-once delivery, ordering keys, schema validation, and dead-letter topics.

### 16.2 AI-agent use cases

- **Agent-to-agent (A2A)** event bus — one publisher, many subscribers.
- **Telemetry ingress** → Dataflow → BigQuery.
- **Decoupling slow tools from the orchestrator** — the agent emits a request, a Cloud Run subscriber handles it.
- **Push subscriptions** to Cloud Run with retries.

### 16.3 Latest features (2026)

- **Schema Registry** (Avro & Protobuf) GA.
- **Schema Evolution** GA — register new revisions, validated for reader/writer compatibility, up to 20 revisions per schema.
- **Exactly-once delivery** GA on pull subscriptions within a region.
- **Ordering keys** GA — per-key FIFO.
- **Big-payload (`>10 MB`) attachments via Cloud Storage** GA.
- **Single message transforms** (JS / Lua) PRV → GA — filter / reshape at the topic.

### 16.4 Minimum working code (Python)

```python
# pip install google-cloud-pubsub>=2.22
from google.cloud import pubsub_v1, pubsub
from concurrent.futures import TimeoutError
import json

PROJ = "my-project"
publisher  = pubsub_v1.PublisherClient()
topic_path = publisher.topic_path(PROJ, "agent-events")

# Publish (with ordering key + attrs)
data = json.dumps({"event":"agent.start","run_id":"r1"}).encode()
fut  = publisher.publish(topic_path, data, ordering_key="r1", agent="orchestrator")
print(fut.result(timeout=30))

# Subscribe (pull)
subscriber = pubsub_v1.SubscriberClient()
sub_path   = subscriber.subscription_path(PROJ, "agent-events-sub")

def cb(msg):
    print(msg.data, msg.attributes)
    msg.ack()

future = subscriber.subscribe(sub_path, callback=cb)
try:
    future.result(timeout=30)
except TimeoutError:
    future.cancel()
```

### 16.5 Best practices

- **Always attach a schema** in production. The day "free-form JSON" breaks a consumer is the day you wished you had.
- **Use ordering keys** sparingly — they cap throughput at the key level.
- **Exactly-once is regional**; cross-region replication is at-least-once.
- **DLQ every subscription**. Set `max_delivery_attempts=5–10`.
- **Push to Cloud Run** when you want auto-scale of the consumer; **pull** when you want backpressure control.
- **Set `--message-retention-duration`** intentionally — default 7 days is expensive for telemetry.
- **Use Cloud Storage payload offload** for messages >100 KB; you pay per byte, both at ingress and egress.
- **Filter at the subscription** (`--message-filter='attributes.kind="agent.error"'`) to avoid client-side discarding.

### 16.6 Docs

- https://cloud.google.com/pubsub/docs/release-notes
- https://cloud.google.com/pubsub/docs/schemas
- https://cloud.google.com/blog/products/data-analytics/pub-sub-schema-evolution-is-now-ga

---

## 17. Pub/Sub Lite (DEP — shutdown 2026)

### 17.1 What it is

A zone-locked, capacity-pre-provisioned, low-cost variant of Pub/Sub. **Deprecated**. **Turndown date: June 30 2026**. New customers blocked since September 24 2024.

### 17.2 Is it still relevant in 2026?

**No.** Active workloads must migrate by **June 30 2026**. The two migration targets are:

1. **Pub/Sub (Standard)** — for most application messaging. Higher cost than Lite, but fully managed and feature-rich.
2. **Managed Service for Apache Kafka** — when you need Kafka semantics, partition ownership, or Kafka-ecosystem tooling.

### 17.3 Migration notes

- **Throughput**: Standard scales automatically; Lite required pre-provisioned capacity. Most teams over-provisioned Lite, so the cost delta after migration is smaller than the per-GB sticker price suggests.
- **Ordering**: Lite ordering by partition → Pub/Sub ordering keys.
- **Replay**: Lite had built-in replay; Pub/Sub supports seek-by-snapshot or seek-by-timestamp on subscriptions.

### 17.4 Docs

- https://cloud.google.com/pubsub/docs/choosing-pubsub-or-lite
- https://cloud.google.com/pubsub/lite/docs

---

## 18. Cloud Tasks (GA)

### 18.1 What it is

Managed task queue with per-task retry, scheduling, deduplication, and rate-limited dispatch to HTTP targets. The right tool for **per-task** semantics where Pub/Sub's fan-out model is wrong.

### 18.2 AI-agent use cases

- **Outbound tool calls** with per-task retry policies (e.g., "post to Slack; retry 3× with exponential backoff").
- **Scheduled future actions** ("send follow-up email in 48h").
- **Rate-limited fan-out** — push 10k notifications at 50 QPS to obey downstream API limits.
- **Deduplicated work** — dedupe by `task_name` so an agent that retries doesn't enqueue twice.

### 18.3 Latest features (2026)

- HTTP targets to **Cloud Run, GKE, on-prem** (anywhere reachable) GA.
- **OIDC + OAuth2 auth headers** GA.
- **Task retention up to 31 days** GA.
- **Cloud Run Jobs as a target** GA (long-running jobs as tasks).

### 18.4 Minimum working code (Python)

```python
# pip install google-cloud-tasks>=2.16
from google.cloud import tasks_v2
from datetime import datetime, timedelta, timezone

cli = tasks_v2.CloudTasksClient()
parent = cli.queue_path("my-project", "us-central1", "agent-tools")

task = {
  "http_request": {
    "http_method": tasks_v2.HttpMethod.POST,
    "url": "https://tool.example.com/send",
    "headers": {"Content-Type": "application/json"},
    "body": b'{"to":"creator@example.com","tpl":"intro"}',
    "oidc_token": {"service_account_email": "agent@my-project.iam.gserviceaccount.com"},
  },
  "schedule_time": (datetime.now(timezone.utc) + timedelta(hours=48)),
  "dispatch_deadline": {"seconds": 60},
}
cli.create_task(parent=parent, task=task)
```

### 18.5 Best practices

- **Name your tasks deterministically** — Cloud Tasks dedupes by name for ~1h, the cheapest idempotency you can get.
- **Set per-queue rate limits** to obey downstream APIs (`maxDispatchesPerSecond`).
- **Use OIDC tokens** to authenticate to your own Cloud Run service — never a static API key.
- **DLQ via a max-attempt config**, then a Pub/Sub topic for surfacing failed tasks.
- **Don't use Cloud Tasks for cron** — use Cloud Scheduler for cron triggers; Tasks for the actual dispatch.

### 18.6 Docs

- https://cloud.google.com/tasks/docs
- https://cloud.google.com/tasks/docs/comp-tasks-sched

---

## 19. Eventarc (GA)

### 19.1 What it is

CloudEvents-based event routing on top of Pub/Sub, with deep Google Cloud system-event integrations (Cloud Audit Logs, GCS, Firestore, BigQuery, Workflows, third-party connectors).

### 19.2 AI-agent use cases

- **React to system events** — GCS upload triggers an agent indexing pipeline; Audit Log on a Spanner write triggers a re-embedding job.
- **CloudEvents in/out** — standard envelope, swap providers without code changes.
- **Eventarc Advanced** for cross-region / multi-source channel topologies.

### 19.3 Docs

- https://cloud.google.com/eventarc/standard/docs
- https://cloud.google.com/eventarc/standard/docs/workflows/route-trigger-cloud-pubsub

---

## 20. Vector search comparison — feature matrix

| Capability | BigQuery | Firestore | AlloyDB AI | Spanner | Vertex AI Vector Search | Memorystore Valkey | Bigtable |
|---|---|---|---|---|---|---|---|
| GA in May 2026 | ✅ (index GA) | ⚠️ KNN Preview, prod-used | ✅ ScaNN GA | ✅ GA | ✅ GA | ✅ GA | ✅ GA |
| Algorithm | IVF / TreeAH | Brute / IVF | **ScaNN** + HNSW | Tree-quantized | **ScaNN** | HNSW (multi-thread) | Tree |
| Max vectors | ~100M practical | ~100M | **10B** | 10B+ | **billions** | ~1B | tens of B |
| Latency p99 | seconds (SQL) | tens of ms | <20 ms | <30 ms | **<10 ms** | **<1 ms** | <50 ms |
| Filter w/ vector | Strong (SQL) | Strong | **Strong (ScaNN filter)** | Strong | Token-filter | Tag prefilter | SQL filter |
| Embedding generation in-DB | ✅ AI.GENERATE_EMBEDDING | ❌ | ✅ google_ml.embedding | ✅ ML.PREDICT | ❌ (Vertex separately) | ❌ | ❌ |
| Autonomous refresh | ✅ | ❌ | ✅ | ❌ (manual) | ❌ | ❌ | ❌ |
| Hybrid search (FTS+vec) | partial | ❌ | partial | **✅ GA** | ❌ | partial | partial |
| Multimodal | ✅ gemini-embedding-2 | depends on upstream | depends | depends | ✅ | depends | depends |
| Best for | RAG over warehouse data | Per-user RAG, mobile/web | OLTP+vec same row | Global+graph+vec | Pure vector workload | Hot cache | Massive event log w/ vec |

**Pragma**: for social-seeding-v2 today (Mongo + Inngest + small-to-medium RAG corpus), **BigQuery + autonomous embedding columns** is the lowest-friction first pick; graduate to AlloyDB AI when you need vectors on a row you also mutate, and to Vertex AI Vector Search when you cross ~10M vectors and need <50 ms p99.

---

## 21. Quick reference — service URLs

- Cloud Storage release notes — https://cloud.google.com/storage/docs/release-notes
- BigQuery release notes — https://cloud.google.com/bigquery/docs/release-notes
- Firestore release notes — https://cloud.google.com/firestore/docs/release-notes
- Cloud SQL release notes — https://cloud.google.com/sql/docs/release-notes
- AlloyDB release notes — https://cloud.google.com/alloydb/docs/release-notes
- Spanner release notes — https://cloud.google.com/spanner/docs/release-notes
- Memorystore Valkey release notes — https://cloud.google.com/memorystore/docs/valkey/release-notes
- Memorystore Redis release notes — https://cloud.google.com/memorystore/docs/redis/release-notes
- Memorystore Memcached release notes — https://cloud.google.com/memorystore/docs/memcached/release-notes
- Bigtable release notes — https://cloud.google.com/bigtable/docs/release-notes
- Dataform release notes — https://cloud.google.com/dataform/docs/release-notes
- Knowledge Catalog (Dataplex) release notes — https://cloud.google.com/dataplex/docs/release-notes
- Dataflow release notes — https://cloud.google.com/dataflow/docs/release-notes
- Managed Service for Apache Spark release notes — https://cloud.google.com/dataproc-serverless/docs/release-notes
- Pub/Sub schemas — https://cloud.google.com/pubsub/docs/schemas
- Pub/Sub Lite (deprecated) — https://cloud.google.com/pubsub/docs/choosing-pubsub-or-lite
- Cloud Tasks — https://cloud.google.com/tasks/docs
- Eventarc — https://cloud.google.com/eventarc/standard/docs
- Vertex AI Vector Search — https://cloud.google.com/vertex-ai/docs/vector-search/overview

---

## 22. Confirmed GA status snapshot — May 2026

| Service / Feature | Status May 2026 |
|---|---|
| Cloud Storage Rapid Cache (was Anywhere Cache) | GA |
| Cloud Storage Hierarchical Namespace | GA |
| Cloud Storage Rapid Bucket | GA |
| BigQuery `AI.GENERATE_EMBEDDING` | GA |
| BigQuery autonomous embedding generation | Preview (GA expected H2 2026) |
| BigQuery `CREATE VECTOR INDEX` | GA |
| BigQuery DataFrames 2.0 | GA |
| BigQuery Studio | GA |
| Firestore Enterprise edition + Pipelines | GA |
| Firestore vector search (KNN) | Preview (production-used) |
| Firestore MongoDB-compatible API | Preview |
| Cloud SQL Managed Connection Pooling + IAM auth | GA |
| Cloud SQL IAM database authentication (Postgres + MySQL) | GA |
| AlloyDB ScaNN index | GA |
| AlloyDB auto vector embeddings | GA |
| AlloyDB model endpoint management | GA |
| AlloyDB Omni (container 16.3, Linux 18.1) | GA |
| Spanner Graph | GA |
| Spanner Vector Search (KNN + ANN) | GA |
| Spanner Enterprise Plus (99.999% multi-region SLA) | GA |
| Memorystore for Valkey 8 vector search | GA |
| Memorystore for Redis Cluster vector search | GA |
| Memorystore for Redis remote MCP server | GA |
| Memorystore for Memcached | GA but **deprecated**, shutdown Jan 31 2029 |
| Bigtable GoogleSQL + vector search (KNN) | GA |
| Bigtable Enterprise Plus in-memory tier | Preview |
| Dataform Strict act-as mode | GA |
| Dataform Knowledge Catalog auto-cataloging | GA |
| Knowledge Catalog (renamed from Dataplex Apr 10 2026) | GA |
| Dataflow Prime | GA |
| Dataflow at-least-once streaming mode | GA |
| Managed Service for Apache Spark (renamed from Dataproc) | GA |
| Managed Service for Apache Spark Lightning Engine | GA |
| Pub/Sub Schema Registry + Schema Evolution | GA |
| Pub/Sub exactly-once delivery | GA |
| **Pub/Sub Lite** | **Deprecated** — turndown June 30 2026 |
| Eventarc Standard / Advanced | GA |
| Cloud Tasks (HTTP targets, OIDC, Cloud Run Jobs target) | GA |
| Vertex AI Vector Search 2.0 (ScaNN) | GA |

---

## 23. Where this fits the social-seeding-v2 stack today

You are on **MongoDB Atlas** + Inngest + Claude Agent SDK. If/when you migrate the AI surface to GCP, the lowest-disruption sequence:

1. **Lift cold-storage traces to Cloud Storage** (Standard, regional) with lifecycle → archive. Days, not weeks.
2. **Mirror operational events into BigQuery** via a Dataflow tap on a per-event-type basis (one stream per concern: outreach, replies, runs). Lets you build BigQuery-native RAG without touching Mongo.
3. **Stand up Firestore Native** for any new per-user agent memory feature (Agent Memory Bank when it lands as managed). Keep Mongo for the existing v1-shared collections.
4. **AlloyDB AI** only if/when you need vectors on rows you mutate transactionally (e.g., per-creator profile embeddings refreshed on each scrape).
5. **Spanner / Bigtable** are *not* required at current scale; revisit when QPS or geo-distribution forces a hand.

Hard avoids until proven needed: Pub/Sub Lite (deprecated), Memcached (deprecated), Datastore mode (one-way trap), monolithic Dataproc clusters (use Serverless / Managed Spark instead).

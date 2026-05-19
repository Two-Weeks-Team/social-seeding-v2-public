# Firebase Genkit — TS/JS Reference for v2 Mission Control

**Scope:** TypeScript/JavaScript only. Focus is v2 Mission Control (Next.js 16 App Router) running alongside the Inngest workflow backend.
**Status as of 2026-05-19** — all version claims verified against `genkit.dev` and `firebase.google.com` redirects observed during research.
**Confidence:** High for Genkit core APIs, model availability, deployment paths. Medium for the Genkit↔A2A bridge (no first-party Genkit→A2A adapter exists yet; integration goes through `@a2a-js/sdk`).

---

## 1. What Genkit is (one paragraph)

Genkit is Google's open-source GenAI framework for building model-agnostic, observability-first AI features in JS/TS, Go, and Python. The TS SDK is the most mature track and remains "best-in-class" per Google's own framing. It is *not* a multi-agent orchestrator — it is a typed wrapper around `generate()`, `defineFlow()`, `defineTool()`, `definePrompt()`, retrievers, and embedders, with a local Developer UI (port 4000) for tracing and a plugin model for swapping model providers (Vertex AI, Google AI Studio, OpenAI, Anthropic, Ollama, etc.). The TS package family lives under `genkit` (core) + `@genkit-ai/*` (plugins). It is the spiritual successor to Firebase's older `@google-cloud/aiplatform` ergonomics and is the recommended path for adding Gemini calls into Firebase/App Hosting/Cloud Run apps.

For v2: Genkit is the right tool for **Mission Control-side AI** (Next.js API routes that need typed Gemini calls, lightweight RAG over the v1 Atlas collections via Firestore-vector-search or Qdrant, embedding generation for `accounts_tiktok` enrichment). It is *not* the right tool for the heavyweight Inngest workflow agents — those stay on the Claude Agent SDK / ADK lane.

---

## 2. Installation + setup

### 2.1 Prerequisites

- **Node.js v20 or later** (Genkit docs explicitly state v20+; older "v18+" claims are stale).
- npm 10+, or pnpm/yarn — Genkit's CLI is npm-published but works under any package manager.
- A Google Cloud project (for Vertex AI) **or** a Gemini API key from AI Studio (for `googleAI()`).
- For local dev: nothing extra. Genkit ships its own Developer UI.

### 2.2 Core packages

```bash
# Core runtime + Zod re-export
npm install genkit

# Pick ONE model-provider plugin (or both):
npm install @genkit-ai/google-genai          # AI Studio Gemini (API key auth)
# Note: vertexAI() is now ALSO exported from @genkit-ai/google-genai
# The old @genkit-ai/vertexai package was unified into google-genai
# in late 2025 — both `googleAI()` and `vertexAI()` come from one package.

# CLI (global, optional but recommended for local Dev UI)
npm install -g genkit-cli
```

**Important migration note (2026):** The package previously known as `@genkit-ai/vertexai` was folded into `@genkit-ai/google-genai`. If you see a tutorial that says `npm install @genkit-ai/vertexai`, treat it as pre-2026. Today both initializers (`googleAI`, `vertexAI`) live in `@genkit-ai/google-genai`. The user's prompt asked us to "confirm `npm install genkit @genkit-ai/vertexai`" — **this is no longer the canonical install**. The current canonical command is `npm install genkit @genkit-ai/google-genai`, and you import either `googleAI` or `vertexAI` from it.

### 2.3 Minimal TypeScript bootstrap

```bash
mkdir my-genkit-app && cd my-genkit-app
npm init -y
npm pkg set type=module
npm install -D typescript tsx
npm install genkit @genkit-ai/google-genai
npx tsc --init
mkdir src && touch src/index.ts
```

`src/index.ts` — AI Studio (Gemini Developer API) variant:

```typescript
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';

export const ai = genkit({
  plugins: [googleAI()],                       // reads GEMINI_API_KEY / GOOGLE_API_KEY
  model: googleAI.model('gemini-2.5-flash', {
    temperature: 0.8,
  }),
});
```

`src/index.ts` — Vertex AI variant (Application Default Credentials):

```typescript
import { vertexAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';

export const ai = genkit({
  plugins: [
    vertexAI({ location: 'us-central1' }),     // or 'global'
  ],
});
```

Run the local Dev UI:

```bash
genkit start -- npx tsx --watch src/index.ts
# Dev UI → http://localhost:4000
```

### 2.4 Init in Next.js (App Router)

Two-file pattern. Genkit code lives in `src/genkit/`, exposed through `app/api/*/route.ts` via `@genkit-ai/next`.

```bash
npm install genkit @genkit-ai/google-genai @genkit-ai/next zod
```

`src/genkit/index.ts` — single shared `ai` instance:

```typescript
import { googleAI } from '@genkit-ai/google-genai';
import { genkit } from 'genkit';

export const ai = genkit({
  plugins: [googleAI()],
});
```

`src/genkit/menuSuggestionFlow.ts`:

```typescript
import { googleAI } from '@genkit-ai/google-genai';
import { z } from 'genkit';
import { ai } from './index';

export const menuSuggestionFlow = ai.defineFlow(
  {
    name: 'menuSuggestionFlow',
    inputSchema:  z.object({ theme: z.string() }),
    outputSchema: z.object({ menuItem: z.string() }),
    streamSchema: z.string(),
  },
  async ({ theme }, { sendChunk }) => {
    const { stream, response } = ai.generateStream({
      model: googleAI.model('gemini-2.5-flash'),
      prompt: `Invent a menu item for a ${theme} themed restaurant.`,
    });
    for await (const chunk of stream) sendChunk(chunk.text);
    const { text } = await response;
    return { menuItem: text };
  },
);
```

`src/app/api/menuSuggestion/route.ts`:

```typescript
import { menuSuggestionFlow } from '@/genkit/menuSuggestionFlow';
import { appRoute } from '@genkit-ai/next';

export const POST = appRoute(menuSuggestionFlow);
```

Client component (end-to-end-typed stream):

```typescript
'use client';
import { streamFlow } from '@genkit-ai/next/client';
import type { menuSuggestionFlow } from '@/genkit/menuSuggestionFlow';

export async function streamMenuItem(theme: string) {
  const result = streamFlow<typeof menuSuggestionFlow>({
    url: '/api/menuSuggestion',
    input: { theme },
  });
  for await (const chunk of result.stream) console.log(chunk);
  return await result.output;
}
```

**For v2 Mission Control specifically:** use the same pattern. Genkit flows become typed Next.js API routes that the Mission Control UI calls. They're independent from the Inngest workflow loop — Genkit flows are *synchronous request/response* (or streaming) helpers, not durable jobs. Anything that needs to outlive a request must still go through Inngest.

### 2.5 Init in Cloud Functions for Firebase (Gen 2)

```bash
firebase init genkit          # adds Genkit scaffolding to /functions
firebase login --reauth       # if needed
```

`functions/src/index.ts`:

```typescript
import { onCallGenkit, hasClaim } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import { generatePoemFlow } from './flows/generatePoem';

const apiKey = defineSecret('GEMINI_API_KEY');

export const generatePoem = onCallGenkit(
  {
    secrets: [apiKey],
    authPolicy: hasClaim('email_verified'),
    enforceAppCheck: true,
    consumeAppCheckToken: true,
    cors: 'mydomain.com',
  },
  generatePoemFlow,
);
```

`onCallGenkit` auto-supports both streaming and JSON. Secrets:

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy --only functions
```

### 2.6 Init in Cloud Run

`src/index.ts` adds an Express-style flow server:

```typescript
import { startFlowServer } from '@genkit-ai/express';
import { menuSuggestionFlow } from './flows/menuSuggestion';

startFlowServer({
  flows: [menuSuggestionFlow],
  port: Number(process.env.PORT ?? 3400),
});
```

`package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node lib/index.js"
  }
}
```

Deploy:

```bash
gcloud run deploy genkit-flows \
  --source . \
  --region us-central1 \
  --update-secrets=GEMINI_API_KEY=gemini-api-key:latest
```

For Vertex AI, drop the `--update-secrets` (auth flows through the Cloud Run service account → Vertex IAM). Cloud Run uses buildpacks by default, so no Dockerfile is required.

### 2.7 Init in Firebase App Hosting (the v2 Mission Control target)

Firebase App Hosting (GA April 2025) is the canonical home for a Next.js 16 SSR app that also serves Genkit flows. It's a managed Cloud Run with GitHub-connected deploys and a `apphosting.yaml` config file.

```bash
npm init @apphosting           # scaffolds Next.js + apphosting.yaml
firebase apphosting:secrets:set GEMINI_API_KEY
# Answer 'Y' when prompted to add to apphosting.yaml
```

`apphosting.yaml`:

```yaml
runConfig:
  cpu: 1
  memoryMiB: 512
  maxInstances: 10
  minInstances: 0
  concurrency: 80

env:
  - variable: GEMINI_API_KEY
    secret: GEMINI_API_KEY
  - variable: NODE_ENV
    value: production
    availability:
      - BUILD
      - RUNTIME
```

For local emulation, `apphosting.emulator.yaml` is auto-created and pulls secrets from Secret Manager dynamically, so it's safe to commit. Deploys are triggered by pushing to the configured live branch; rollbacks are one click in the Firebase Console.

---

## 3. Core concepts

### 3.1 Flows (`defineFlow`)

A flow is a typed, observable, resumable wrapper around any function that touches a model. It gets:

- Zod input/output schemas (runtime validation + TS inference)
- Optional streaming via `streamSchema` and `sendChunk`
- Automatic trace export to the Dev UI and OpenTelemetry exporters
- A stable name (used as the deploy handle by `onCallGenkit`, `appRoute`, `startFlowServer`)

```typescript
export const summarizeFlow = ai.defineFlow(
  {
    name: 'summarize',
    inputSchema:  z.object({ url: z.string().url() }),
    outputSchema: z.object({ summary: z.string(), wordCount: z.number() }),
  },
  async ({ url }) => {
    const body = await fetch(url).then(r => r.text());
    const { text } = await ai.generate({
      model: googleAI.model('gemini-2.5-flash'),
      prompt: `Summarize in 3 sentences:\n\n${body}`,
    });
    return { summary: text, wordCount: text.split(/\s+/).length };
  },
);
```

Flows are **not** durable. They run inside one HTTP request lifetime. For v2's resumable workflows, keep using Inngest and call flows from inside Inngest steps if needed.

### 3.2 Tools (`defineTool`)

Tools are typed functions the model can elect to call mid-generation. Genkit handles the call/response loop, including parallel and chained tool calls.

```typescript
const getWeather = ai.defineTool(
  {
    name: 'getWeather',
    description: 'Gets the current weather in a given location',
    inputSchema:  z.object({
      location: z.string().describe('The location to get the current weather for'),
    }),
    outputSchema: z.string(),
  },
  async ({ location }) => `The current weather in ${location} is 63°F and sunny.`,
);

const response = await ai.generate({
  prompt: 'What is the weather in Baltimore?',
  tools:  [getWeather],
});
```

Genkit feeds the tool schema to the model, executes the tool when requested, and continues generation. Works with every Gemini 2.x+ model and any provider plugin advertising `supports.tools`.

### 3.3 Prompts (`definePrompt`, Dotprompt)

Two ways to define prompts. **Dotprompt** is the recommended path — prompts live in `.prompt` files with YAML frontmatter, so they're versionable, diffable, and shippable independent of code.

`prompts/greeting.prompt`:

```
---
model: googleai/gemini-2.5-flash
config:
  temperature: 0.9
input:
  schema:
    location: string
    style?: string
  default:
    location: a restaurant
---
You are welcoming. Greet a guest at {{location}}{{#if style}} in a {{style}} style{{/if}}.
```

Load and call:

```typescript
const greeting = ai.prompt('greeting');
const { text } = await greeting({ location: 'Genkit Grub Pub' });
```

Multi-message and multimodal helpers:

```handlebars
{{role "system"}}You are helpful.
{{role "user"}}{{userQuestion}}
{{media url=photoUrl}}
```

Partials live in `_personality.prompt` (underscore prefix) and are referenced as `{{>personality style=style}}`.

Programmatic equivalent:

```typescript
const myPrompt = ai.definePrompt({
  name: 'myPrompt',
  model: 'googleai/gemini-2.5-flash',
  input:  { schema: z.object({ name: z.string() }) },
  prompt: 'Hello, {{name}}. How are you today?',
});
```

### 3.4 Retrievers (RAG)

Retrievers wrap a vector store and an embedder behind one `ai.retrieve({ retriever, query })` call. Genkit ships first-party retrievers for Firestore, Pinecone, ChromaDB, Vertex AI Vector Search, and a `devLocalVectorstore` for prototyping. Section 5 covers the full Firestore flow.

### 3.5 Evaluators

Evaluators score flow outputs against datasets — faithfulness, relevance, maliciousness, custom. They run from the Dev UI or as CI checks. Useful when you need to gate prompt changes on golden-set regression (per v2's "agents need a golden-set eval before the phase that depends on them is done" convention).

### 3.6 Generate API (model-agnostic)

`ai.generate()` is the lowest-level call and works identically across providers:

```typescript
const { text, output } = await ai.generate({
  model:  googleAI.model('gemini-2.5-flash'),
  prompt: 'Pick a TikTok creator niche for athleisure.',
  output: { schema: z.object({ niche: z.string(), rationale: z.string() }) },
  tools:  [getWeather],
  config: { temperature: 0.4, maxOutputTokens: 1024 },
  docs:   [/* retrieved Document[] for RAG */],
});
```

Streaming variant: `ai.generateStream({...})` → `{ stream, response }`.

---

## 4. Genkit + Gemini integration

### 4.1 `vertexAI` (production path)

Vertex AI is the recommended production path because it uses GCP IAM (no API key file to leak), supports regional pinning, gives you Provisioned Throughput, and is the only path to Gemini Enterprise listings.

```typescript
import { vertexAI } from '@genkit-ai/google-genai';
import { genkit } from 'genkit';

export const ai = genkit({
  plugins: [vertexAI({ location: 'us-central1' })],   // or 'global'
});

const { text } = await ai.generate({
  model: vertexAI.model('gemini-2.5-pro'),
  prompt: 'Hello',
});
```

Auth: Application Default Credentials. Locally, `gcloud auth application-default login`; on Cloud Run/Functions/App Hosting it picks up the runtime service account. The SA needs `roles/aiplatform.user` minimum.

Models available via `vertexAI.model(...)` as of May 2026:

- `gemini-2.5-pro` (GA, 1M context)
- `gemini-2.5-flash` (GA, fastest GA tier)
- `gemini-2.5-flash-lite` (GA, cheapest)
- `gemini-3.1-pro-preview` (preview, May 2026 — Genkit docs reference it explicitly)
- `gemini-pro-latest` (rolling alias)
- Embedders: `text-embedding-005`, `text-embedding-large-exp-03-07`, `gemini-embedding-001`

The 2.0 generation (`gemini-2.0-flash-001`, `gemini-2.0-flash-lite-001`) is retired to existing customers only as of March 2026. New v2 work should pin to 2.5 or 3.1.

### 4.2 `googleAI` (AI Studio path)

For local dev, prototypes, and apps that prefer an API key:

```typescript
import { googleAI } from '@genkit-ai/google-genai';

const ai = genkit({
  plugins: [googleAI()],                         // reads GEMINI_API_KEY
  // or: googleAI({ apiKey: process.env.MY_KEY })
});
```

Same model surface, different auth, different quota pool. Note that AI Studio quotas are dramatically lower than Vertex's — fine for the Dev UI, undersized for production traffic.

### 4.3 Model switching at call site

The recommended pattern: keep one `genkit({...})` init and choose the model per-call.

```typescript
// Cheap path
await ai.generate({ model: googleAI.model('gemini-2.5-flash-lite'), prompt });
// Heavy reasoning path
await ai.generate({ model: googleAI.model('gemini-2.5-pro'),       prompt });
// Preview / experimental
await ai.generate({ model: vertexAI.model('gemini-3.1-pro-preview'), prompt });
```

This maps cleanly onto v2's "Opus 4.7 for judgment, Haiku 4.5 for bulk" pattern: 2.5-pro/3.1-pro-preview as the judgment tier, 2.5-flash/flash-lite as the bulk tier.

---

## 5. Genkit + Firestore Vector Search

Firestore added native vector search in 2024 and Genkit ships `defineFirestoreRetriever` to consume it. This is the right RAG primitive for v2 Mission Control because:

- Firestore is already in the GCP stack (no new datastore to operate).
- It avoids the v1 Qdrant operational burden for the Mission Control's lighter retrieval needs.
- Costs scale with reads, not with VM hours.

### 5.1 Provision the vector index

```bash
gcloud firestore indexes composite create \
  --project=YOUR_PROJECT_ID \
  --collection-group=creators \
  --query-scope=COLLECTION \
  --field-config='vector-config={"dimension":"768","flat":"{}"}',field-path=embedding
```

Match `dimension` to your embedder's output (e.g. `text-embedding-005` = 768, `gemini-embedding-001` = 3072 by default but configurable).

### 5.2 Define the retriever

```typescript
import { defineFirestoreRetriever } from '@genkit-ai/firebase';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { vertexAI } from '@genkit-ai/google-genai';

initializeApp();
const firestore = getFirestore();

export const creatorRetriever = defineFirestoreRetriever(ai, {
  name: 'creatorRetriever',
  firestore,
  collection: 'creators',
  contentField: 'bio',
  vectorField: 'embedding',
  embedder: vertexAI.embedder('text-embedding-005'),
  distanceMeasure: 'COSINE',                  // or EUCLIDEAN, DOT_PRODUCT
});
```

### 5.3 Indexer (write path)

```typescript
import { FieldValue } from 'firebase-admin/firestore';

export async function indexCreator(text: string, meta: Record<string, unknown>) {
  const [{ embedding }] = await ai.embed({
    embedder: vertexAI.embedder('text-embedding-005'),
    content:  text,
  });
  await firestore.collection('creators').add({
    bio:       text,
    embedding: FieldValue.vector(embedding),
    ...meta,
  });
}
```

### 5.4 End-to-end RAG flow

```typescript
export const askAboutCreatorsFlow = ai.defineFlow(
  {
    name: 'askAboutCreators',
    inputSchema:  z.object({ query: z.string() }),
    outputSchema: z.object({ answer: z.string(), sources: z.array(z.string()) }),
  },
  async ({ query }) => {
    const docs = await ai.retrieve({
      retriever: creatorRetriever,
      query,
      options: { limit: 5, where: { country: 'US' } },
    });
    const { text } = await ai.generate({
      model: vertexAI.model('gemini-2.5-pro'),
      prompt: `Answer the question using ONLY the provided creator profiles. Cite by handle.\n\nQuestion: ${query}`,
      docs,
    });
    return {
      answer:  text,
      sources: docs.map(d => d.metadata?.handle as string).filter(Boolean),
    };
  },
);
```

For prototyping without Firestore, the same flow shape works with `@genkit-ai/dev-local-vectorstore` (in-memory, file-persisted). Swap the retriever ref and the rest is unchanged — keep this in mind for v2 local dev that already runs `mongodb-memory-server`.

---

## 6. Genkit + A2A

### 6.1 Does Genkit export A2A natively?

**No — not as of May 2026.** Genkit has no `toA2A(flow)` equivalent of ADK's `to_a2a(root_agent)`. The official A2A samples ([a2aproject/a2a-samples](https://github.com/a2aproject/a2a-samples)) include Genkit-based agents, but they bridge through `@a2a-js/sdk` rather than a first-party Genkit→A2A adapter.

### 6.2 The bridge pattern

You wrap a Genkit flow inside an `AgentExecutor` from `@a2a-js/sdk` and serve it with the SDK's Express handlers:

```typescript
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCard, Message, AGENT_CARD_PATH,
} from '@a2a-js/sdk';
import {
  AgentExecutor, RequestContext, ExecutionEventBus,
  DefaultRequestHandler, InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler, jsonRpcHandler, restHandler, UserBuilder,
} from '@a2a-js/sdk/server/express';
import { sourceCreatorsFlow } from './flows/sourceCreators';

const card: AgentCard = {
  name: 'Creator Sourcing Agent',
  description: 'Finds TikTok creators matching a brand brief.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: 'https://agent.example.com/a2a/jsonrpc',
  skills: [{ id: 'source', name: 'Source creators', description: '', tags: ['tiktok'] }],
  capabilities: { pushNotifications: false },
  defaultInputModes:  ['text'],
  defaultOutputModes: ['text'],
  additionalInterfaces: [
    { url: 'https://agent.example.com/a2a/jsonrpc', transport: 'JSONRPC' },
    { url: 'https://agent.example.com/a2a/rest',    transport: 'HTTP+JSON' },
  ],
};

class CreatorSourcingExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const userText = ctx.message.parts.find(p => p.kind === 'text')?.text ?? '';
    const result   = await sourceCreatorsFlow({ brief: userText });
    bus.publish({
      kind: 'message',
      messageId: uuidv4(),
      role: 'agent',
      parts: [{ kind: 'text', text: JSON.stringify(result) }],
      contextId: ctx.contextId,
    } as Message);
    bus.finished();
  }
  cancelTask = async () => {};
}

const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new CreatorSourcingExecutor());
const app = express();
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.use('/a2a/rest',    restHandler   ({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
app.listen(4000);
```

### 6.3 Path to Gemini Enterprise listing

Gemini Enterprise (the marketplace for "agents you can drop into Workspace + Vertex AI Agent Engine") wants A2A-compliant endpoints. The verified path today is:

1. **ADK (Python or TS)** → call `to_a2a(root_agent)` → A2A-compliant endpoint → submit to Agent Engine / Gemini Enterprise. This is the supported, documented path.
2. **Genkit** → wrap each flow in the `@a2a-js/sdk` `AgentExecutor` shown above → host on Cloud Run → submit. Functional but not the "happy path"; expect to write more glue and to handle multi-turn state yourself (the `InMemoryTaskStore` is dev-only; production needs a Firestore-backed task store).

**Verdict for v2:** if the goal is "list on Gemini Enterprise," port the agent to ADK rather than pushing Genkit through A2A by hand. Genkit's flow surface and ADK's agent surface are similar enough that the port is a few hundred lines, and you get first-party A2A support, agent state, and the Agent Engine deployment template for free. Keep Genkit for the dashboard-side typed Gemini calls and Firestore RAG — that's where its DX advantage compounds.

---

## 7. Deployment

| Target | Strength | When to pick it |
|---|---|---|
| **Cloud Functions for Firebase** (`onCallGenkit`) | Auth + App Check + streaming out of the box; per-flow function granularity | Discrete, callable AI features in a Firebase-centric app |
| **Cloud Run** (`startFlowServer`) | Buildpacks, no Dockerfile needed; scales independently of the Next.js app | Long-running flows, custom auth, non-Firebase stacks |
| **Firebase App Hosting** | One-deploy SSR Next.js + flows as API routes; auto-managed SSL, GitHub deploys | Mission Control-style apps — recommended for v2 |

### 7.1 Firebase Functions (Gen 2)

```typescript
import { onCallGenkit, hasClaim } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import { generatePoemFlow } from './flows/generatePoem';

const apiKey = defineSecret('GEMINI_API_KEY');

export const generatePoem = onCallGenkit(
  { secrets: [apiKey], authPolicy: hasClaim('email_verified') },
  generatePoemFlow,
);
```

Deploy: `firebase deploy --only functions`. Streaming and CORS are automatic. Functions Gen 2 runs on Cloud Run under the hood, so cold-start and concurrency tuning use the same knobs.

### 7.2 Cloud Run

```typescript
import { startFlowServer } from '@genkit-ai/express';
startFlowServer({ flows: [menuSuggestionFlow] });
```

```bash
gcloud run deploy genkit-flows \
  --source . --region us-central1 \
  --update-secrets=GEMINI_API_KEY=gemini-api-key:latest
```

Authorize via Cloud IAM (recommended) or per-flow `contextProvider`. Secrets via Secret Manager — grant the runtime SA `roles/secretmanager.secretAccessor`.

### 7.3 Firebase App Hosting (Next.js SSR + Genkit flows in one deploy)

This is the v2 Mission Control target. Single repo, single deploy, GitHub-triggered.

`apphosting.yaml`:

```yaml
runConfig:
  cpu: 1
  memoryMiB: 1024
  maxInstances: 20
  minInstances: 0
  concurrency: 80

env:
  - variable: GEMINI_API_KEY
    secret:   GEMINI_API_KEY
  - variable: GOOGLE_CLOUD_PROJECT
    value:    your-project-id
    availability: [BUILD, RUNTIME]
```

Set the secret:

```bash
firebase apphosting:secrets:set GEMINI_API_KEY
# Y to add to apphosting.yaml
firebase apphosting:backends:create        # one-time
git push origin main                       # auto-deploys
```

Roll back through the Firebase Console. For multi-env, App Hosting supports `apphosting.staging.yaml` / `apphosting.production.yaml`.

---

## 8. Genkit vs ADK — decision matrix

| Criterion | Pick Genkit | Pick ADK |
|---|---|---|
| Team language | TS/JS-only | Python-first (TS GA 1.0 in 2026 but Python remains canonical) |
| Use case | Chatbot, RAG, function-calling agent inside an app | Multi-agent collab, agent-as-coworker, graph workflows |
| Cloud lock-in tolerance | Want cloud-agnostic, easy local dev | OK with Vertex/Agent Engine alignment |
| Observability story | Built-in Dev UI + OTel | Agent Engine telemetry + Cloud Trace |
| Gemini Enterprise listing | Possible but glue-heavy via `@a2a-js/sdk` | First-party `to_a2a()`, documented path |
| Streaming HTTP responses | Native (`generateStream`, `sendChunk`) | Supported via A2A streams |
| State across turns | You manage it (Firestore, Redis) | Built-in agent state + memory APIs |
| Cold-start cost | Low (thin runtime) | Higher (more framework in the path) |
| Deploy target | Next.js / Cloud Run / Functions / App Hosting | Agent Engine / Cloud Run / GKE |

### 8.1 Verdict for v2

For **v2 Mission Control (Next.js 16 + Inngest backend):**

- **Genkit** is the right tool for the Next.js-side embedding, lightweight Firestore-vector-search RAG, typed Gemini calls from API routes, and the Dotprompt-versioned prompts the operator iterates on. It sits *next to* the existing Claude Agent SDK agents, not instead of them. The Mission Control dashboard already has Inngest for durability, so Genkit's lack of durable execution is fine.
- **ADK** is the right tool for the heavy workflow agents *if and only if* the v2 roadmap commits to Gemini Enterprise listing or multi-agent autonomous coordination. Today neither is in scope (the existing agents are curated-tool functions, not autonomous loops), so the ADK port should stay deferred behind a concrete trigger: "we need to list on Gemini Enterprise" or "we need agent-to-agent delegation outside Inngest."
- **Do not** push Genkit through `@a2a-js/sdk` just to claim A2A compliance — the glue cost exceeds the ADK port cost for any non-trivial agent.

---

## 9. Worked end-to-end example: `/api/agent/source` on Firebase App Hosting

Goal: a Next.js 16 App Router route that takes a brand brief, generates TikTok search queries with Gemini 2.5 Pro, calls a mock `tiktok.search` tool, and returns ranked creators as structured output. Deployable to Firebase App Hosting unchanged.

**Files:**

- `src/genkit/index.ts` — shared `ai` instance.
- `src/genkit/tools/tiktokSearch.ts` — mock `tiktok.search` tool.
- `src/genkit/flows/sourceCreators.ts` — the flow.
- `src/app/api/agent/source/route.ts` — the App Router endpoint.

### 9.1 `src/genkit/index.ts`

```typescript
import { googleAI, vertexAI } from '@genkit-ai/google-genai';
import { genkit } from 'genkit';

const useVertex = process.env.GENKIT_PROVIDER === 'vertex';

export const ai = genkit({
  plugins: useVertex
    ? [vertexAI({ location: process.env.VERTEX_LOCATION ?? 'us-central1' })]
    : [googleAI()],
});

export const proModel   = useVertex
  ? vertexAI.model('gemini-2.5-pro')
  : googleAI.model('gemini-2.5-pro');
export const flashModel = useVertex
  ? vertexAI.model('gemini-2.5-flash')
  : googleAI.model('gemini-2.5-flash');
```

### 9.2 `src/genkit/tools/tiktokSearch.ts`

```typescript
import { z } from 'genkit';
import { ai } from '../index';

const CreatorSchema = z.object({
  handle:      z.string(),
  followers:   z.number(),
  niche:       z.string(),
  engagement:  z.number().describe('Engagement rate 0..1'),
  region:      z.string(),
});

export const tiktokSearch = ai.defineTool(
  {
    name: 'tiktokSearch',
    description:
      'Searches TikTok for creators matching the given query. Returns up to 20 candidates.',
    inputSchema:  z.object({
      query:  z.string(),
      region: z.string().optional().describe('ISO-3166-1 alpha-2'),
      limit:  z.number().int().min(1).max(20).default(10),
    }),
    outputSchema: z.object({
      results: z.array(CreatorSchema),
    }),
  },
  async ({ query, region, limit }) => {
    // Mock — in real v2 this hits the existing tiktok-search-users :8084 service
    // through packages/capabilities, never directly.
    const mock = [
      { handle: '@athleisure_amy',  followers: 1_200_000, niche: 'athleisure',   engagement: 0.064, region: region ?? 'US' },
      { handle: '@runwithlena',     followers:   480_000, niche: 'running',      engagement: 0.082, region: region ?? 'US' },
      { handle: '@fitstylekris',    followers:   220_000, niche: 'gym fashion',  engagement: 0.091, region: region ?? 'US' },
      { handle: '@morningmovement', followers:    95_000, niche: 'yoga',         engagement: 0.117, region: region ?? 'US' },
    ];
    return { results: mock.slice(0, limit).filter(c => c.niche.includes(query.toLowerCase()) || true) };
  },
);
```

### 9.3 `src/genkit/flows/sourceCreators.ts`

```typescript
import { z } from 'genkit';
import { ai, proModel } from '../index';
import { tiktokSearch } from '../tools/tiktokSearch';

const BriefSchema = z.object({
  brand:       z.string(),
  product:     z.string(),
  audience:    z.string().describe('e.g. "US women 25-34 into wellness"'),
  budgetUsd:   z.number().int().positive().optional(),
  goalKpi:     z.enum(['awareness', 'conversion', 'engagement']).default('engagement'),
});

const RankedCreatorSchema = z.object({
  handle:    z.string(),
  followers: z.number(),
  niche:     z.string(),
  fitScore:  z.number().min(0).max(1).describe('Model-judged brand fit'),
  reason:    z.string().describe('One sentence rationale'),
});

const OutputSchema = z.object({
  queriesTried: z.array(z.string()),
  creators:     z.array(RankedCreatorSchema),
});

export const sourceCreatorsFlow = ai.defineFlow(
  {
    name: 'sourceCreators',
    inputSchema:  BriefSchema,
    outputSchema: OutputSchema,
  },
  async (brief) => {
    // Step 1 — let Gemini propose search queries + let it call the tool itself.
    const { output } = await ai.generate({
      model:  proModel,
      tools:  [tiktokSearch],
      output: { schema: OutputSchema },
      prompt: [
        `You are a TikTok influencer-sourcing agent for the brand "${brief.brand}".`,
        `Product: ${brief.product}`,
        `Target audience: ${brief.audience}`,
        `Campaign goal: ${brief.goalKpi}${brief.budgetUsd ? `, budget $${brief.budgetUsd}` : ''}.`,
        ``,
        `Plan: invent 2-4 distinct TikTok search queries that would surface relevant creators,`,
        `call the tiktokSearch tool for each, then merge + dedupe the results.`,
        `For each surviving creator, assign a fitScore in [0,1] and a one-sentence reason.`,
        `Return ALL queries you tried in queriesTried, and the ranked creator list in creators,`,
        `sorted by fitScore descending. Cap creators at 10.`,
      ].join('\n'),
    });

    if (!output) throw new Error('sourceCreators: model returned empty output');

    // Step 2 — defensive cap + sort. Belt-and-suspenders for the schema.
    output.creators = output.creators
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 10);

    return output;
  },
);
```

### 9.4 `src/app/api/agent/source/route.ts`

```typescript
import { sourceCreatorsFlow } from '@/genkit/flows/sourceCreators';
import { appRoute } from '@genkit-ai/next';

export const POST = appRoute(sourceCreatorsFlow);
// `appRoute` handles Zod validation, JSON parsing, error mapping, and streaming.
// The handler is end-to-end typed: `streamFlow<typeof sourceCreatorsFlow>(...)`
// in the client gets the same input/output types.
```

### 9.5 `apphosting.yaml` for this app

```yaml
runConfig:
  cpu: 1
  memoryMiB: 1024
  maxInstances: 20
  concurrency: 50            # lower than default because tool-calling flows hold connections

env:
  - variable: GENKIT_PROVIDER
    value: vertex
    availability: [RUNTIME]
  - variable: VERTEX_LOCATION
    value: us-central1
    availability: [RUNTIME]
  - variable: GEMINI_API_KEY                  # only used if you flip to googleAI
    secret: GEMINI_API_KEY
```

Deploy:

```bash
firebase apphosting:secrets:set GEMINI_API_KEY    # one-time
git push origin main                              # triggers deploy
```

Invoke it from the Mission Control UI:

```typescript
'use client';
import { runFlow } from '@genkit-ai/next/client';
import type { sourceCreatorsFlow } from '@/genkit/flows/sourceCreators';

export async function source(brief: {
  brand: string; product: string; audience: string; goalKpi: 'awareness'|'conversion'|'engagement';
}) {
  return runFlow<typeof sourceCreatorsFlow>({
    url:   '/api/agent/source',
    input: { ...brief, goalKpi: brief.goalKpi },
  });
}
```

That's roughly 150 lines of TypeScript, ships as one Firebase App Hosting deploy, gets end-to-end types from the Zod schemas all the way to the client, and trades the v1-style hand-rolled fetch+JSON shape for a single typed call.

### 9.6 Notes on wiring into v2 specifically

- **Don't** call `tiktok-search-users:8084` directly from inside the tool — that violates v2's "capabilities are the only place HTTP+agents touch I/O" rule. The tool body should call into `packages/capabilities/tiktok/search.ts` instead.
- **Don't** put this flow inside an Inngest step. Inngest steps must be idempotent and ≤a few seconds; tool-calling flows can run 30s+. If you need durability, wrap the *result* of the flow in an Inngest step, not the flow itself.
- **Do** add a golden-set eval before relying on this in production, per v2's convention (`pnpm --filter @ss/agents test` is the right home for it).
- **Do** budget USD per invocation through `ai.generate({ config: { maxOutputTokens } })` and a per-flow USD cap recorded into `packages/observability`. Genkit's traces carry token counts; ship them into the v2 cost ledger.

---

## 10. Sources

- [Firebase Genkit product page](https://firebase.google.com/products/genkit)
- [Genkit get-started (TS)](https://genkit.dev/docs/get-started/)
- [Genkit Next.js integration](https://genkit.dev/docs/nextjs/)
- [Genkit Google GenAI plugin (googleAI + vertexAI)](https://genkit.dev/docs/js/integrations/google-genai/)
- [Genkit Vertex AI integration](https://genkit.dev/docs/integrations/vertex-ai/)
- [Genkit Cloud Firestore Vector Search](https://genkit.dev/docs/js/integrations/cloud-firestore/)
- [Genkit RAG guide](https://genkit.dev/docs/rag/)
- [Genkit Dotprompt](https://genkit.dev/docs/dotprompt/)
- [Genkit tool calling](https://genkit.dev/docs/tool-calling/)
- [Genkit Firebase deployment](https://genkit.dev/docs/js/deployment/firebase/)
- [Genkit Cloud Run deployment](https://genkit.dev/docs/cloud-run/)
- [Cloud Functions onCallGenkit](https://firebase.google.com/docs/functions/oncallgenkit)
- [Firebase App Hosting GA announcement](https://firebase.blog/posts/2025/04/apphosting-general-availability/)
- [Firebase App Hosting configure](https://firebase.google.com/docs/app-hosting/configure)
- [Vertex AI Gemini 2.5 GA blog post](https://cloud.google.com/blog/products/ai-machine-learning/gemini-2-5-flash-lite-flash-pro-ga-vertex-ai)
- [Vertex AI model versions and lifecycle](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions)
- [A2A Protocol homepage](https://a2a-protocol.org/latest/)
- [A2A JS SDK](https://github.com/a2aproject/a2a-js)
- [A2A samples (Genkit examples)](https://github.com/a2aproject/a2a-samples)
- [ADK A2A exposing guide](https://google.github.io/adk-docs/a2a/quickstart-exposing/)
- [ADK 1.0 + A2A 2026 standard](https://explore.n1n.ai/blog/google-adk-1-0-a2a-protocol-multi-agent-standard-2026-05-04)
- [Genkit vs ADK comparison (Koborinai)](https://koborin.ai/tech/genkit-vs-adk/)
- [Top JS/TS GenAI frameworks 2026 (Xavier Portilla Edo)](https://xavidop.me/genkit/2026-04-16-top-jsts-genai-frameworks-2026/)

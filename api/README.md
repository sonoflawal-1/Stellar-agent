# Bear Protocol API Collections

This directory contains API collections and documentation for the Bear Protocol agent services.

## Contents

- **openapi.json** — OpenAPI 3.0 specification (use with Swagger UI, Redoc, code generators)
- **postman_collection.json** — Postman collection with pre-configured requests for all API endpoints
- **../docs/api.md** — Complete API documentation with examples and guides

## Quick Start

### OpenAPI/Swagger

Use with popular tools:

- **Swagger UI** — Paste `openapi.json` into https://editor.swagger.io
- **Redoc** — View at https://redocly.github.io/redoc/?url=<file-url>
- **Code Generators** — Generate SDKs with https://openapi-generator.tech

### Postman

1. Download and install [Postman](https://www.postman.com/downloads/)
2. Import `postman_collection.json`:
   - Click **Import** → Select `postman_collection.json`
   - Or drag-and-drop the file into Postman
3. Update environment variables (optional):
   - Default URLs point to localhost ports 4500-4504
   - Modify `registry_url`, `webbuilder_url`, etc. if running on different ports
4. Start testing:
   - Expand folders for each service (Registry, Web Builder, etc.)
   - Click any request and press **Send**

### cURL

```bash
# List all agents
curl http://localhost:4500/agents

# Get agent health
curl http://localhost:4501/health

# Submit a job
curl -X POST http://localhost:4501/job \
  -H "Content-Type: application/json" \
  -d '{"jobId": "1", "task": "Build a landing page"}'
```

### JavaScript/Node.js

```typescript
import fetch from "node-fetch";

// List agents
const agents = await fetch("http://localhost:4500/agents").then((r) => r.json());
console.log(agents);

// Submit a job
await fetch("http://localhost:4501/job", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jobId: "1", task: "Build a landing page" }),
});
```

## API Services

| Service        | Port | Purpose                             |
| -------------- | ---- | ----------------------------------- |
| Agent Registry | 4500 | Service discovery, agent lifecycle  |
| Web Builder    | 4501 | Builds responsive HTML/CSS websites |
| Copywriter     | 4502 | Writes marketing and product copy   |
| Namer          | 4503 | Generates creative name suggestions |
| Researcher     | 4504 | Conducts research with sources      |

## Documentation

Full API documentation with all endpoints, request/response formats, and examples: **[../docs/api.md](../docs/api.md)**

## Environment Setup

Ensure the following services are running:

```bash
# Terminal 1: Start all seller agents
./start-agents.sh

# Terminal 2 (optional): Start the agent registry
cd agents/registry && npm start

# Terminal 3: Use Postman or make requests to localhost:4500-4504
```

## Variables (Postman)

Pre-configured environment variables are included in the collection. Update if needed:

- `registry_url` — `http://localhost:4500`
- `webbuilder_url` — `http://localhost:4501`
- `copywriter_url` — `http://localhost:4502`
- `namer_url` — `http://localhost:4503`
- `researcher_url` — `http://localhost:4504`

## Support

- **API Reference**: See [../docs/api.md](../docs/api.md)
- **Protocol Guide**: See [../BEAR-PROTOCOL-GUIDE.md](../BEAR-PROTOCOL-GUIDE.md)
- **SDK Reference**: See [../sdk/README.md](../sdk/README.md)

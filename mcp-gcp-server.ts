import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

// Tool-määritykset — puhtaasti datana, ei SDK:n McpServer-rekisteröintinä
const TOOLS = [
  {
    name: "get_project_status",
    description: "Returns current GCP project status",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "GCP project ID" },
      },
      required: ["projectId"],
    },
  },
];

// Tool-toteutukset — erotettu määrityksistä
const toolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  get_project_status: async (args) => {
    const { projectId } = args as { projectId: string };
    return { status: "active", projectId };
  },
};

// Health check -muuttujat — määriteltävä ENNEN POST-handleria
type HealthState = "starting" | "ok" | "degraded";

let lastSuccessfulRequest: Date | null = null;
const serverStartTime: Date = new Date();
const HEALTH_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
const STARTUP_GRACE_MS = 30 * 1000; // 30s käynnistysaika

const DEPLOYED_SHA = process.env.DEPLOY_SHA ?? "unknown";
const CLOUD_RUN_REVISION = process.env.K_REVISION ?? "unknown";

// JSON-RPC dispatcher — notification-erottelu ja id-validointi
async function dispatchRPC(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
  const msg = message as any;
  const isNotification = msg.method?.startsWith("notifications/");

  // Notification: ei id:tä, ei vastausta (fire-and-forget)
  if (isNotification) return null;

  // Non-notification ilman id:tä on malformed request (JSON-RPC 2.0 §4)
  if (msg.id === undefined) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request: id is required for non-notification messages",
      },
    } as any;
  }

  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-gcp-server", version: "1.0.0" },
      },
    } as any;
  }

  if (msg.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS },
    } as any;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params as {
      name: string;
      arguments: unknown;
    };
    const handler = toolHandlers[name];
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Tool not found: ${name}` },
      } as any;
    }
    try {
      const result = await handler(args);
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      } as any;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: errorMsg },
      } as any;
    }
  }

  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  } as any;
}

// POST handler — transport hoitaa framing/streaming, dispatcher JSON-RPC-logiikan
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // tilaton — ei session affinityä tarvita
  });

  transport.onmessage = async (message) => {
    try {
      const response = await dispatchRPC(message);
      if (response) {
        await transport.send(response);
      }
    } catch (err) {
      process.stderr.write(`Error in dispatchRPC: ${err}\n`);
    }
  };

  try {
    await transport.handleRequest(req, res, req.body);
    lastSuccessfulRequest = new Date();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// OPTIONS preflight — varautuminen tulevaan suoraan remote-yhteyteen
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "";
if (!ALLOWED_ORIGIN) {
  process.stderr.write(
    JSON.stringify({ severity: "CRITICAL", message: "ALLOWED_ORIGIN env var not set" }) + "\n"
  );
  process.exit(1);
}

app.options("/mcp", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.status(204).send();
});

app.use("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed" });
});

// Health check — kolme tilaa (starting | ok | degraded)
app.get("/healthz", (_req, res) => {
  const now = Date.now();
  const inGrace = now - serverStartTime.getTime() < STARTUP_GRACE_MS;

  let state: HealthState;
  if (lastSuccessfulRequest === null) {
    state = inGrace ? "starting" : "degraded";
  } else {
    const stale = now - lastSuccessfulRequest.getTime() > HEALTH_STALE_THRESHOLD_MS;
    state = stale ? "degraded" : "ok";
  }

  const statusCode = state === "degraded" ? 503 : 200;
  res.status(statusCode).json({
    status: state,
    uptime: process.uptime(),
    last_request: lastSuccessfulRequest?.toISOString() ?? "none",
    deploy_sha: DEPLOYED_SHA,
    revision: CLOUD_RUN_REVISION,
  });
});

// Strukturoitu virheenkäsittely
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  process.stderr.write(JSON.stringify({
    severity: "ERROR",
    message: err.message,
    path: req.path,
    timestamp: new Date().toISOString(),
  }) + "\n");
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  process.stdout.write(`Server listening on port ${PORT}\n`);
});

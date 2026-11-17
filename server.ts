import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./server/apiHandler.js";
import { createFsStorage } from "./server/fsStorage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

const storage = createFsStorage(path.resolve(process.cwd(), ".studio-data"));

function toWebHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

async function createApp() {
  const app = express();

  // Route every /api/* call through the shared Web Fetch handler so local dev
  // behaves identically to the Cloudflare Workers Free deployment.
  app.use("/api", async (req: Request, res: Response) => {
    try {
      const protocol = req.protocol || "http";
      const host = req.headers.host || `localhost:${PORT}`;
      const fullUrl = `${protocol}://${host}${req.originalUrl}`;
      const method = req.method.toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";

      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers: toWebHeaders(req),
      };

      if (hasBody) {
        init.body = Readable.toWeb(req) as unknown as BodyInit;
        init.duplex = "half";
      }

      const webRequest = new globalThis.Request(fullUrl, init);
      const webResponse = await handleApiRequest(webRequest, {
        storage,
        geminiApiKey: process.env.GEMINI_API_KEY,
        modelEnv: {
          GEMINI_ANALYSIS_MODEL: process.env.GEMINI_ANALYSIS_MODEL,
          GEMINI_ANALYSIS_FALLBACK_MODEL:
            process.env.GEMINI_ANALYSIS_FALLBACK_MODEL,
          GEMINI_IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL,
          GEMINI_VIDEO_MODEL: process.env.GEMINI_VIDEO_MODEL,
          GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL,
          GEMINI_TTS_FALLBACK_MODEL: process.env.GEMINI_TTS_FALLBACK_MODEL,
        },
        runtime: "node-express",
      });

      if (!webResponse) {
        res.status(404).json({ error: "API endpoint not found." });
        return;
      }

      res.status(webResponse.status);
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!webResponse.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(
        webResponse.body as Parameters<typeof Readable.fromWeb>[0]
      );
      await pipeline(nodeStream, res);
    } catch (err: unknown) {
      // Ignore client disconnects during video range streaming
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        return;
      }
      console.error("Express API bridge error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : "Internal server error.",
        });
      }
    }
  });

  if (isProduction) {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Product Studio AI listening on http://0.0.0.0:${PORT}`);
  });
}

createApp().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

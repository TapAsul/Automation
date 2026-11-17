import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  KLIPCART_CONTAINER: DurableObjectNamespace<KlipCartContainer>;
  GEMINI_API_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

/**
 * Runs the existing Express application in a Cloudflare Container. This keeps
 * the React UI and all /api routes on the same origin while preserving the
 * Node.js APIs used by the app.
 */
export class KlipCartContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: any, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: "3000",
      HOME: "/app",
      GEMINI_API_KEY: env.GEMINI_API_KEY || "",
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID || "",
      R2_BUCKET_NAME: env.R2_BUCKET_NAME || "",
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || "",
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || "",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.KLIPCART_CONTAINER);
    return container.fetch(request);
  },
};

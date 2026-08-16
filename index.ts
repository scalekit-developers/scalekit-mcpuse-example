import { MCPServer } from "mcp-use";
import { oauthScalekitProvider } from "mcp-use/oauth/scalekit";
import { z } from "zod";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new TypeError(
      `${name} is missing. Copy .env.example to .env and fill in values from your Scalekit dashboard.`,
    );
  }
  return value;
}

const server = new MCPServer({
  name: "scalekit-mcpuse-example",
  title: "Scalekit + mcp-use",
  version: "1.0.0",
  description: "MCP server authenticated with Scalekit OAuth 2.1",
  instructions: "Call whoami to inspect the signed-in Scalekit user.",
  websiteUrl: "https://docs.scalekit.com/authenticate/mcp/quickstart/",
  oauth: oauthScalekitProvider({
    environmentUrl: requiredEnv("SCALEKIT_ENVIRONMENT_URL"),
    resourceId: requiredEnv("SCALEKIT_RESOURCE_ID"),
    resource: requiredEnv("MCP_URL"),
  }),
  publicLandingPage: true,
});

const whoamiOutputSchema = z.object({
  user: z.object({
    id: z.string().describe("Token sub — usr_… for a person, m2m_… for a machine client"),
    subjectType: z.enum(["user", "machine"]),
    organizationId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  scopes: z.array(z.string()),
  permissions: z.array(z.string()),
  clientId: z.string().optional(),
  expiresAt: z.number().describe("Token exp as a Unix timestamp"),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  resource: z.unknown().optional(),
});

export const whoami = server.tool(
  {
    name: "whoami",
    title: "Who am I",
    description: "Return the authenticated Scalekit identity for this request",
    outputSchema: whoamiOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (_args, ctx) => {
    const payload = ctx.auth.payload;
    const data = {
      user: ctx.auth.user,
      scopes: ctx.auth.scopes,
      permissions: ctx.auth.permissions,
      clientId: ctx.auth.clientId,
      expiresAt: ctx.auth.expiresAt,
      iss: typeof payload.iss === "string" ? payload.iss : undefined,
      aud: payload.aud as string | string[] | undefined,
      resource: payload.resource,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  },
);

export const greet = server.tool(
  {
    name: "greet",
    title: "Greet me",
    description: "Greet the signed-in Scalekit user by their subject id",
    outputSchema: z.object({
      greeting: z.string(),
      userId: z.string(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async (_args, ctx) => {
    const userId = ctx.auth.user.id;
    const data = {
      greeting: `Hello, ${userId}`,
      userId,
    };
    return {
      content: [{ type: "text", text: data.greeting }],
      structuredContent: data,
    };
  },
);

export default server;

/**
 * Scalekit OAuth provider for mcp-use.
 *
 * Same shape as first-class adapters (Clerk / Auth0): oauthCustomProvider +
 * jose JWT/JWKS + a typed user map. No @scalekit-sdk/node, no client secret.
 *
 * createJwtVerifier is @internal in mcp-use 2.1.0, so this file verifies with
 * jose and returns the AuthInfo shape wrapOAuthTokenVerifier asserts.
 */
import {
  oauthCustomProvider,
  type OAuthProvider,
  type OAuthResourceOptions,
} from "mcp-use/oauth";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

/** Verified Scalekit subject on ctx.auth.user. */
export interface ScalekitOAuthUser {
  /** Token `sub`. A person under authorization_code; the client under client_credentials. */
  id: string;
  /** So tools do not treat a machine client as a person. */
  subjectType: "user" | "machine";
  organizationId?: string;
  sessionId?: string;
}

export interface ScalekitOAuthProviderOptions extends OAuthResourceOptions {
  /** Scalekit environment URL from the dashboard. */
  environmentUrl: URL | string;
  /** MCP resource id (`res_…`). Default JWT audience and the per-server binding. */
  resourceId: string;
  /**
   * Override expected JWT audience. Default is `resourceId`.
   * Use only if your tokens carry a URL audience and not `res_…`.
   */
  audience?: string;
}

/**
 * Paths taken from live Scalekit AS metadata:
 *
 *   GET {env}/resources/{res}/.well-known/oauth-authorization-server
 *
 *   issuer                {env}/resources/{res}
 *   jwks_uri              {env}/keys
 *   registration_endpoint {env}/api/v1/resources/{res}/clients:register
 *
 * Do not invent jwks_uri. `{env}/resources/{res}/keys` is a 404.
 */
export function oauthScalekitProvider(
  options: ScalekitOAuthProviderOptions,
): OAuthProvider<ScalekitOAuthUser> {
  const environmentUrl = normalizeEnvironmentUrl(options.environmentUrl);
  const resourceId = normalizeResourceId(options.resourceId);
  const resourceIssuer = `${environmentUrl}/resources/${resourceId}`;
  const audience = normalizeAudience(options.audience, resourceId);
  const jwksUrl = new URL(`${environmentUrl}/keys`);
  const jwks = createRemoteJWKSet(jwksUrl);

  return oauthCustomProvider({
    ...options,
    createTokenVerifier: (resource) => ({
      async verifyAccessToken(token) {
        try {
          const { payload } = await jwtVerify(token, jwks, {
            // Accept both while Scalekit migrates iss from env-root to resource-scoped.
            // oauthMetadata.issuer stays resource-scoped; only the verifier is tolerant.
            issuer: [environmentUrl, resourceIssuer],
            audience,
            requiredClaims: ["exp", "sub"],
          });

          const claims = { ...payload } as Record<string, unknown>;
          assertResourceClaim(claims, resource);
          const sub = requiredString(claims, "sub");
          if (sub === undefined) {
            throw invalidToken("Missing sub claim");
          }
          const expiresAt = requiredFutureNumber(claims, "exp");
          const clientId =
            requiredString(claims, "client_id") ??
            requiredString(claims, "azp") ??
            "";

          return {
            token,
            clientId,
            scopes: normalizedStrings(claims.scope),
            expiresAt,
            extra: { payload: claims },
            resource,
          };
        } catch (error) {
          if (error instanceof OAuthError) throw error;
          if (process.env.MCP_USE_OAUTH_DEBUG) {
            logJwtFailure(token, error);
          }
          throw invalidToken("JWT verification failed", error);
        }
      },
    }),
    oauthMetadata: {
      issuer: resourceIssuer,
      authorization_endpoint: `${resourceIssuer}/oauth/authorize`,
      token_endpoint: `${resourceIssuer}/oauth/token`,
      jwks_uri: jwksUrl.href,
      registration_endpoint: `${environmentUrl}/api/v1/resources/${resourceId}/clients:register`,
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      client_id_metadata_document_supported: true,
    } as Parameters<typeof oauthCustomProvider>[0]["oauthMetadata"] & {
      client_id_metadata_document_supported: true;
    },
    mapAuthInfo: (authInfo) => {
      const payload = isRecord(authInfo.extra?.payload)
        ? authInfo.extra.payload
        : undefined;
      if (payload === undefined) {
        throw invalidToken("Verified token payload is missing");
      }
      const id = requiredString(payload, "sub");
      if (id === undefined) {
        throw invalidToken("Missing Scalekit sub claim");
      }
      const clientId =
        requiredString(payload, "client_id") ?? requiredString(payload, "azp");
      return {
        user: {
          id,
          subjectType:
            clientId !== undefined && id === clientId ? "machine" : "user",
          organizationId: requiredString(payload, "org_id"),
          sessionId: requiredString(payload, "sid"),
        },
        payload,
        permissions: normalizedStrings(payload.permissions),
      };
    },
  });
}

function normalizeEnvironmentUrl(value: URL | string): string {
  let url: URL;
  try {
    const raw =
      typeof value === "string" && !value.includes("://")
        ? `https://${value}`
        : value;
    url = new URL(raw);
  } catch {
    throw new TypeError(
      `environmentUrl is invalid (${String(value)}). Copy the Environment URL from the Scalekit dashboard.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(
      `environmentUrl must be an HTTP(S) URL (${url.href}).`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      `environmentUrl must not include credentials, query, or fragment (${url.href}).`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

function normalizeResourceId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(
      "resourceId is required. Copy the res_… id from Scalekit → MCP servers. It is the JWT audience.",
    );
  }
  const resourceId = value.trim();
  if (!resourceId.startsWith("res_")) {
    throw new TypeError(
      `resourceId must start with "res_" (${resourceId}). A wrong value weakens audience binding.`,
    );
  }
  return resourceId;
}

function normalizeAudience(
  override: string | undefined,
  resourceId: string,
): string {
  if (override === undefined) return resourceId;
  if (typeof override !== "string" || override.trim().length === 0) {
    throw new TypeError("audience override must be a non-empty string");
  }
  return override.trim();
}

function assertResourceClaim(
  claims: Record<string, unknown>,
  configuredResource: URL,
): void {
  const value = claims.resource;
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw invalidToken("Token resource claim must be an absolute URL");
  }
  let claimed: URL;
  try {
    claimed = new URL(value);
  } catch {
    throw invalidToken("Token resource claim must be an absolute URL");
  }
  const configured = configuredResource.href.replace(/\/+$/, "");
  const actual = claimed.href.replace(/\/+$/, "");
  if (actual !== configured) {
    throw invalidToken("Token resource claim does not match protected resource");
  }
}

function requiredString(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function requiredFutureNumber(
  claims: Record<string, unknown>,
  name: string,
): number {
  const value = claims[name];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= Date.now() / 1000
  ) {
    throw invalidToken(`Missing or expired ${name} claim`);
  }
  return value;
}

function normalizedStrings(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidToken(message: string, cause?: unknown): OAuthError {
  const error = new OAuthError(OAuthErrorCode.InvalidToken, message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function logJwtFailure(token: string, error: unknown): void {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[oauth-debug] JWT verify failed: ${name}: ${message}`);
  if (error instanceof errors.JWTClaimValidationFailed) {
    console.error(`[oauth-debug] claim=${error.claim} reason=${error.reason}`);
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    console.error(`[oauth-debug] non-JWT token length=${token.length}`);
    return;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const selected: Record<string, unknown> = {
      now: Math.floor(Date.now() / 1000),
    };
    for (const claim of [
      "iss",
      "aud",
      "azp",
      "sub",
      "exp",
      "client_id",
      "scope",
      "resource",
      "typ",
      "jti",
    ]) {
      if (claim in payload) selected[claim] = payload[claim];
    }
    console.error(`[oauth-debug] payload=${JSON.stringify(selected)}`);
  } catch {
    console.error("[oauth-debug] payload decode failed");
  }
}

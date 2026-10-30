import "server-only";

import { createHash, createHmac } from "node:crypto";

/**
 * Private object storage for training recordings (camera video with its
 * audio), over the S3 API - which AWS S3, Cloudflare R2 and Supabase Storage
 * (its S3-compatible endpoint) all speak. Configured only by server env vars;
 * see docs/VIDEO_INTERVIEW_SETUP.md.
 *
 * What it never does: make an object public, return a permanent URL, or send
 * a credential to the browser. The browser gets ONE short-lived presigned PUT
 * URL per upload, signed for one random key, one content type and one exact
 * byte length. Everything else - checking, reading the first bytes, deleting -
 * is done here, on the server, with its own short-lived signatures.
 *
 * Signing is AWS Signature Version 4 (query-string auth), implemented here
 * rather than by pulling in the AWS SDK for four requests. It is checked
 * against AWS's published test vector in the tests.
 */

export interface PrivateObjectStorage {
  readonly provider: string;
  /** A presigned PUT the browser uses once. */
  createUpload(input: { key: string; contentType: string; contentLength: number; expiresSec: number }): Promise<{
    url: string;
    method: "PUT";
    headers: Record<string, string>;
    expiresAt: string;
  }>;
  /** Size and type of a stored object, or null when there is none. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The object's first `bytes` bytes, or null when there is none. */
  readPrefix(key: string, bytes: number): Promise<Uint8Array | null>;
  /** Removes an object. A missing object is not an error. */
  delete(key: string): Promise<void>;
}

export type S3Config = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (endpoint/bucket/key): Supabase, R2, MinIO. Off = virtual-hosted (bucket.endpoint/key). */
  pathStyle: boolean;
};

class ObjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

/** The configuration from the environment, or null when it is not set up. */
export function objectStorageConfigFromEnv(env: Record<string, string | undefined> = process.env): S3Config | null {
  const endpoint = env.VIDEO_STORAGE_ENDPOINT?.trim();
  const region = env.VIDEO_STORAGE_REGION?.trim();
  const bucket = env.VIDEO_STORAGE_BUCKET?.trim();
  const accessKeyId = env.VIDEO_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.VIDEO_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  return { endpoint: url, region, bucket, accessKeyId, secretAccessKey, pathStyle: env.VIDEO_STORAGE_FORCE_PATH_STYLE?.trim() !== "false" };
}

// RFC 3986 encoding, as SigV4 requires: everything but A-Z a-z 0-9 - _ . ~
function uriEncode(s: string, keepSlash = false): string {
  return [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/**
 * A SigV4 presigned URL. Exported for the test vector. `headers` are signed
 * (always including host) and must be sent exactly by whoever uses the URL.
 */
export function presignUrl(input: {
  method: string;
  host: string;
  protocol: string;
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSec: number;
  now: Date;
  headers?: Record<string, string>;
}): string {
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = String(v).trim();
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const canonicalPath = uriEncode(input.path, true);
  const canonicalRequest = [input.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return `${input.protocol}//${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export class S3PrivateObjectStorage implements PrivateObjectStorage {
  readonly provider = "s3";
  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private location(key: string): { host: string; path: string } {
    if (!/^[A-Za-z0-9/_.-]{1,200}$/.test(key) || key.includes("..")) throw new ObjectStorageError("Invalid object key.");
    const base = this.config.endpoint.pathname.replace(/\/+$/, "");
    return this.config.pathStyle
      ? { host: this.config.endpoint.host, path: `${base}/${this.config.bucket}/${key}` }
      : { host: `${this.config.bucket}.${this.config.endpoint.host}`, path: `${base}/${key}` };
  }

  private sign(method: string, key: string, expiresSec: number, headers?: Record<string, string>): string {
    const { host, path } = this.location(key);
    return presignUrl({
      method,
      host,
      protocol: this.config.endpoint.protocol,
      path,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresSec,
      now: this.clock(),
      headers,
    });
  }

  async createUpload(input: { key: string; contentType: string; contentLength: number; expiresSec: number }) {
    const expiresSec = Math.max(30, Math.min(900, Math.round(input.expiresSec)));
    const url = this.sign("PUT", input.key, expiresSec, {
      "content-type": input.contentType,
      "content-length": String(input.contentLength),
    });
    return {
      url,
      method: "PUT" as const,
      // content-length is signed too; the browser sets it from the body, and
      // the store refuses a body of any other length.
      headers: { "Content-Type": input.contentType },
      expiresAt: new Date(this.clock().getTime() + expiresSec * 1000).toISOString(),
    };
  }

  private async call(method: string, key: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(this.sign(method, key, 60), { method, ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ObjectStorageError("Couldn't reach recording storage.");
    }
  }

  async head(key: string) {
    const res = await this.call("HEAD", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new ObjectStorageError(`Recording storage check failed (HTTP ${res.status}).`);
    const size = Number(res.headers.get("content-length"));
    return { size: Number.isFinite(size) ? size : -1, contentType: res.headers.get("content-type") };
  }

  async readPrefix(key: string, bytes: number) {
    const res = await this.call("GET", key, { headers: { Range: `bytes=0-${Math.max(0, bytes - 1)}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ObjectStorageError(`Recording storage read failed (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer()).slice(0, bytes);
  }

  async delete(key: string) {
    const res = await this.call("DELETE", key);
    if (!res.ok && res.status !== 404) throw new ObjectStorageError(`Recording storage delete failed (HTTP ${res.status}).`);
  }
}

let override: PrivateObjectStorage | null | undefined;

/** Tests swap the store in; production never calls this. */
export function setObjectStorageForTests(s: PrivateObjectStorage | null | undefined): void {
  override = s;
}

/** The configured private store, or null when none is set up. */
export function getObjectStorage(): PrivateObjectStorage | null {
  if (override !== undefined) return override;
  const config = objectStorageConfigFromEnv();
  return config ? new S3PrivateObjectStorage(config) : null;
}

export function isObjectStorageConfigured(): boolean {
  return getObjectStorage() !== null;
}

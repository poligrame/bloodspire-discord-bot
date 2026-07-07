const crypto = require("crypto");

/**
 * Appelle Claude (par defaut Sonnet 4.5) via AWS Bedrock Runtime (InvokeModel).
 *
 * Deux modes d'authentification, comme cote plugin Minecraft :
 *   1. Cle API Bedrock (RECOMMANDE, le plus simple) : un seul jeton "Bearer".
 *        -> AWS_BEARER_TOKEN_BEDROCK
 *   2. Cle d'acces IAM classique (SigV4) : access key + secret key.
 *        -> AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN optionnel)
 */

const REGION = (process.env.BEDROCK_REGION || "us-east-1").trim();
const MODEL_ID = (
  process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
).trim();
const BEARER = (process.env.AWS_BEARER_TOKEN_BEDROCK || "").trim();
const ACCESS = (process.env.AWS_ACCESS_KEY_ID || "").trim();
const SECRET = (process.env.AWS_SECRET_ACCESS_KEY || "").trim();
const SESSION = (process.env.AWS_SESSION_TOKEN || "").trim();

/** true si on a de quoi appeler Bedrock (cle API OU access+secret). */
function usable() {
  return !!BEARER || (!!ACCESS && !!SECRET);
}

/** Encodage de chemin facon botocore : tout sauf A-Za-z0-9 -_.~ et '/'. */
function encodePath(p) {
  let out = "";
  for (const ch of p) {
    if (/[A-Za-z0-9\-_.~/]/.test(ch)) out += ch;
    else out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function hmac(key, str) {
  return crypto.createHmac("sha256", key).update(str, "utf8").digest();
}
function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** En-tetes signes AWS SigV4 pour un POST sur bedrock-runtime. */
function sigv4Headers(method, host, canonicalPath, body, contentType) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // yyyymmddThhmmssZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const signed = {
    "content-type": contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (SESSION) signed["x-amz-security-token"] = SESSION;

  const keys = Object.keys(signed).sort();
  const canonicalHeaders = keys.map((k) => `${k}:${String(signed[k]).trim()}\n`).join("");
  const signedHeaders = keys.join(";");
  const canonicalRequest = [
    method,
    canonicalPath,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/bedrock/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const kDate = hmac("AWS4" + SECRET, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, "bedrock");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // La cle "host" n'est PAS renvoyee : fetch la pose automatiquement.
  const headers = {
    "Content-Type": contentType,
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
    Authorization: authorization,
  };
  if (SESSION) headers["X-Amz-Security-Token"] = SESSION;
  return headers;
}

/**
 * Envoie une conversation a Claude et renvoie le texte de sa reponse.
 * @param {string} system  prompt systeme (role de l'assistant)
 * @param {Array<{role:string, content:string}>} messages  historique (alterne user/assistant, commence par user)
 * @returns {Promise<string>}
 */
async function askClaude(system, messages) {
  if (!usable()) throw new Error("Bedrock non configure (aucune cle AWS).");

  const host = `bedrock-runtime.${REGION}.amazonaws.com`;
  const path = "/model/" + encodePath(MODEL_ID) + "/invoke";
  const url = `https://${host}${path}`;

  const body = Buffer.from(
    JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 700,
      temperature: 0.3,
      system,
      messages,
    }),
    "utf8"
  );

  let headers;
  if (BEARER) {
    headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${BEARER}`,
    };
  } else {
    headers = sigv4Headers("POST", host, path, body, "application/json");
    headers.Accept = "application/json";
  }

  const resp = await fetch(url, { method: "POST", headers, body });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Bedrock HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }
  const json = await resp.json();
  return (json.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

module.exports = { askClaude, usable, MODEL_ID, REGION };

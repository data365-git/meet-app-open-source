// Mint a NextAuth v4 session cookie (JWE: dir / A256GCM) using ONLY node crypto,
// run INSIDE the app container so NEXTAUTH_SECRET never leaves the server.
// Usage: node mint-jwe.js '<json token claims>'
// Prints the cookie value for next-auth.session-token.
const crypto = require("crypto");

const secret = process.env.NEXTAUTH_SECRET;
if (!secret) { console.error("NO_SECRET"); process.exit(1); }

const claims = JSON.parse(process.argv[2] || "{}");
const now = Math.floor(Date.now() / 1000);
const payload = { ...claims, iat: now, exp: now + 30 * 24 * 3600, jti: crypto.randomUUID() };

// NextAuth v4 derives the key via HKDF-SHA256, salt="", info fixed string, 32 bytes.
const key = Buffer.from(
  crypto.hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0),
    Buffer.from("NextAuth.js Generated Encryption Key"), 32)
);

const b64u = (b) => Buffer.from(b).toString("base64url");
const header = { alg: "dir", enc: "A256GCM" };
const protectedB64 = b64u(JSON.stringify(header));
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
cipher.setAAD(Buffer.from(protectedB64, "ascii"));
const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();

const jwe = [protectedB64, "", iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
console.log(jwe);

// Tiny HTTPS server for the fake Meet page.
// meet.google.com is mapped to 127.0.0.1 via --host-resolver-rules (host-only map,
// port is preserved), so this must listen on 443. Windows has no <1024 bind
// restriction; if 443 is taken, pass an alternative port as argv[2] and use a
// MAP rule with EXCLUDE + proxy instead (fallback documented in run-proof.mjs).
// Cert: self-signed (gen-cert.sh) + --ignore-certificate-errors on the browser.
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 443);

const server = createServer(
	{
		key: readFileSync(join(here, "certs", "key.pem")),
		cert: readFileSync(join(here, "certs", "cert.pem")),
	},
	(req, res) => {
		// Any path (e.g. /abc-defg-hij like a real meeting URL) serves the tone page.
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(readFileSync(join(here, "fake-meet", "index.html")));
	},
);

server.listen(port, "127.0.0.1", () => {
	console.log(`[fake-meet] https://127.0.0.1:${port} (map meet.google.com here)`);
});

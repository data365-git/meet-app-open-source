/**
 * Meet meeting-id parsing — ONE home (popup + sw command handler both use it;
 * a copy-pasted twin here is exactly the drift the recorder audit warned about).
 */
export function getMeetingId(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.endsWith("meet.google.com")) return null;
		const match = /^\/([a-z]+-[a-z]+-[a-z]+)$/i.exec(parsed.pathname);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

import "server-only";

import { getCurrentUser } from "@cap/database/auth/session";

export async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || !user.isAdmin) {
		throw new Error("Unauthorized");
	}
	return user;
}

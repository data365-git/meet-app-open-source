// ── Audio/video input device picker ──────────────────────────────────────
//
// Shared by popup.ts (settings panel) and recorder-page.ts (meeting-flow mic
// control, added so the popup's affordances still exist when the popup itself
// is skipped for the one-click meeting auto-start — see recorder-page.ts). One
// copy so a future permission/enumeration fix can't land in one surface and be
// forgotten in the other.

async function checkPermission(name: PermissionName): Promise<PermissionState> {
	try {
		const status = await navigator.permissions.query({ name });
		return status.state;
	} catch {
		return "prompt";
	}
}

export async function populateDeviceSelect(
	select: HTMLSelectElement,
	kind: "audioinput" | "videoinput",
	currentDeviceId: string,
	permissionConstraint: MediaStreamConstraints,
): Promise<"granted" | "blocked"> {
	const permName = (
		kind === "audioinput" ? "microphone" : "camera"
	) as PermissionName;
	let permState = await checkPermission(permName);

	if (permState !== "granted") {
		try {
			const testStream =
				await navigator.mediaDevices.getUserMedia(permissionConstraint);
			for (const t of testStream.getTracks()) t.stop();
			permState = "granted";
		} catch {
			return "blocked";
		}
	}

	const devices = await navigator.mediaDevices.enumerateDevices();
	const filtered = devices.filter((d) => d.kind === kind);

	const defaultOpt = document.createElement("option");
	defaultOpt.value = "";
	defaultOpt.textContent =
		kind === "audioinput" ? "Default microphone" : "Default camera";
	select.appendChild(defaultOpt);

	for (const device of filtered) {
		const label =
			device.label ||
			`${kind === "audioinput" ? "Mic" : "Camera"} ${device.deviceId.slice(0, 6)}`;
		const opt = document.createElement("option");
		opt.value = device.deviceId;
		opt.textContent = label;
		if (device.deviceId === currentDeviceId) opt.selected = true;
		select.appendChild(opt);
	}

	if (!currentDeviceId) select.value = "";
	return "granted";
}

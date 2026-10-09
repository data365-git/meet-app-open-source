"use client";

import {
	faDesktop,
	faGlobe,
	faMobileScreen,
	faRecordVinyl,
} from "@fortawesome/free-solid-svg-icons";
import { useTranslations } from "next-intl";
import type { BreakdownRow } from "../types";
import OtherStatBox from "./OtherStatBox";
import TableCard, {
	type BrowserRowData,
	type CapRowData,
	type CityRowData,
	type CountryRowData,
	type DeviceRowData,
	type OSRowData,
} from "./TableCard";

export interface OtherStatsData {
	countries: BreakdownRow[];
	cities: BreakdownRow[];
	browsers: BreakdownRow[];
	operatingSystems: BreakdownRow[];
	deviceTypes: BreakdownRow[];
	topCaps?: Array<BreakdownRow & { id?: string }> | null;
}

interface OtherStatsProps {
	data: OtherStatsData;
	isLoading?: boolean;
}

const deviceMap: Record<string, DeviceRowData["device"]> = {
	desktop: "desktop",
	mobile: "mobile",
	tablet: "tablet",
};

const toCountryRow = (row: BreakdownRow): CountryRowData => ({
	countryCode: row.name,
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toCityRow = (row: BreakdownRow): CityRowData => ({
	countryCode: row.subtitle || "",
	name: row.subtitle ? `${row.name}, ${row.subtitle}` : row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toBrowserRow = (row: BreakdownRow): BrowserRowData => ({
	browser: browserNameToSlug(row.name),
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toOSRow = (row: BreakdownRow): OSRowData => ({
	os: osNameToKey(row.name),
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
});

const toCapRow = (row: BreakdownRow & { id?: string }): CapRowData => ({
	name: row.name,
	views: row.views,
	comments: null,
	reactions: null,
	percentage: row.percentage,
	id: row.id,
});

const browserNameToSlug = (name: string): BrowserRowData["browser"] => {
	switch (name.toLowerCase()) {
		case "chrome":
			return "google-chrome";
		case "firefox":
			return "firefox";
		case "safari":
			return "safari";
		case "edge":
		case "internet explorer":
			return "explorer";
		case "opera":
			return "opera";
		case "brave":
			return "brave";
		default:
			return "google-chrome";
	}
};

const osNameToKey = (name: string): OSRowData["os"] => {
	const normalized = name.toLowerCase().trim();
	if (normalized.includes("mac") || normalized === "ios") {
		return "ios";
	}
	switch (normalized) {
		case "linux":
			return "linux";
		case "ubuntu":
			return "ubuntu";
		case "fedora":
			return "fedora";
		default:
			return "windows";
	}
};

export default function OtherStats({ data, isLoading }: OtherStatsProps) {
	const t = useTranslations("analytics");
	return (
		<div className="grid grid-cols-1 gap-8 w-full xl:grid-cols-4">
			<OtherStatBox
				className="col-span-2"
				title={t("sections.geography")}
				icon={faGlobe}
			>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title={t("tables.countries")}
						columns={[
							t("columns.country"),
							t("columns.views"),
							t("columns.percentage"),
						]}
						rows={data.countries.map(toCountryRow)}
						type="country"
						isLoading={isLoading}
					/>
					<TableCard
						title={t("tables.cities")}
						columns={[
							t("columns.city"),
							t("columns.views"),
							t("columns.percentage"),
						]}
						rows={data.cities.map(toCityRow)}
						type="city"
						isLoading={isLoading}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox
				className="col-span-2"
				title={t("sections.software")}
				icon={faDesktop}
			>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title={t("tables.browsers")}
						columns={[
							t("columns.browser"),
							t("columns.views"),
							t("columns.percentage"),
						]}
						rows={data.browsers.map(toBrowserRow)}
						type="browser"
						isLoading={isLoading}
					/>
					<TableCard
						title={t("tables.operatingSystems")}
						columns={[
							t("columns.operatingSystem"),
							t("columns.views"),
							t("columns.percentage"),
						]}
						rows={data.operatingSystems.map(toOSRow)}
						type="os"
						isLoading={isLoading}
					/>
				</div>
			</OtherStatBox>
			<OtherStatBox
				className="col-span-2"
				title={t("sections.devices")}
				icon={faMobileScreen}
			>
				<div className="flex flex-col flex-1 gap-5 justify-center w-full">
					<TableCard
						title={t("tables.deviceType")}
						columns={[
							t("columns.device"),
							t("columns.views"),
							t("columns.percentage"),
						]}
						rows={data.deviceTypes.map((device) => ({
							device: deviceMap[device.name.toLowerCase()] ?? "desktop",
							name: device.name,
							views: device.views,
							comments: null,
							reactions: null,
							percentage: device.percentage,
						}))}
						type="device"
						isLoading={isLoading}
					/>
				</div>
			</OtherStatBox>
			{data.topCaps && data.topCaps.length > 0 && (
				<OtherStatBox
					className="col-span-2"
					title={t("sections.topCaps")}
					icon={faRecordVinyl}
				>
					<div className="flex flex-col flex-1 gap-5 justify-center w-full">
						<TableCard
							title={t("tables.caps")}
							columns={[
								t("columns.name"),
								t("columns.views"),
								t("columns.percentage"),
							]}
							rows={data.topCaps.map(toCapRow)}
							type="cap"
							isLoading={isLoading}
						/>
					</div>
				</OtherStatBox>
			)}
		</div>
	);
}

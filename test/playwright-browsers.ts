import type { Browser } from "playwright-core";
import { chromium, webkit } from "playwright-core";

/**
 * The one place the browser suites find Playwright's browsers (the ones `playwright-core install` puts under
 * PLAYWRIGHT_BROWSERS_PATH, or its default cache). CI sets OWNI_REQUIRE_BROWSERS=1: a browser that cannot start
 * then fails the run at import time instead of silently skipping its suites.
 */
const required = process.env.OWNI_REQUIRE_BROWSERS === "1";

async function probe(name: string, launch: () => Promise<Browser>): Promise<boolean> {
	try {
		await (await launch()).close();
		return true;
	} catch (error) {
		if (required) throw new Error(`OWNI_REQUIRE_BROWSERS=1 but ${name} does not start: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export const launchChromium = (): Promise<Browser> => chromium.launch({ chromiumSandbox: false });
export const launchWebkit = (): Promise<Browser> => webkit.launch();

export const chromiumAvailable = await probe("Chromium", launchChromium);
export const webkitAvailable = await probe("WebKit", launchWebkit);

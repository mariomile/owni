import type { Browser } from "playwright-core";
import { chromium, webkit } from "playwright-core";

/**
 * The one place the browser suites find Playwright's browsers (the ones `playwright-core install` puts under
 * PLAYWRIGHT_BROWSERS_PATH, or its default cache). A suite asks only for the browsers it uses, and each is
 * probed once, on first ask. CI sets OWNI_REQUIRE_BROWSERS=1: a browser that cannot start then fails the
 * suite at import time instead of silently skipping it.
 */
const required = process.env.OWNI_REQUIRE_BROWSERS === "1";

export const launchChromium = (): Promise<Browser> => chromium.launch({ chromiumSandbox: false });
export const launchWebkit = (): Promise<Browser> => webkit.launch();

const probes = new Map<string, Promise<boolean>>();

function probe(name: string, launch: () => Promise<Browser>): Promise<boolean> {
	let found = probes.get(name);
	if (found === undefined) {
		found = launch().then(
			async (browser) => {
				await browser.close();
				return true;
			},
			(error: unknown) => {
				if (required) throw new Error(`OWNI_REQUIRE_BROWSERS=1 but ${name} does not start: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			},
		);
		probes.set(name, found);
	}
	return found;
}

/** Whether Chromium starts here; throws instead of false when OWNI_REQUIRE_BROWSERS=1. */
export const chromiumAvailable = (): Promise<boolean> => probe("Chromium", launchChromium);
/** Whether WebKit starts here; throws instead of false when OWNI_REQUIRE_BROWSERS=1. */
export const webkitAvailable = (): Promise<boolean> => probe("WebKit", launchWebkit);

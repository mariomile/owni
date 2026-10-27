import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Browser } from "playwright-core";
import { chromium, webkit } from "playwright-core";

/**
 * The one place the browser suites find Playwright's browsers (the ones `playwright-core install` puts under
 * PLAYWRIGHT_BROWSERS_PATH, or its default cache). CI sets OWNI_REQUIRE_BROWSERS=1: a browser that is not
 * installed then fails the suite at import time instead of silently skipping it.
 */
const required = process.env.OWNI_REQUIRE_BROWSERS === "1";

export const launchChromium = (): Promise<Browser> => chromium.launch({ chromiumSandbox: false });
export const launchWebkit = (): Promise<Browser> => webkit.launch();

const found = (name: string, path: string): boolean => {
	const ok = existsSync(path);
	if (!ok && required) throw new Error(`OWNI_REQUIRE_BROWSERS=1 but ${name} is not installed at ${path}`);
	return ok;
};

// Headless Chromium runs Playwright's headless shell, not the full browser `chromium.executablePath()` names:
// the shell is the one that has to be there. Playwright's registry is where it says the shell lives.
const { registry } = createRequire(import.meta.url)("playwright-core/lib/server/registry/index") as {
	registry: { findExecutable(name: string): { executablePath(): string } };
};

/** Whether headless Chromium is installed here; throws instead of false when OWNI_REQUIRE_BROWSERS=1. */
export const chromiumFound = found("chromium-headless-shell", registry.findExecutable("chromium-headless-shell").executablePath());
/** Whether WebKit is installed here; throws instead of false when OWNI_REQUIRE_BROWSERS=1. */
export const webkitFound = found("webkit", webkit.executablePath());

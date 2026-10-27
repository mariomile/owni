import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningOwni, startOwni } from "../src/app.ts";
import { loadOwniConfig } from "../src/main/config.ts";
import { tempDataDir } from "./helpers.ts";
import { chromiumFound, launchChromium } from "./playwright-browsers.ts";

describe.skipIf(!chromiumFound)("the command palette's ARIA contract, in real Chromium", () => {
	const running: RunningOwni[] = [];
	afterEach(async () => {
		for (const a of running.splice(0)) await a.stop();
	});

	it("points the combobox at a real, selected option, and keeps its status region in the accessibility tree with or without results", async () => {
		const config = loadOwniConfig({ OWNI_DATA_DIR: tempDataDir(), OWNI_MODEL_PROVIDER: "faux", OWNI_WEB_PORT: "1" });
		const owni = await startOwni({ ...config, web: { ...config.web, port: 0 } }, { schedulerIntervalMs: 60_000, log: () => {} });
		running.push(owni);
		const base = `http://127.0.0.1:${(owni.server.address() as AddressInfo).port}`;
		const token = (owni.ownerLink as string).split("#")[1];
		const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "x-owni": "1" }, body: JSON.stringify({ token }) });
		const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;

		const browser = await launchChromium();
		try {
			const page = await browser.newPage();
			const [name, value] = cookie.split("=") as [string, string];
			await page.context().addCookies([{ name, value, url: base }]);
			await page.goto(`${base}/`);
			await page.waitForSelector("aside.rail button.who-id");
			await page.keyboard.press("Control+k");
			const palette = page.locator("dialog.palette[open]");
			await palette.waitFor();
			const input = palette.getByRole("combobox");
			const status = palette.getByRole("status");

			/** The option the combobox names as active: it exists, it is an option of the palette's listbox, and it is the selected one. */
			const active = async () => {
				const id = await input.getAttribute("aria-activedescendant");
				expect(id).toBeTruthy();
				const option = page.locator(`[id="${id}"]`);
				expect(await option.count()).toBe(1);
				expect(await option.getAttribute("role")).toBe("option");
				expect(await option.getAttribute("aria-selected")).toBe("true");
				expect(await option.evaluate((el) => el.parentElement?.id)).toBe(await input.getAttribute("aria-controls"));
				return { id, text: await option.innerText() };
			};

			const first = await active();
			// Results on screen: the status says nothing, and is still there to be heard when it will.
			expect(await status.count()).toBe(1);
			expect((await status.innerText()).trim()).toBe("");
			await page.keyboard.press("ArrowDown");
			const second = await active();
			expect(second.id).not.toBe(first.id);
			// Typing narrows the list: the active descendant still resolves.
			await input.fill("agent");
			await active();

			await input.fill("zzzz");
			expect(await input.getAttribute("aria-activedescendant")).toBeNull();
			expect(await palette.getByRole("option").count()).toBe(0);
			expect(await status.innerText()).toBe("Niente con questo nome");

			await input.fill("");
			await active();
			expect(await status.count()).toBe(1);

			// A request cut off by the person leaving makes no toast; any other note does.
			await page.keyboard.press("Escape");
			// A string, so the test runner leaves the browser's own import() alone: the page's module, the same instance the console uses.
			const toasts = await page.evaluate(`(async () => {
				const common = await import("/common.js");
				common.toast("Sessione chiusa", true);
				const quiet = document.getElementById("toasts").children.length;
				common.toast("Salvato");
				return { quiet, after: document.getElementById("toasts").children.length };
			})()`);
			expect(toasts).toEqual({ quiet: 0, after: 1 });
		} finally {
			await browser.close();
		}
	});
});

import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDesktopProvider } from "../src/desktop/local-desktop.ts";
import { blackPng } from "./fake-cua.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function helper(body: string, timeoutMs = 2000) {
	const dir = await mkdtemp(join(tmpdir(), "owni-local-desktop-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	// Punctuation in the executable name proves this never goes through a shell.
	const executable = join(dir, "helper with ' quotes; $(exit 1).mjs");
	await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nconst request=JSON.parse(fs.readFileSync(0,'utf8'));\n${body}\n`);
	await chmod(executable, 0o700);
	const desktop = new LocalDesktopProvider({ helperPath: executable, platform: "darwin", timeoutMs });
	cleanups.push(() => desktop.close());
	return { desktop, dir };
}

describe("the native local Mac desktop bridge", () => {
	it("reports unsupported platforms and absent helpers without inventing permissions", async () => {
		const unsupported = new LocalDesktopProvider({ helperPath: "/does-not-exist", platform: "linux" });
		expect(await unsupported.permissions()).toMatchObject({ kind: "local", supported: false, screenRecording: false, accessibility: false });
		const missing = new LocalDesktopProvider({ helperPath: "/does-not-exist", platform: "darwin" });
		expect((await missing.permissions()).problem).toContain("componente nativo");
		expect(await missing.check()).toContain("componente nativo");
	});

	it("reads native preflight status and sends only the explicit permission id", async () => {
		const { desktop } = await helper(`console.log(JSON.stringify({ok:true,permissions:{kind:'local',supported:true,screenRecording:request.tool==='request_permission'&&request.args.kind==='screenRecording',accessibility:false}}));`);
		expect(await desktop.check()).toContain("Registrazione schermo e Accessibilità");
		expect(await desktop.requestPermission("screenRecording")).toMatchObject({ screenRecording: true, accessibility: false });
		await expect(desktop.requestPermission("invalid" as never)).rejects.toThrow("non valido");
		expect(desktop.shared).toBe(true);
		await expect(desktop.reset("agent")).rejects.toThrow("Mac condiviso");
	});

	it("returns bounded PNG pixels and logical display dimensions for Retina coordinate mapping", async () => {
		const png = blackPng(1280, 800).toString("base64");
		const { desktop } = await helper(`console.log(JSON.stringify({ok:true,png:${JSON.stringify(png)},text:'Mac condiviso',structured:{screenshot_original_width:2560,screenshot_original_height:1600}}));`);
		const result = await desktop.call("a", "get_desktop_state", {});
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.images[0]?.data).toEqual(blackPng(1280, 800));
		expect(result.structured?.screenshot_original_width).toBe(2560);
	});

	it("refuses malformed/oversized images and inconsistent native results", async () => {
		const png = blackPng(1281, 800).toString("base64");
		const { desktop } = await helper(`console.log(JSON.stringify({ok:true,png:${JSON.stringify(png)},structured:{screenshot_original_width:2560,screenshot_original_height:1600}}));`);
		await expect(desktop.call("a", "get_desktop_state", {})).rejects.toThrow("limiti");
		const malformed = await helper(`console.log(JSON.stringify({ok:true,permissions:{screenRecording:true}}));`);
		expect((await malformed.desktop.permissions()).supported).toBe(false);
	});

	it("passes typed text as JSON without shell interpretation and propagates native refusals", async () => {
		const text = "ciao; $(exit 1) `touch /tmp/not-created` è 👋";
		const { desktop } = await helper(`console.log(JSON.stringify(request.args.text?{ok:true,text:request.args.text}:{ok:false,error:'Accessibilità non consentita'}));`);
		expect((await desktop.call("a", "type_text", { text })).text).toBe(text);
		await expect(desktop.call("a", "click", { x: 1, y: 2 })).rejects.toThrow("Accessibilità non consentita");
		await expect(desktop.call("a", "arbitrary-command", {})).rejects.toThrow("non disponibile");
	});

	it("passes the native refusal of a blocked app through whole, for every tool that looks or acts", async () => {
		const message = "Computer Use non controlla «1Password», che è un gestore di password: non ho fatto nulla. Se serve, deve usarla la persona";
		const { desktop } = await helper(`console.log(JSON.stringify({ok:false,error:${JSON.stringify(message)}}));`);
		for (const tool of ["get_desktop_state", "click", "drag", "scroll", "type_text", "press_key", "hotkey", "launch_app"]) {
			await expect(desktop.call("a", tool, {}), tool).rejects.toThrow(message);
		}
	});

	it("times out and aborts native work, and does not dispatch already-aborted work", async () => {
		const { desktop } = await helper(`setTimeout(()=>console.log(JSON.stringify({ok:true,text:'late'})),5000);`, 100);
		await expect(desktop.call("a", "click", {})).rejects.toThrow("in tempo");
		const aborter = new AbortController();
		const waiting = desktop.call("a", "click", {}, aborter.signal);
		setTimeout(() => aborter.abort(), 20);
		await expect(waiting).rejects.toThrow("annullata");
		await expect(desktop.call("a", "click", {}, AbortSignal.abort())).rejects.toThrow();
	});

	it("keeps Unicode intact when native JSON is split across pipe chunks", async () => {
		const { desktop } = await helper(`const output=Buffer.from(JSON.stringify({ok:true,text:'città 👋'}));const at=output.indexOf(Buffer.from('à'))+1;process.stdout.write(output.subarray(0,at));setTimeout(()=>process.stdout.end(output.subarray(at)),30);`);
		expect((await desktop.call("a", "get_screen_size", {})).text).toBe("città 👋");
	});

	it("serializes the shared keyboard and shuts down queued requests", async () => {
		const { desktop, dir } = await helper(`const log=new URL('events.txt',import.meta.url);fs.appendFileSync(log,'start '+request.args.id+'\\n');setTimeout(()=>{fs.appendFileSync(log,'end '+request.args.id+'\\n');console.log(JSON.stringify({ok:true}));},50);`);
		await Promise.all([desktop.call("a", "click", { id: 1 }), desktop.call("b", "click", { id: 2 })]);
		expect(await readFile(join(dir, "events.txt"), "utf8")).toBe("start 1\nend 1\nstart 2\nend 2\n");
		await desktop.close();
		await expect(desktop.call("a", "click", {})).rejects.toThrow("spento");
	});

	it("cancels a queued action before it gets the shared keyboard", async () => {
		const { desktop, dir } = await helper(`const log=new URL('events.txt',import.meta.url);fs.appendFileSync(log,String(request.args.id));setTimeout(()=>console.log(JSON.stringify({ok:true})),200);`);
		const first = desktop.call("a", "click", { id: 1 });
		const controller = new AbortController();
		const queued = desktop.call("b", "click", { id: 2 }, controller.signal);
		controller.abort();
		await expect(queued).rejects.toThrow("annullata");
		await first;
		await desktop.call("c", "click", { id: 3 });
		expect(await readFile(join(dir, "events.txt"), "utf8")).toBe("13");
	});
});

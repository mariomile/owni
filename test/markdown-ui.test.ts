import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The real renderer and common.h run against a tiny DOM. HTML interpretation is forbidden. */
class TestNode {
	readonly tagName: string;
	className = "";
	children: TestNode[] = [];
	attrs: Record<string, string> = {};
	listeners: Record<string, (() => unknown)[]> = {};
	disabled = false;
	private text = "";
	constructor(tagName: string, text = "") {
		this.tagName = tagName.toUpperCase();
		this.text = text;
	}
	get textContent(): string { return this.tagName === "#TEXT" ? this.text : this.children.map((child) => child.textContent).join(""); }
	set textContent(value: string) { this.children = [new TestNode("#text", String(value))]; }
	get innerHTML(): never { throw new Error("The renderer must never interpret HTML"); }
	set innerHTML(_value: string) { throw new Error("The renderer must never interpret HTML"); }
	append(...children: (TestNode | string)[]) { this.children.push(...children.map((child) => child instanceof TestNode ? child : new TestNode("#text", String(child)))); }
	setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
	addEventListener(event: string, callback: () => unknown) { (this.listeners[event] ??= []).push(callback); }
	async trigger(event: string) { for (const callback of this.listeners[event] ?? []) await callback(); }
}

const documentStub = {
	getElementById: () => null,
	createElement: (tag: string) => new TestNode(tag),
	createTextNode: (text: string) => new TestNode("#text", text),
};
vi.stubGlobal("Node", TestNode);
vi.stubGlobal("document", documentStub);

// @ts-expect-error Browser modules intentionally use plain JavaScript.
const { renderMarkdown } = await import("../src/web/ui/markdown.js") as { renderMarkdown(text: string): TestNode };

function all(root: TestNode): TestNode[] {
	const nodes: TestNode[] = [];
	const pending = [root];
	while (pending.length) {
		const node = pending.pop()!;
		nodes.push(node);
		for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]!);
	}
	return nodes;
}
const tags = (root: TestNode, tag: string) => all(root).filter((node) => node.tagName === tag.toUpperCase());
const elements = (root: TestNode) => all(root).filter((node) => node.tagName !== "#TEXT");
const byClass = (root: TestNode, name: string) => all(root).find((node) => node.className.split(" ").includes(name))!;
const only = (root: TestNode, tag: string) => {
	const result = tags(root, tag);
	expect(result).toHaveLength(1);
	return result[0]!;
};

beforeEach(() => {
	vi.stubGlobal("Node", TestNode);
	vi.stubGlobal("document", documentStub);
	vi.stubGlobal("navigator", {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("semantic assistant Markdown", () => {
	it("renders a mixed reply as headings, paragraphs, nested emphasis, quotes and a rule", () => {
		const root = renderMarkdown("## Piano di lavoro ##\n\nUna **scelta *chiara***, ***entrambi*** e ~~vecchio **piano**~~.\nSeconda riga con `**testo**`.\n\n> ### Controllo\n>\n> Un _passaggio_ e __un risultato__.\n\n---\n\nUltimo paragrafo.");
		expect(root.className).toBe("markdown");
		expect(root.children.map((node) => node.tagName)).toEqual(["H2", "P", "BLOCKQUOTE", "HR", "P"]);
		expect(only(root, "h2").textContent).toBe("Piano di lavoro");
		const paragraph = root.children[1]!;
		expect(tags(paragraph, "strong").map((node) => node.textContent)).toEqual(["scelta chiara", "entrambi", "piano"]);
		expect(tags(paragraph, "em").map((node) => node.textContent)).toEqual(["chiara", "entrambi"]);
		expect(only(paragraph, "del").textContent).toBe("vecchio piano");
		expect(only(paragraph, "code").textContent).toBe("**testo**");
		expect(tags(paragraph, "br")).toHaveLength(1);
		const quote = only(root, "blockquote");
		expect(quote.children.map((node) => node.tagName)).toEqual(["H3", "P"]);
		expect(only(quote, "em").textContent).toBe("passaggio");
	});

	it("supports all six heading levels, setext headings and CRLF input", () => {
		const root = renderMarkdown("# Uno\r\n## Due\r\n### Tre\r\n#### Quattro\r\n##### Cinque\r\n###### Sei\r\n\r\nTitolo\r\n===\r\n\r\nSottotitolo\r\n---\r\n\r\n####### letterale");
		expect(root.children.map((node) => node.tagName)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H1", "H2", "P"]);
		expect(root.children.at(-1)!.textContent).toBe("####### letterale");
	});

	it("keeps nested lists under the correct item, including mixed types and continuations", () => {
		const root = renderMarkdown("3. **Primo**\n   Continuazione\n   - Sotto\n     7. Profondo\n     8. Ancora\n   - Secondo sotto\n\n4. Prossimo\n\nParagrafo esterno.\n\n- Altro elenco\n  - Figlio\n- Fratello");
		expect(root.children.map((node) => node.tagName)).toEqual(["OL", "P", "UL"]);
		const ordered = root.children[0]!;
		expect(ordered.attrs.start).toBe("3");
		expect(ordered.children.map((node) => node.tagName)).toEqual(["LI", "LI"]);
		const first = ordered.children[0]!;
		expect(first.children.map((node) => node.tagName)).toEqual(["P", "UL"]);
		expect(first.children[0]!.textContent).toBe("PrimoContinuazione");
		expect(tags(first.children[0]!, "br")).toHaveLength(1);
		const nested = first.children[1]!;
		expect(nested.children).toHaveLength(2);
		expect(only(nested, "ol").attrs.start).toBe("7");
		expect(only(nested, "ol").children.map((node) => node.textContent)).toEqual(["Profondo", "Ancora"]);
		expect(ordered.children[1]!.textContent).toBe("Prossimo");
		expect(root.children[1]!.textContent).toBe("Paragrafo esterno.");
		expect(root.children[2]!.children.map((node) => node.textContent)).toEqual(["Altro elencoFiglio", "Fratello"]);
	});

	it("renders block content inside list items and nested quotes", () => {
		const root = renderMarkdown("- Risultato\n\n  > **Nota**\n  > > Interna\n\n  ```js\n  const ok = true;\n  ```\n- Fine");
		const list = only(root, "ul");
		expect(list.children).toHaveLength(2);
		const first = list.children[0]!;
		expect(tags(first, "blockquote")).toHaveLength(2);
		expect(only(first, "strong").textContent).toBe("Nota");
		expect(only(first, "code").textContent).toBe("const ok = true;");
	});

	it("renders escaped punctuation and multi-backtick inline code without altering code", () => {
		const root = renderMarkdown("\\*letterale\\* foo_bar_baz e __forte__ e `` `esempio` **non forte** ``.\n\\[nessun link](https://example.com)");
		expect(tags(root, "em")).toHaveLength(0);
		expect(only(root, "strong").textContent).toBe("forte");
		expect(only(root, "code").textContent).toBe("`esempio` **non forte**");
		expect(only(root, "a").attrs.href).toBe("https://example.com");
		expect(only(root, "a").textContent).toBe("https://example.com");
		expect(root.textContent).toContain("*letterale* foo_bar_baz");
		expect(root.textContent).toContain("[nessun link](https://example.com)");
	});

	it("keeps unclosed inline delimiters and unsupported reference syntax readable", () => {
		const source = "Testo **aperto e `senza chiusura\n\n[riferimento][id]\n\n[id]: https://example.com";
		const root = renderMarkdown(source);
		expect(root.children[0]!.textContent).toBe("Testo **aperto e `senza chiusura");
		expect(tags(root, "strong")).toHaveLength(0);
		expect(tags(root, "code")).toHaveLength(0);
		expect(root.textContent).toContain("[riferimento][id]");
	});
});

describe("fenced code and accessible copying", () => {
	it("requires a matching fence, preserves code as text and exposes the language", () => {
		const snippet = '<img src=x onerror="alert(1)">\n```\nconst value = "**raw** & <tag>";';
		const root = renderMarkdown(`Before\n\n\`\`\`\`html\n${snippet}\n\`\`\`\`\n\nAfter`);
		expect(root.children.map((node) => node.tagName)).toEqual(["P", "DIV", "P"]);
		const wrapper = byClass(root, "markdown-code");
		expect(only(wrapper, "pre").children[0]!.tagName).toBe("CODE");
		expect(only(wrapper, "code").textContent).toBe(snippet);
		expect(only(wrapper, "code").className).toContain("language-html");
		expect(byClass(wrapper, "markdown-code-head").textContent).toBe("htmlCopia codice");
		expect(only(wrapper, "button").attrs).toMatchObject({ type: "button", "aria-label": "Copia codice html" });
		expect(tags(root, "img")).toHaveLength(0);
	});

	it("draws an openui-lang fence as a sandboxed frame, with the plain code block kept for when it draws nothing (ADR 0118)", () => {
		const listeners: string[] = [];
		vi.stubGlobal("addEventListener", (event: string) => void listeners.push(event));
		vi.stubGlobal("MutationObserver", class { observe() {} });
		vi.stubGlobal("document", { ...documentStub, documentElement: { dataset: {} }, querySelectorAll: () => [] });
		const source = 'root = Card([CardHeader("Conti")])';
		const root = renderMarkdown(`Ecco:\n\n\`\`\`openui-lang\n${source}\n\`\`\`\n\n\`\`\`openui\n${source}\n\`\`\``);
		const boxes = all(root).filter((node) => node.className === "openui");
		expect(boxes).toHaveLength(2);
		expect(only(boxes[0]!, "iframe").attrs).toEqual({ src: "/openui/frame", sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "Risposta interattiva" });
		expect(only(boxes[0]!, "iframe").className).toBe("openui-frame");
		// The block reaches the frame by message, never as markup in the page.
		expect(tags(root, "code")).toHaveLength(0);
		expect(listeners).toEqual(["message"]);
		// Other languages stay code, even with openui in their name.
		expect(tags(renderMarkdown("```openuix\nx\n```\n\n```js openui\ny\n```"), "code").map((node) => node.textContent)).toEqual(["x", "y"]);
	});

	it("supports tilde fences, unclosed streaming fences and untrusted language metadata", () => {
		const root = renderMarkdown("~~~python\nprint('ok')\n~~~\n\n```<svg/onload=alert(1)>\n**still code**");
		expect(tags(root, "code").map((node) => node.textContent)).toEqual(["print('ok')", "**still code**"]);
		expect(tags(root, "code")[1]!.className).toBe("");
		expect(tags(root, "button")[1]!.attrs["aria-label"]).toBe("Copia codice");
		expect(tags(root, "svg")).toHaveLength(0);
	});

	it("copies the raw code, waits for confirmation and announces success without replacing the reply", async () => {
		let finish!: () => void;
		const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const raw = "  const x = '<b>& **raw**</b>';\n\treturn x;";
		const root = renderMarkdown(`\`\`\`js\n${raw}\n\`\`\``);
		const copy = only(root, "button");
		const feedback = byClass(root, "markdown-code-status");
		expect(feedback.attrs).toMatchObject({ role: "status", "aria-live": "polite", "aria-atomic": "true" });
		const copying = copy.trigger("click");
		expect(copy.disabled).toBe(true);
		expect(feedback.textContent).toBe("Copia in corso…");
		expect(feedback.textContent).not.toContain("copiato");
		await copy.trigger("click");
		expect(writeText).toHaveBeenCalledTimes(1);
		finish();
		await copying;
		expect(writeText).toHaveBeenCalledWith(raw);
		expect(copy.disabled).toBe(false);
		expect(feedback.textContent).toBe("Codice copiato.");
		expect(only(root, "code").textContent).toBe(raw);
	});

	it("reports denied clipboard access honestly and allows a successful retry", async () => {
		const writeText = vi.fn().mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const root = renderMarkdown("```\nsegreto\n```");
		const copy = only(root, "button");
		const feedback = byClass(root, "markdown-code-status");
		await copy.trigger("click");
		expect(feedback.textContent).toContain("Copia non riuscita");
		expect(feedback.textContent).not.toContain("Codice copiato");
		expect(copy.disabled).toBe(false);
		await copy.trigger("click");
		expect(feedback.textContent).toBe("Codice copiato.");
	});

	it("offers manual copying when the clipboard API is unavailable", async () => {
		const root = renderMarkdown("```\nkeep this\n```");
		await only(root, "button").trigger("click");
		expect(byClass(root, "markdown-code-status").textContent).toBe("Copia non disponibile. Seleziona il codice e copialo manualmente.");
		expect(only(root, "code").textContent).toBe("keep this");
		expect(only(root, "button").disabled).toBe(false);
	});
});

describe("responsive GFM tables", () => {
	it("renders semantic header cells, alignment, escaped pipes and inline formatting", () => {
		const root = renderMarkdown("| Nome | Stato | Totale |\n| :--- | :---: | ---: |\n| **Progetto** | `a|b` | 10 |\n| Testo \\| altro | [Apri](https://example.com) | 20 |\n\nFine.");
		const wrapper = byClass(root, "markdown-table");
		expect(wrapper.attrs).toMatchObject({ role: "region", "aria-label": "Tabella", tabindex: "0" });
		expect(only(wrapper, "table").children.map((node) => node.tagName)).toEqual(["THEAD", "TBODY"]);
		expect(tags(wrapper, "th").map((node) => node.attrs)).toEqual([
			{ scope: "col", "data-align": "left" },
			{ scope: "col", "data-align": "center" },
			{ scope: "col", "data-align": "right" },
		]);
		expect(tags(wrapper, "td").map((node) => node.textContent)).toEqual(["Progetto", "a|b", "10", "Testo | altro", "Apri", "20"]);
		expect(only(wrapper, "strong").textContent).toBe("Progetto");
		expect(only(wrapper, "code").textContent).toBe("a|b");
		expect(root.children[1]!.textContent).toBe("Fine.");
	});

	it("supports tables without outer pipes, pads missing cells and rejects malformed separators", () => {
		const root = renderMarkdown("Name | Value\n--- | ---\nOnly |\nOne | Two | Ignored\n\nNot | a table\n-- | --");
		expect(tags(root, "table")).toHaveLength(1);
		expect(tags(root, "td").map((node) => node.textContent)).toEqual(["Only", "", "One", "Two"]);
		expect(root.textContent).toContain("Not | a table");
		expect(root.textContent).toContain("-- | --");
	});
});

describe("safe Markdown destinations and literal HTML", () => {
	it("allows explicit web/mail/app links, titles, balanced destinations and autolinks", () => {
		const root = renderMarkdown('[**Sito**](https://example.com/a_(b)?x=1&y=2 "Titolo") [Posta](mailto:hello@example.com) [Chat](#/chat/thread?agent=owni) <https://example.org> <hello@example.com> https://example.net/path_(ok). HTTPS://EXAMPLE.COM/test!');
		const links = tags(root, "a");
		expect(links.map((link) => link.attrs.href)).toEqual(["https://example.com/a_(b)?x=1&y=2", "mailto:hello@example.com", "#/chat/thread?agent=owni", "https://example.org", "mailto:hello@example.com", "https://example.net/path_(ok)", "HTTPS://EXAMPLE.COM/test"]);
		expect(links[0]!.attrs).toMatchObject({ title: "Titolo", target: "_blank", rel: "noopener noreferrer" });
		expect(only(links[0]!, "strong").textContent).toBe("Sito");
		expect(links[2]!.attrs.target).toBeUndefined();
		expect(root.textContent).toContain("https://example.net/path_(ok). HTTPS://EXAMPLE.COM/test!");
	});

	it.each([
		"javascript:alert(1)", "JaVaScRiPt:alert(1)", "java%73cript:alert(1)", "%6aavascript:alert(1)",
		"javascript&#58;alert(1)", "javascript&colon;alert(1)", "&#106;avascript:alert(1)",
		"java\tscript:alert(1)", "java\u0000script:alert(1)", "\u0001javascript:alert(1)", "java\u200bscript:alert(1)",
		"data:text/html,<svg/onload=alert(1)>", "file:///Users/mario/private.txt", "vbscript:msgbox(1)",
		"//evil.example/payload", "\\\\evil.example/payload", "/Users/mario/private.txt", "../private.txt", "./report.pdf",
		"https://example.com/%0aevil", "https://example.com/%250devil", "mailto:a@example.com?body=x%0ABcc:other@example.com",
		"https://example.com/\u0000payload", "http://", "https://[broken",
	])("does not activate an unsafe, obfuscated or unsupported destination: %s", (target) => {
		const root = renderMarkdown(`[apri](<${target}>)`);
		expect(tags(root, "a")).toHaveLength(0);
		expect(root.textContent).toContain("apri");
	});

	it("renders malicious HTML as text without scripts, event attributes or external image requests", () => {
		const source = '<script>alert(1)</script>\n\n<img src="https://evil.example/pixel" onerror="alert(1)">\n\n<svg onload="alert(1)"><a href="javascript:alert(1)">x</a></svg>\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n\n&lt;img src=x onerror=alert(1)&gt;';
		const root = renderMarkdown(source);
		expect(root.children.map((node) => node.textContent).join("\n\n")).toBe(source);
		expect(elements(root).map((node) => node.tagName)).toEqual(["DIV", "P", "P", "P", "P", "P"]);
		expect(elements(root).flatMap((node) => Object.keys(node.attrs)).some((name) => /^on|src|srcdoc|style/i.test(name))).toBe(false);
	});

	it("makes images explicit links or alt fallbacks, with no img elements or file-open promises", () => {
		const root = renderMarkdown('![Diagramma](https://example.com/image.png "Diagramma esterno") ![Privato](file:///tmp/private.png) ![Traccia](data:image/svg+xml,bad) ![](https://example.org/empty.png)');
		expect(tags(root, "img")).toHaveLength(0);
		expect(tags(root, "a").map((node) => [node.attrs.href, node.textContent])).toEqual([
			["https://example.com/image.png", "Immagine: Diagramma"],
			["https://example.org/empty.png", "Immagine: senza descrizione"],
		]);
		expect(root.textContent).toContain("Immagine: Privato");
		expect(root.textContent).toContain("Immagine: Traccia");
		expect(elements(root).some((node) => "src" in node.attrs)).toBe(false);
	});

	it("never nests anchors when a link label itself contains link syntax", () => {
		const root = renderMarkdown("[See [inner](https://inner.example) and https://bare.example](https://outer.example)");
		const link = only(root, "a");
		expect(link.attrs.href).toBe("https://outer.example");
		expect(link.children.flatMap((node) => tags(node, "a"))).toHaveLength(0);
	});
});

describe("bounded rendering of long and adversarial replies", () => {
	it("renders long plain replies and preserves unmatched punctuation without throwing", () => {
		const source = `## Risultato\n\n${"Testo lungo e leggibile. ".repeat(5000)}\n\n**fine**`;
		const root = renderMarkdown(source);
		expect(only(root, "h2").textContent).toBe("Risultato");
		expect(only(root, "strong").textContent).toBe("fine");
		expect(root.children[1]!.textContent).toBe("Testo lungo e leggibile. ".repeat(5000));
		for (const hostile of ["[".repeat(50_000), "<".repeat(50_000), "prefix " + "*".repeat(200_000), "prefix " + "`".repeat(200_000), "**" + "\\*".repeat(100_000)]) {
			const rendered = renderMarkdown(hostile);
			expect(rendered.textContent === (hostile.startsWith("**\\") ? "**" + "*".repeat(100_000) : hostile)).toBe(true);
		}
	});

	it("bounds DOM growth and recursion while retaining the tail of repeated and deeply nested content", () => {
		const root = renderMarkdown(`${"- **item**\n".repeat(18_000)}TAIL_MUST_SURVIVE`);
		expect(elements(root).length).toBeLessThan(12_050);
		expect(root.textContent).toContain("TAIL_MUST_SURVIVE");
		const nested = renderMarkdown("> ".repeat(5000) + "NESTED_TAIL");
		expect(tags(nested, "blockquote").length).toBeLessThanOrEqual(12);
		expect(nested.textContent).toContain("NESTED_TAIL");
	});

	it("leaves oversized replies literal rather than truncating or creating an unbounded DOM", () => {
		const source = `## ${"x".repeat(300_000)}\n\n**TAIL**`;
		const root = renderMarkdown(source);
		expect(root.textContent).toBe(source);
		expect(elements(root).map((node) => node.tagName)).toEqual(["DIV", "P"]);
		expect(byClass(root, "markdown-fallback").textContent).toBe(source);
	});

	it("marks inline-budget and depth fallbacks so multiline text retains its original whitespace", () => {
		const tail = "\n    preserved indentation\nlast line";
		const inline = renderMarkdown("`x` ".repeat(15_000) + tail);
		expect(byClass(inline, "markdown-fallback").textContent).toContain(tail);
		const nested = renderMarkdown(`${"> ".repeat(15)}first line\n${"> ".repeat(15)}    second line`);
		expect(byClass(nested, "markdown-fallback").textContent).toContain("\n");
		expect(byClass(nested, "markdown-fallback").textContent).toContain("    second line");
	});
});

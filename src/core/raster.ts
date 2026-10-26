import { pngOf } from "./pdf-codecs.ts";
import { SANS, SANS_BOLD } from "./chart-font.ts";

/**
 * A small anti-aliased rasteriser for charts (ADR 0030): filled shapes and text on an RGB canvas,
 * written out as a PNG. Shapes are contours (closed polygons as flat x, y lists); overlapping
 * contours of one fill add up to full coverage, so a stroke is the union of its pieces.
 * Coverage is the exact area of each pixel under the shape (signed-area accumulation, as in
 * font-rs), so edges are smooth without supersampling.
 */
export type Rgb = readonly [number, number, number];
export type Contour = number[];

export class Raster {
	readonly width: number;
	readonly height: number;
	readonly pixels: Buffer;

	constructor(width: number, height: number, background: Rgb) {
		this.width = width;
		this.height = height;
		this.pixels = Buffer.alloc(width * height * 3);
		for (let i = 0; i < width * height; i++) this.pixels.set(background, i * 3);
	}

	/** Fill the union of the contours with a colour; opacity below 1 lets the canvas through. */
	fill(contours: readonly Contour[], color: Rgb, opacity = 1): void {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const c of contours) {
			for (let i = 0; i + 1 < c.length; i += 2) {
				const x = c[i] as number;
				const y = c[i + 1] as number;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
		// The box of the shape on the canvas; line() keeps each edge inside it.
		const x0 = Math.max(0, Math.floor(minX));
		const y0 = Math.max(0, Math.floor(minY));
		const x1 = Math.min(this.width, Math.ceil(maxX));
		const y1 = Math.min(this.height, Math.ceil(maxY));
		if (!(x1 > x0 && y1 > y0)) return;
		const w = x1 - x0;
		const h = y1 - y0;
		const stride = w + 2;
		const acc = new Float32Array(stride * h);
		for (const c of contours) {
			const n = Math.floor(c.length / 2);
			if (n < 3) continue;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				line(acc, stride, w, h, (c[i * 2] as number) - x0, (c[i * 2 + 1] as number) - y0, (c[j * 2] as number) - x0, (c[j * 2 + 1] as number) - y0);
			}
		}
		const [r, g, b] = color;
		for (let y = 0; y < h; y++) {
			let sum = 0;
			const row = y * stride;
			let at = ((y0 + y) * this.width + x0) * 3;
			for (let x = 0; x < w; x++, at += 3) {
				sum += acc[row + x] as number;
				const cover = Math.min(1, Math.abs(sum)) * opacity;
				if (cover < 1 / 512) continue;
				const p = this.pixels;
				p[at] = Math.round((p[at] as number) + (r - (p[at] as number)) * cover);
				p[at + 1] = Math.round((p[at + 1] as number) + (g - (p[at + 1] as number)) * cover);
				p[at + 2] = Math.round((p[at + 2] as number) + (b - (p[at + 2] as number)) * cover);
			}
		}
	}

	png(): Buffer {
		return pngOf({ width: this.width, height: this.height, colorType: 2, bitDepth: 8, samples: this.pixels });
	}
}

/**
 * Add one edge's signed area to the accumulation rows (y down). The edge is cut to the rows
 * 0..h where it crosses them; left of the box it counts as on the left edge (everything to its
 * right is inside), right of the box as on the right edge (nothing of the box is).
 */
function line(acc: Float32Array, stride: number, w: number, h: number, ax: number, ay: number, bx: number, by: number): void {
	if (Math.abs(ay - by) <= 1e-9) return;
	const dir = ay < by ? 1 : -1;
	let [px, py, qx, qy] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
	if (qy <= 0 || py >= h) return;
	const dxdy = (qx - px) / (qy - py);
	if (py < 0) {
		px -= py * dxdy;
		py = 0;
	}
	if (qy > h) {
		qx -= (qy - h) * dxdy;
		qy = h;
	}
	let x = px;
	const end = Math.ceil(qy);
	for (let y = Math.floor(py); y < end; y++) {
		const dy = Math.min(y + 1, qy) - Math.max(y, py);
		const xnext = x + dxdy * dy;
		const d = dy * dir;
		// The piece of this row's edge left of the box, inside it and right of it, each with its share of the height.
		const cuts = [0, 1];
		for (const edge of [0, w]) {
			const t = (edge - x) / (xnext - x);
			if (t > 0 && t < 1) cuts.push(t);
		}
		cuts.sort((a, b) => a - b);
		for (let k = 0; k + 1 < cuts.length; k++) {
			const t0 = cuts[k] as number;
			const t1 = cuts[k + 1] as number;
			if (t1 <= t0) continue;
			const a = Math.min(w, Math.max(0, x + (xnext - x) * t0));
			const b = Math.min(w, Math.max(0, x + (xnext - x) * t1));
			cover(acc, y * stride, a, b, d * (t1 - t0));
		}
		x = xnext;
	}
}

/**
 * Spread the area of one piece of edge in a row over the pixels it crosses: the area between the
 * edge and each pixel's right side, `first` for the pixel where it starts, `last` for the one
 * where it ends, `s` for each pixel between.
 */
function cover(acc: Float32Array, start: number, a: number, b: number, d: number): void {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const loI = Math.floor(lo);
	const hiI = Math.ceil(hi);
	if (hiI <= loI + 1) {
		const mid = 0.5 * (lo + hi) - loI;
		acc[start + loI] = (acc[start + loI] as number) + d - d * mid;
		acc[start + loI + 1] = (acc[start + loI + 1] as number) + d * mid;
		return;
	}
	const s = 1 / (hi - lo);
	const lof = lo - loI;
	const first = 0.5 * s * (1 - lof) * (1 - lof);
	const hif = hi - hiI + 1;
	const last = 0.5 * s * hif * hif;
	acc[start + loI] = (acc[start + loI] as number) + d * first;
	if (hiI === loI + 2) acc[start + loI + 1] = (acc[start + loI + 1] as number) + d * (1 - first - last);
	else {
		const second = s * (1.5 - lof);
		acc[start + loI + 1] = (acc[start + loI + 1] as number) + d * (second - first);
		for (let xi = loI + 2; xi < hiI - 1; xi++) acc[start + xi] = (acc[start + xi] as number) + d * s;
		const before = second + (hiI - loI - 3) * s;
		acc[start + hiI - 1] = (acc[start + hiI - 1] as number) + d * (1 - before - last);
	}
	acc[start + hiI] = (acc[start + hiI] as number) + d * last;
}

/** A rectangle with the given corner radii (top-left, top-right, bottom-right, bottom-left), clockwise. */
export function roundedRect(x: number, y: number, w: number, h: number, radii: readonly [number, number, number, number] = [0, 0, 0, 0]): Contour {
	const limit = Math.min(w, h) / 2;
	const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, limit))) as [number, number, number, number];
	const out: Contour = [];
	const corner = (cx: number, cy: number, r: number, from: number) => {
		if (r === 0) {
			out.push(cx, cy);
			return;
		}
		const steps = Math.max(2, Math.ceil(r / 2));
		for (let i = 0; i <= steps; i++) {
			const a = from + (i / steps) * (Math.PI / 2);
			out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
		}
	};
	corner(tl === 0 ? x : x + tl, tl === 0 ? y : y + tl, tl, Math.PI);
	corner(tr === 0 ? x + w : x + w - tr, tr === 0 ? y : y + tr, tr, -Math.PI / 2);
	corner(br === 0 ? x + w : x + w - br, br === 0 ? y + h : y + h - br, br, 0);
	corner(bl === 0 ? x : x + bl, bl === 0 ? y + h : y + h - bl, bl, Math.PI / 2);
	return out;
}

export function circle(cx: number, cy: number, r: number): Contour {
	const steps = Math.max(12, Math.ceil(r * 1.5));
	const out: Contour = [];
	for (let i = 0; i < steps; i++) out.push(cx + Math.cos((i / steps) * 2 * Math.PI) * r, cy + Math.sin((i / steps) * 2 * Math.PI) * r);
	return out;
}

/** A ring sector between radii r0 < r1, from angle a0 to a1 (radians, clockwise from 12 o'clock). */
export function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): Contour {
	const steps = Math.max(2, Math.ceil(((a1 - a0) * r1) / 6));
	const at = (r: number, a: number): [number, number] => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
	const out: Contour = [];
	for (let i = 0; i <= steps; i++) out.push(...at(r1, a0 + ((a1 - a0) * i) / steps));
	for (let i = steps; i >= 0; i--) out.push(...at(r0, a0 + ((a1 - a0) * i) / steps));
	return out;
}

/** A polyline as filled pieces: a quad for every segment and a disc at every joint and end. */
export function stroke(points: readonly (readonly [number, number])[], width: number): Contour[] {
	const half = width / 2;
	const out: Contour[] = [];
	for (let i = 0; i + 1 < points.length; i++) {
		const [ax, ay] = points[i] as [number, number];
		const [bx, by] = points[i + 1] as [number, number];
		const len = Math.hypot(bx - ax, by - ay);
		if (len === 0) continue;
		const nx = (-(by - ay) / len) * half;
		const ny = ((bx - ax) / len) * half;
		// Every piece goes the same way round, so where they overlap they add up instead of cancelling.
		out.push(clockwise([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]));
	}
	for (const [x, y] of points) out.push(circle(x, y, half));
	return out;
}

function clockwise(c: Contour): Contour {
	let area = 0;
	const n = c.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += (c[i * 2] as number) * (c[j * 2 + 1] as number) - (c[j * 2] as number) * (c[i * 2 + 1] as number);
	}
	if (area >= 0) return c;
	const out: Contour = [];
	for (let i = n - 1; i >= 0; i--) out.push(c[i * 2] as number, c[i * 2 + 1] as number);
	return out;
}

export type Face = "regular" | "bold";
type Glyph = { advance: number; contours: Contour[] };

const FACES = { regular: SANS, bold: SANS_BOLD } as const;
const cache = new Map<string, Glyph>();
const QUESTION = 63;

/** How many characters of the text the chart font cannot draw (each is drawn as «?»). */
export function missingCharacters(text: string): number {
	let missing = 0;
	for (const ch of text) if (SANS.glyphs[ch.codePointAt(0) as number] === undefined && !/\s/.test(ch)) missing++;
	return missing;
}

function glyph(face: Face, code: number): Glyph {
	// Characters the font does not have share one entry, so the cache stays as small as the font.
	const known = FACES[face].glyphs[code] !== undefined || SANS.glyphs[code] !== undefined;
	const key = `${face}:${known ? code : QUESTION}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const entry = FACES[face].glyphs[code] ?? SANS.glyphs[code] ?? (code === 0x09 || code === 0x0a ? SANS.glyphs[32] : SANS.glyphs[QUESTION]);
	const [advance, path] = entry as readonly [number, string];
	const made = { advance, contours: parsePath(path) };
	cache.set(key, made);
	return made;
}

/** The outline path of the font file, curves flattened, in font units with y up. */
function parsePath(path: string): Contour[] {
	const out: Contour[] = [];
	let current: Contour = [];
	const tokens = path.match(/[MQ]|-?\d+/g) ?? [];
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i] as string;
		if (t === "M") {
			if (current.length > 0) out.push(current);
			current = [Number(tokens[i + 1]), Number(tokens[i + 2])];
			i += 3;
		} else if (t === "Q") {
			const x0 = current[current.length - 2] as number;
			const y0 = current[current.length - 1] as number;
			const qx = Number(tokens[i + 1]);
			const qy = Number(tokens[i + 2]);
			const x1 = Number(tokens[i + 3]);
			const y1 = Number(tokens[i + 4]);
			const steps = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(Math.hypot(qx - x0, qy - y0) + Math.hypot(x1 - qx, y1 - qy)) / 3)));
			for (let s = 1; s <= steps; s++) {
				const u = s / steps;
				const v = 1 - u;
				current.push(v * v * x0 + 2 * v * u * qx + u * u * x1, v * v * y0 + 2 * v * u * qy + u * u * y1);
			}
			i += 5;
		} else {
			current.push(Number(t), Number(tokens[i + 1]));
			i += 2;
		}
	}
	if (current.length > 0) out.push(current);
	return out;
}

/** The width of a line of text at a size (the em in pixels). */
export function measure(text: string, size: number, face: Face = "regular"): number {
	let w = 0;
	for (const ch of text) w += glyph(face, ch.codePointAt(0) as number).advance;
	return (w * size) / 1000;
}

export type TextOptions = { readonly size: number; readonly face?: Face; readonly align?: "left" | "center" | "right"; readonly angle?: number };

/**
 * The outlines of a line of text with its baseline at (x, y), y down; `angle` turns it around
 * (x, y), in radians clockwise.
 */
export function textContours(text: string, x: number, y: number, options: TextOptions): Contour[] {
	const face = options.face ?? "regular";
	const scale = options.size / 1000;
	const width = measure(text, options.size, face);
	const shift = options.align === "center" ? -width / 2 : options.align === "right" ? -width : 0;
	const cos = Math.cos(options.angle ?? 0);
	const sin = Math.sin(options.angle ?? 0);
	const out: Contour[] = [];
	let pen = shift;
	for (const ch of text) {
		const g = glyph(face, ch.codePointAt(0) as number);
		for (const c of g.contours) {
			const placed: Contour = [];
			for (let i = 0; i + 1 < c.length; i += 2) {
				const lx = pen + (c[i] as number) * scale;
				const ly = -(c[i + 1] as number) * scale;
				placed.push(x + lx * cos - ly * sin, y + lx * sin + ly * cos);
			}
			out.push(placed);
		}
		pen += g.advance * scale;
	}
	return out;
}

/** Cut a text to a width, with «…» at the end when it does not fit. */
export function fitText(text: string, maxWidth: number, size: number, face: Face = "regular"): string {
	if (measure(text, size, face) <= maxWidth) return text;
	const chars = [...text];
	let lo = 0;
	let hi = chars.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`, size, face) <= maxWidth) lo = mid;
		else hi = mid - 1;
	}
	return lo === 0 ? "…" : `${chars.slice(0, lo).join("").trimEnd()}…`;
}

/** Break a text into lines no wider than maxWidth, at spaces; a word longer than a line is cut. */
export function wrapText(text: string, maxWidth: number, size: number, face: Face = "regular", maxLines = 3): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line === "" ? word : `${line} ${word}`;
		if (measure(next, size, face) <= maxWidth || line === "") line = next;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line !== "") lines.push(line);
	if (lines.length > maxLines) {
		const kept = lines.slice(0, maxLines);
		kept[maxLines - 1] = fitText(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, maxWidth, size, face);
		return kept.map((l) => fitText(l, maxWidth, size, face));
	}
	return lines.map((l) => fitText(l, maxWidth, size, face));
}

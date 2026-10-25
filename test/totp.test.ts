import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totp, verifyTotp } from "../src/web/totp.ts";

// RFC 6238, appendix B (HMAC-SHA1): secret "12345678901234567890", 8 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const RFC_VECTORS: [number, string][] = [
	[59, "94287082"],
	[1111111109, "07081804"],
	[1111111111, "14050471"],
	[1234567890, "89005924"],
	[2000000000, "69279037"],
	[20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
	it("matches the RFC test vectors", () => {
		for (const [seconds, code] of RFC_VECTORS) expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
	});

	it("uses six digits by default", () => {
		expect(totp(RFC_SECRET, 59_000)).toBe("287082");
	});

	it("base32 round-trips and ignores spaces and case", () => {
		const bytes = Buffer.from("owni-2fa-secret!!xx");
		const encoded = base32Encode(bytes);
		expect(encoded).toMatch(/^[A-Z2-7]+$/);
		expect(base32Decode(encoded)).toEqual(bytes);
		expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, "$1 "))).toEqual(bytes);
	});

	it("generates 160-bit secrets", () => {
		const a = generateTotpSecret();
		expect(base32Decode(a)).toHaveLength(20);
		expect(generateTotpSecret()).not.toBe(a);
	});

	it("accepts the current step and one either side, rejects others and replays", () => {
		const now = 1_700_000_000_000;
		const step = Math.floor(now / 30_000);
		expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now)).toBe(step);
		expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
		expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
		expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), now)).toBeUndefined();
		// A code already used (its step or an earlier one) does not work again.
		expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now, step)).toBeUndefined();
		expect(verifyTotp(RFC_SECRET, "12345", now)).toBeUndefined();
		expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeUndefined();
	});

	it("tolerates spaces in the typed code", () => {
		const now = 1_700_000_000_000;
		const code = totp(RFC_SECRET, now);
		expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBeDefined();
	});

	it("builds an otpauth URI authenticator apps understand", () => {
		const uri = otpauthUri("JBSWY3DPEHPK3PXP", "Anna Rossi", "Owni");
		expect(uri).toBe("otpauth://totp/Owni:Anna%20Rossi?secret=JBSWY3DPEHPK3PXP&issuer=Owni&algorithm=SHA1&digits=6&period=30");
	});
});

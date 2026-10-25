import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { accessOf, BillingRefused, mayUse, StripeBilling } from "../src/cloud/billing.ts";

const config = { secretKey: "sk_test_secret_value", webhookSecret: "whsec_unit", price: "price_flat", trialDays: 14 };
const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", created: 1, data: { object: { status: "active" } } }));
const sign = (t: number, payload = body, secret = config.webhookSecret) => createHmac("sha256", secret).update(`${t}.`).update(payload).digest("hex");

describe("Stripe webhook signatures", () => {
	const billing = new StripeBilling(config);
	const now = 1_800_000_000_000;
	const t = now / 1000;

	it("takes a delivery Stripe signed in the last five minutes, also beside an old secret's signature", () => {
		expect(billing.event(body, `t=${t},v1=${sign(t)}`, now).type).toBe("customer.subscription.updated");
		expect(billing.event(body, `t=${t},v1=${sign(t, body, "whsec_old")},v1=${sign(t)},v0=zzz`, now).created).toBe(1);
	});

	it("refuses no header, a wrong secret, a changed body, a replay after five minutes, a bare v0", () => {
		expect(() => billing.event(body, undefined, now)).toThrow(BillingRefused);
		expect(() => billing.event(body, `t=${t},v1=${sign(t, body, "whsec_other")}`, now)).toThrow(/non valida/);
		expect(() => billing.event(Buffer.from(body.toString().replace("active", "trialing")), `t=${t},v1=${sign(t)}`, now)).toThrow(/non valida/);
		expect(() => billing.event(body, `t=${t - 301},v1=${sign(t - 301)}`, now)).toThrow(/scaduta/);
		expect(() => billing.event(body, `t=${t},v0=${sign(t)}`, now)).toThrow(/mancante/);
		const empty = Buffer.from(JSON.stringify({ id: "evt_2", type: "x", created: 1, data: { object: null } }));
		expect(() => billing.event(empty, `t=${t},v1=${sign(t, empty)}`, now)).toThrow(/evento non valido/);
	});

	it("a Stripe error says what Stripe said, never the key", async () => {
		const server = createServer((req, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `Invalid API Key provided: ${String(req.headers.authorization).replace("Bearer ", "")}` } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		try {
			const failing = new StripeBilling({ ...config, apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
			const error = await failing.portal("cus_1", "https://owni.example").catch((e: Error) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("Stripe /v1/billing_portal/sessions: 401 Invalid API Key provided: [chiave]");
		} finally {
			server.close();
		}
	});
});

describe("trial and access", () => {
	const day = 86_400_000;
	it("a trial from sign-up, or from when billing started for tenants already there; a subscription decides after", () => {
		const created = "2026-10-01T00:00:00.000Z";
		const since = "2026-09-01T00:00:00.000Z";
		const trial = accessOf({ createdAt: created }, since, 14, Date.parse(created) + 13 * day);
		expect(trial).toEqual({ state: "trial", trialEndsAt: "2026-10-15T00:00:00.000Z" });
		expect(mayUse(accessOf({ createdAt: created }, since, 14, Date.parse(created) + 15 * day))).toBe(false);
		// An old tenant gets its trial from the day billing was switched on, not from its sign-up.
		expect(accessOf({ createdAt: "2025-01-01T00:00:00.000Z" }, created, 14, Date.parse(created) + day).state).toBe("trial");
		const late = Date.parse(created) + 100 * day;
		expect(accessOf({ createdAt: created, billing: { status: "active" } }, since, 14, late).state).toBe("active");
		expect(accessOf({ createdAt: created, billing: { status: "trialing" } }, since, 14, late).state).toBe("active");
		expect(mayUse(accessOf({ createdAt: created, billing: { status: "past_due" } }, since, 14, late))).toBe(true);
		for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) expect(accessOf({ createdAt: created, billing: { status } }, since, 14, late).state).toBe("ended");
		// Cancelling or not paying ends it even inside the trial; a checkout not yet paid does not.
		const early = Date.parse(created) + day;
		for (const status of ["canceled", "unpaid", "incomplete_expired", "paused"]) expect(accessOf({ createdAt: created, billing: { status } }, since, 14, early).state).toBe("ended");
		expect(accessOf({ createdAt: created, billing: { status: "incomplete" } }, since, 14, early).state).toBe("trial");
	});
});

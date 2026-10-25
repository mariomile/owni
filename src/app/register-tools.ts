import { createInvoiceTools } from "../core/tools/invoice-tools.ts";
import { createRenewalTools } from "../core/tools/renewal-tools.ts";
import { createPriceListTools } from "../core/tools/price-list-tools.ts";
import { createCashflowTools } from "../core/tools/cashflow-tools.ts";
import { createTaxTools } from "../core/tools/tax-tools.ts";
import { createVatSettlementTools } from "../core/tools/vat-settlement-tools.ts";
import { createBankTools } from "../core/tools/bank-tools.ts";
import { createClientTools } from "../core/tools/client-tools.ts";
import { createSupplierTools } from "../core/tools/supplier-tools.ts";
import { createBusinessReportTools } from "../core/tools/business-report-tools.ts";
import { createBudgetTools } from "../core/tools/budget-tools.ts";
import { createPurchasePriceTools } from "../core/tools/purchase-price-tools.ts";
import { createMarginTools } from "../core/tools/margin-tools.ts";
import { createStockTools } from "../core/tools/stock-tools.ts";
import { createOrderTools } from "../core/tools/order-tools.ts";
import { createAppointmentTools } from "../core/tools/appointment-tools.ts";
import { createStaffTools } from "../core/tools/staff-tools.ts";
import { createDdtTools } from "../core/tools/ddt-tools.ts";
import { orderLink } from "../core/order-receive.ts";
import { createWithholdingTools } from "../core/tools/withholding-tools.ts";
import { createFiscalAgendaTools } from "../core/tools/fiscal-agenda-tools.ts";
import { createSalesInvoiceTools } from "../core/tools/sales-invoice-tools.ts";
import { createRecurringInvoiceTools } from "../core/tools/recurring-invoice-tools.ts";
import { createTimesheetTools } from "../core/tools/timesheet-tools.ts";
import type { OwniTool } from "../core/engine.ts";
import type { MailRequests } from "../core/mail-requests.ts";
import type { InvoiceScanner } from "../core/invoice-scan.ts";
import type { InstanceRecord } from "../core/registry.ts";
import type { OwniRuntime } from "../core/runtime.ts";
import type { RecurringEnv } from "../core/tools/recurring-invoice-run.ts";
import type { expensesOf } from "../core/tools/expense-tools.ts";
import type { quotesOf } from "../core/tools/quote-tools.ts";
import type { schedulesOf } from "../core/tools/schedule-tools.ts";
import type { OwniConfig } from "../main/config.ts";
import { type SubjectSeam, type SubjectStores, withSubjects } from "../core/subjects.ts";

/** The registers of an agente that il registro di chi segue cosa reads (ADR 0110). */
export function subjectStoresOf(runtime: OwniRuntime, tenant: string, agent: string): SubjectStores {
	return {
		clients: runtime.clients(tenant, agent),
		suppliers: runtime.suppliers(tenant, agent),
		quotes: runtime.quotes(tenant, agent),
		orders: runtime.orders(tenant, agent),
		appointments: runtime.appointments(tenant, agent),
		sales: runtime.salesInvoices(tenant, agent),
		ddt: runtime.ddt(tenant, agent),
	};
}

export type RegisterToolsDeps = {
	readonly runtime: OwniRuntime;
	readonly record: InstanceRecord;
	readonly config: OwniConfig;
	readonly mail: MailRequests | undefined;
	readonly quotes: ReturnType<typeof quotesOf>;
	readonly expenses: ReturnType<typeof expensesOf>;
	/** The tools of the schedules, whose reminders the clients' ricontatti use. */
	readonly schedules: ReturnType<typeof schedulesOf>;
	readonly invoiceScanner: InvoiceScanner;
	readonly isBriefThread: (thread: { channel: string; threadId: string }) => Promise<boolean>;
	readonly recurringEnv: (tenantId: string, instanceId: string) => RecurringEnv;
	/** Il registro di chi segue cosa (ADR 0110), as this agente's write hook sees it. */
	readonly subjects: { readonly seam: SubjectSeam; readonly log: (message: string) => void };
};

/**
 * The business registers of an instance (ADR 0100): not offered to the model until it loads them
 * with tool_search, which saves ~140k characters of schema (~35k tokens) on every other request.
 */
export function registerTools(deps: RegisterToolsDeps): OwniTool[] {
	const { runtime, record, config, mail, quotes, expenses, schedules, invoiceScanner, isBriefThread, recurringEnv, subjects } = deps;
	const tools: OwniTool[] = [
		...createInvoiceTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			isBriefThread,
			...(mail === undefined ? {} : { mail }),
			purchases: runtime.purchases(record.tenantId, record.id),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		...quotes.tools,
		...expenses.tools,
		...createTimesheetTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.timesheet(record.tenantId, record.id),
			company: runtime.invoices(record.tenantId, record.id),
			quotes: runtime.quotes(record.tenantId, record.id),
			createQuote: quotes.create,
			priceList: runtime.priceList(record.tenantId, record.id),
			scanner: invoiceScanner,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Il listino: its own store; quotes, the timesheet and the fatture in uscita read it, never write it.
		...createPriceListTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.priceList(record.tenantId, record.id),
			company: runtime.invoices(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		...createRenewalTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.renewals(record.tenantId, record.id),
			expenses: expenses.seam,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// The forecast reads the other registers through their own stores and the shared scanner, never writing them.
		...createCashflowTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.cashflow(record.tenantId, record.id),
			bank: runtime.bank(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			renewals: runtime.renewals(record.tenantId, record.id),
			quotes: runtime.quotes(record.tenantId, record.id),
			timesheet: runtime.timesheet(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			vat: runtime.vat(record.tenantId, record.id),
			sales: runtime.salesInvoices(record.tenantId, record.id),
			// The canoni not drafted yet (ADR 0088), with what their drafts read.
			recurring: runtime.recurringInvoices(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			clients: runtime.clients(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// The tax estimate reads the scadenzario's paid marks through its store and the shared scanner, never writing them.
		...createTaxTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.taxes(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// La liquidazione IVA reads the fatture in uscita, the scadenzario (through the shared scanner) and the tax profile, never writing them.
		...createVatSettlementTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.vat(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			sales: runtime.salesInvoices(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			scanner: invoiceScanner,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// L'estratto conto reads the scadenzario, the expenses, the renewals and the tax profile; it marks an invoice paid, records an expense or sets the cashflow's balance only on the person's yes.
		...createBankTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.bank(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			expenseSeam: expenses.seam,
			renewals: runtime.renewals(record.tenantId, record.id),
			cashflow: runtime.cashflow(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// The clients read the other registers through their own stores and the shared scanner, never writing them.
		...createClientTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.clients(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			quotes: runtime.quotes(record.tenantId, record.id),
			timesheet: runtime.timesheet(record.tenantId, record.id),
			reminders: schedules.reminders,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// The suppliers read the scadenzario (through the shared scanner), the expenses, the renewals and the bank statement, never writing them; they write only their cards and the export.
		...createSupplierTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.suppliers(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			renewals: runtime.renewals(record.tenantId, record.id),
			bank: runtime.bank(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// L'andamento dell'attività reads every register through its own store and the shared scanner, never writing them; only its export writes a CSV.
		...createBusinessReportTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			sales: runtime.salesInvoices(record.tenantId, record.id),
			expenses: runtime.expenses(record.tenantId, record.id),
			quotes: runtime.quotes(record.tenantId, record.id),
			timesheet: runtime.timesheet(record.tenantId, record.id),
			clients: runtime.clients(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			vat: runtime.vat(record.tenantId, record.id),
			bank: runtime.bank(record.tenantId, record.id),
			timeZone: config.timeZone,
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Budget e obiettivi read the scadenzario (through the shared scanner), the fatture in uscita, the expenses, the supplier cards, the renewals and the bank statement, never writing them; they write only the budgets, the brief's alerts said and the export.
		...createBudgetTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.budgets(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			sales: runtime.salesInvoices(record.tenantId, record.id),
			expenses: runtime.expenses(record.tenantId, record.id),
			suppliers: runtime.suppliers(record.tenantId, record.id),
			renewals: runtime.renewals(record.tenantId, record.id),
			bank: runtime.bank(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Il magazzino: its own store; it reads the listino and (to find a carico's supplier) the scadenzario through the shared scanner, the expenses and the supplier cards, never writing them. The fatture in uscita move it when issued.
		...createStockTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.stock(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			suppliers: runtime.suppliers(record.tenantId, record.id),
			purchases: runtime.purchases(record.tenantId, record.id),
			orders: orderLink(runtime.orders(record.tenantId, record.id)),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Gli ordini ai fornitori: their own store; they read the magazzino and (through the shared scanner) the invoices received, the expenses, the supplier cards and the company, never writing them; the invoices received loaded in the magazzino mark them.
		...createOrderTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.orders(record.tenantId, record.id),
			stock: runtime.stock(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			suppliers: runtime.suppliers(record.tenantId, record.id),
			ddt: runtime.ddt(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// I prezzi d'acquisto read the invoices received through the shared scanner, the expenses and the supplier cards, never writing them; they write only the increases said and the export.
		...createPurchasePriceTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.purchases(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			suppliers: runtime.suppliers(record.tenantId, record.id),
			timeZone: config.timeZone,
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// I margini read the fatture in uscita, the magazzino, the listino and (through the shared scanner) the invoices received, the expenses and the supplier cards, never writing them; they write only the voci the brief said and the export.
		...createMarginTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.margins(record.tenantId, record.id),
			sales: runtime.salesInvoices(record.tenantId, record.id),
			stock: runtime.stock(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			expenses: runtime.expenses(record.tenantId, record.id),
			suppliers: runtime.suppliers(record.tenantId, record.id),
			timeZone: config.timeZone,
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Le ritenute read the fatture in uscita, the scadenzario (through the shared scanner), the tax profile and the bank statement, never writing them; they write only the CU said and the export.
		...createWithholdingTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.withholding(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			sales: runtime.salesInvoices(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			bank: runtime.bank(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// L'agenda fiscale reads every register through its own store and the shared scanner, never writing them; only its export writes a .ics.
		...createFiscalAgendaTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			invoices: runtime.invoices(record.tenantId, record.id),
			scanner: invoiceScanner,
			sales: runtime.salesInvoices(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			vat: runtime.vat(record.tenantId, record.id),
			renewals: runtime.renewals(record.tenantId, record.id),
			timeZone: config.timeZone,
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// The fatture in uscita read the company, the clients, the quotes, the hours and (through the shared scanner) the numbers already used; they mark only a quote invoiced and the hours billed, and move the magazzino for the voci it holds.
		...createSalesInvoiceTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.salesInvoices(record.tenantId, record.id),
			company: runtime.invoices(record.tenantId, record.id),
			taxes: runtime.taxes(record.tenantId, record.id),
			clients: runtime.clients(record.tenantId, record.id),
			quotes: runtime.quotes(record.tenantId, record.id),
			timesheet: runtime.timesheet(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			stock: runtime.stock(record.tenantId, record.id),
			ddt: runtime.ddt(record.tenantId, record.id),
			appointments: runtime.appointments(record.tenantId, record.id),
			scanner: invoiceScanner,
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// I DDT in uscita: their own store; they read the fatture in uscita, the client cards, the listino and the company, never writing them; issued, they move the magazzino. The fattura differita that bills them is sales_invoices'.
		...createDdtTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.ddt(record.tenantId, record.id),
			sales: runtime.salesInvoices(record.tenantId, record.id),
			clients: runtime.clients(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			stock: runtime.stock(record.tenantId, record.id),
			company: runtime.invoices(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Gli appuntamenti: their own store; they read the client cards and the listino, never writing them. Billing them is sales_invoices'.
		...createAppointmentTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.appointments(record.tenantId, record.id),
			clients: runtime.clients(record.tenantId, record.id),
			priceList: runtime.priceList(record.tenantId, record.id),
			timeZone: config.timeZone,
			calendar: config.google?.write === true && config.google.services.includes("calendar"),
			// An absence of the staff, or the time off the shift, blocks its person's resource (never forced).
			absences: (day) => runtime.staff(record.tenantId, record.id).blocksOn(day),
			staffBroken: () => runtime.staff(record.tenantId, record.id).broken(),
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Il personale: its own store (HR data, not Owni's users); it reads the appointments' hours and bookings, never writing them.
		...createStaffTools({
			workspace: runtime.workspace(record.tenantId, record.id),
			store: runtime.staff(record.tenantId, record.id),
			appointments: runtime.appointments(record.tenantId, record.id),
			timeZone: config.timeZone,
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
			record: async (event) => {
				await runtime.audit(record.tenantId).append({ ...event, instanceId: record.id, source: "owni" });
			},
		}),
		// Le fatture ricorrenti: each period's draft by sales_invoices' own builder; never issued by Owni.
		...createRecurringInvoiceTools({
			...recurringEnv(record.tenantId, record.id),
			whoIs: (thread) => runtime.participant(record.tenantId, record.id, thread),
		}),
	];
	// After a write, the agente's records go into the tenant's ledger, and the result says who else has the same client or supplier.
	return withSubjects(tools, subjects.seam, subjects.log).map((tool) => ({ ...tool, deferred: true }));
}

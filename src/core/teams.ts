import type { Org, OrgPlace } from "./org.ts";
import type { Tone } from "./persona.ts";

/**
 * Ready-made teams (ADR 0068): a few agenti made together, each with its job, a squadra in the
 * organigramma (ADR 0117) and a room where the person talks to all of them. Only a starting
 * point: once made they are ordinary agenti, changed or moved one by one.
 */
export type TeamMember = {
	/** Its ID when free; otherwise -2, -3… */
	readonly id: string;
	readonly name: string;
	readonly tagline: string;
	readonly tone: Tone;
	/** What it does, in the owner's words: it goes after the default instructions. */
	readonly job: string;
	/** Its responsabilità in the organigramma. */
	readonly owns: readonly string[];
};

export type Team = {
	readonly key: string;
	readonly name: string;
	/** What the team is for, in one line, for the console. */
	readonly summary: string;
	/** The first one leads: it gets the requests and splits the work. */
	readonly members: readonly [TeamMember, ...TeamMember[]];
};

export const TEAMS: readonly Team[] = [
	{
		key: "contenuti",
		name: "Contenuti",
		summary: "Post, articoli e newsletter: uno pianifica, uno cerca le fonti, uno scrive.",
		members: [
			{ id: "caporedattore", name: "Caporedattore", tagline: "Pianifica i contenuti e rivede i testi", tone: "naturale", job: "Pianifica post, articoli e newsletter: decide argomento, pubblico, formato e scadenza, fa cercare le fonti, fa scrivere la bozza e la rivede prima di consegnarla. Chiede sempre a chi sono rivolti e che tono usare, se non è detto.", owns: ["Piano editoriale", "Revisione dei testi prima della consegna"] },
			{ id: "ricercatore", name: "Ricercatore", tagline: "Cerca, confronta e cita le fonti", tone: "conciso", job: "Fa ricerche sul web e nei file per i contenuti: dati, esempi, citazioni e concorrenti, sempre con le fonti. Consegna appunti brevi e verificati, non testi finiti.", owns: ["Fonti, dati e citazioni"] },
			{ id: "scrittore", name: "Scrittore", tagline: "Scrive testi con la nostra voce", tone: "naturale", job: "Scrive e riscrive testi a partire dagli appunti e dalle indicazioni: post, articoli, newsletter, mail. Rispetta lunghezza, tono e pubblico chiesti e non inventa dati che non ha.", owns: ["Bozze di post, articoli, newsletter e mail"] },
		],
	},
	{
		key: "vendite",
		name: "Vendite",
		summary: "Clienti nuovi e preventivi: uno coordina, uno trova e studia i clienti, uno fa i preventivi.",
		members: [
			{ id: "responsabile-vendite", name: "Responsabile vendite", tagline: "Coordina le vendite e i clienti da seguire", tone: "naturale", job: "Coordina le vendite: tiene la lista dei clienti da seguire, decide chi contattare e quando, fa preparare schede cliente e preventivi e prepara le bozze delle mail. Nessuna mail o offerta parte senza l'ok della persona.", owns: ["Clienti da seguire e quando contattarli", "Bozze delle mail ai clienti"] },
			{ id: "ricerca-clienti", name: "Ricerca clienti", tagline: "Trova e studia i clienti", tone: "conciso", job: "Trova aziende adatte e prepara la scheda di ognuna: cosa fa, dimensione, sede, sito, partita IVA controllata, chi decide e perché potrebbe interessarle, con le fonti.", owns: ["Schede dei clienti nuovi"] },
			{ id: "preventivi", name: "Preventivi", tagline: "Offerte, listini e preventivi in attesa", tone: "formale", job: "Prepara i preventivi in Word o Excel e tiene il listino in un file del workspace; totali e IVA li calcola con code_run, mai a mente, e segue quelli in attesa di risposta. Usa solo l'aliquota IVA indicata dalla persona.", owns: ["Preventivi e listino, nei file del workspace", "Preventivi in attesa di risposta"] },
		],
	},
	{
		key: "amministrazione",
		name: "Amministrazione",
		summary: "Fatture, spese, scadenze e cassa: uno coordina, uno tiene i conti, uno l'agenda e i rinnovi.",
		members: [
			{ id: "responsabile-amministrativo", name: "Responsabile amministrativo", tagline: "Coordina conti, scadenze e documenti", tone: "formale", job: "Coordina l'amministrazione: fa il punto su fatture da incassare e da pagare, scadenze, rinnovi e cassa, prepara per la persona quello che deve decidere o firmare e raccoglie il materiale per il commercialista.", owns: ["Punto su incassi, pagamenti e scadenze", "Materiale per il commercialista"] },
			{ id: "contabile", name: "Contabile", tagline: "Fatture, spese, ore e cassa", tone: "conciso", job: "Tiene i conti sui file del workspace: le fatture, le spese, le ore e i movimenti in CSV o Excel che la persona manda o che prepara lui, e i solleciti in bozza. Ogni conto con code_run, mai a mente.", owns: ["Fatture e scadenze", "Spese e cassa", "Ore di lavoro"] },
			{ id: "assistente-ufficio", name: "Assistente d'ufficio", tagline: "Agenda, mail, rinnovi e promemoria", tone: "amichevole", job: "Segue agenda, mail, rinnovi e abbonamenti, promemoria e liste dell'ufficio, e ricorda le scadenze per tempo.", owns: ["Agenda e mail dell'ufficio", "Rinnovi, abbonamenti e promemoria"] },
		],
	},
];

export function team(key: string): Team | undefined {
	return TEAMS.find((t) => t.key === key);
}

/**
 * The squadra in the organigramma (ADR 0117), once its agenti are made with these IDs (in the
 * team's order): its own ID and name, free ones if taken, the first member coordinating, the
 * others answering to it. What they are told about it comes from there, not from their instructions.
 */
export function withTeam(org: Org, t: Team, members: readonly { readonly id: string }[]): Org {
	let n = 1;
	const taken = (id: string, name: string) => org.teams.some((x) => x.id === id || x.name.toLowerCase() === name.toLowerCase());
	while (taken(n === 1 ? t.key : `${t.key}-${n}`, n === 1 ? t.name : `${t.name} ${n}`)) n += 1;
	const id = n === 1 ? t.key : `${t.key}-${n}`;
	const lead = (members[0] as { id: string }).id;
	const agents: Record<string, OrgPlace> = { ...org.agents };
	for (const [i, m] of members.entries()) {
		const spec = t.members[i] as TeamMember;
		agents[m.id] = { role: spec.name, team: id, ...(i === 0 ? {} : { reportsTo: lead }), owns: spec.owns };
	}
	return { teams: [...org.teams, { id, name: n === 1 ? t.name : `${t.name} ${n}`, purpose: t.summary, lead }], agents };
}

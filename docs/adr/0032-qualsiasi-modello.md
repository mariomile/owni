# Qualsiasi modello AI, scelto dall'owner

Owni girava solo su Anthropic o OpenAI, e il modello lo sceglieva chi gestisce il server, una volta, con `OWNI_MODEL_PROVIDER` e `OWNI_MODEL_ID`. Chi usa Owni vuole scegliere: Claude per scrivere, Gemini perché costa poco, Grok, Mistral perché è europeo, DeepSeek o Kimi, o tutti quelli di OpenRouter con una chiave sola. Owni è l'alternativa a Grok che non ti lega a un modello.

## Decisione

- **Un catalogo dei provider offerti** in `src/core/model-providers.ts`: diciotto provider (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Moonshot, Z.AI, MiniMax, Meta, OpenRouter, Vercel AI Gateway, Groq, Cerebras, Together, Fireworks, Hugging Face, NVIDIA), ciascuno con il nome, la variabile della chiave e il modello di partenza. È una scelta di prodotto, nel core e senza Pi.
- **I modelli li conosce pi-ai.** L'adapter (`pi-durable-models.ts`) costruisce ogni provider e ne elenca i modelli come dati semplici: nome, se guarda le foto, se ragiona, contesto e prezzi. Nessun elenco di modelli scritto a mano da tenere aggiornato: si aggiorna con pi-ai. Un test controlla che ogni provider del catalogo esista nell'adapter e abbia il suo modello di partenza.
- **L'owner sceglie in Impostazioni → Modello AI**: provider, modello, e la sua chiave se il server non ce l'ha. Per i provider con centinaia di modelli (OpenRouter, Vercel) c'è una casella per cercarli.
- **Anche le chat vecchie cambiano modello.** Pi Durable ricorda in ogni conversazione il modello e le istruzioni con cui è nata. Quando l'istanza si riapre, la prima volta che una conversazione riceve un messaggio prende il modello e le istruzioni dell'istanza; la cronologia resta. Senza, una chat nata con un provider resterebbe senza modello dopo il cambio (e le istruzioni cambiate in Impostazioni non arrivavano alle chat già aperte).
- **Quando vale.** Il cambio riapre l'istanza: chiude quella aperta e la riapre con il nuovo modello, come dopo un riavvio. Una risposta già in corso viene ripresa dalla nuova istanza e finisce con il nuovo modello.
- **Le chiavi del server.** Ogni chiave nell'ambiente va nel secret store all'avvio, così l'owner può passare a quei provider senza chiave sua. La chiave di un provider che il server ha non si sostituisce e non si toglie dalla console: è dell'operatore. Se l'operatore toglie una variabile, al riavvio dopo la chiave sparisce anche dal secret store (Owni tiene l'elenco dei provider che aveva dal server); una chiave che l'owner aveva salvato per un provider mai dato dal server resta.

| `OWNI_MODEL_PROVIDER` | Provider | Chiave | Dominio |
|---|---|---|---|
| `anthropic` | Anthropic (Claude) | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai` | OpenAI (GPT) | `OPENAI_API_KEY` | `api.openai.com` |
| `google` | Google (Gemini) | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` |
| `xai` | xAI (Grok) | `XAI_API_KEY` | `api.x.ai` |
| `mistral` | Mistral | `MISTRAL_API_KEY` | `api.mistral.ai` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `moonshotai` | Moonshot (Kimi) | `MOONSHOT_API_KEY` | `api.moonshot.ai` |
| `zai` | Z.AI (GLM) | `ZAI_API_KEY` | `api.z.ai` |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | `api.minimax.io` |
| `meta` | Meta (Muse) | `META_API_KEY` | `api.meta.ai` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai` |
| `vercel-ai-gateway` | Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `ai-gateway.vercel.sh` |
| `groq` | Groq | `GROQ_API_KEY` | `api.groq.com` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` | `api.cerebras.ai` |
| `together` | Together AI | `TOGETHER_API_KEY` | `api.together.ai` |
| `fireworks` | Fireworks | `FIREWORKS_API_KEY` | `api.fireworks.ai` |
| `huggingface` | Hugging Face | `HF_TOKEN` | `router.huggingface.co` |
| `nvidia` | NVIDIA | `NVIDIA_API_KEY` | `integrate.api.nvidia.com` |


## Sicurezza

- Solo l'owner vede e cambia il modello. La chiave va dalla pagina al secret store del tenant e non torna mai indietro: l'API dice solo «del server», «salvata» o «manca». L'audit registra il cambio di modello e il nome del segreto, mai il valore.
- Scegliere un provider lo aggiunge alla policy di egress dell'istanza, accanto a quelli già consentiti: è un'azione esplicita dell'owner. Il motore riceve solo la chiave dei provider consentiti, come prima.
- Il modello deve essere nel catalogo di quel provider; il modello locale di prova non si sceglie dalla console.
- Una chiave salvata si toglie solo se nessuna istanza usa quel provider come modello. La segreteria commerciale non conta: usa sempre la chiave Anthropic del server.
- Su Owni Cloud l'owner di ogni cella può usare le chiavi date dall'operatore con qualsiasi modello di quel provider: l'operatore dà solo le chiavi dei provider che vuole pagare. Il tetto di spesa giornaliero (ADR 0010) vale per tutti i modelli.
- Le chiavi stanno nel file dei segreti del tenant (0600), non cifrato, come le altre (architettura.md).

## Alternative scartate

- **Un elenco di modelli nostro.** Invecchia ogni mese; pi-ai lo aggiorna con i prezzi.
- **Un endpoint compatibile OpenAI con indirizzo libero** (Ollama, LM Studio, vLLM). Utile in locale, ma su Owni Cloud aprirebbe la cella verso qualsiasi indirizzo. Si potrà fare per i server senza celle, con l'indirizzo scelto dall'operatore.
- **Bedrock, Azure, Vertex.** Vogliono più di una chiave (regione, progetto, credenziali cloud): restano per ora fuori.
- **Il modello per singola chat.** Il motore apre una sessione per istanza con un modello; cambiarlo a metà conversazione è il passo successivo.

## Conseguenze

- `pnpm owni check` prova la chiave di Anthropic e OpenAI chiedendo l'elenco dei modelli; per gli altri provider dice che la chiave c'è e la verifica la prima risposta. Controlla il modello di `OWNI_MODEL_*`, non quello che l'owner ha scelto poi dalla console.
- La segreteria commerciale resta su Anthropic: con lei accesa serve `ANTHROPIC_API_KEY` anche se l'istanza principale usa un altro provider.
- Le celle di Owni Cloud ricevono tutte le variabili delle chiavi dei provider.

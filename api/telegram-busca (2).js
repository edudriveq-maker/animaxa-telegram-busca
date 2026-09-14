// ANIMAXA — bot de BUSCA por #filme (ou #anime / #serie), rodando como
// Vercel Serverless Function (webhook do Telegram). Projeto TOTALMENTE
// separado do site (que continua na Netlify) — só consome o catálogo do
// Firestore (leitura pública) e o backup público do site via HTTP, sem
// precisar de nenhum acesso à Netlify PARA LEITURA.
//
// ===================== NOVIDADE (auto-adicionar) =====================
//
// Quando alguém pede um #filme/#anime/#serie que NÃO está no catálogo,
// o bot agora:
//   1) Busca o título no TMDB.
//   2) Manda a capa encontrada NO PRÓPRIO GRUPO, perguntando pro usuário
//      que pediu "é esse?" com botões [✅ É esse!] [❌ Não é].
//   3) Só quem pediu pode apertar os botões (confere o ID do Telegram).
//   4) Se confirmar, o bot loga como admin no Firebase (mesma conta que
//      você usa no admin.html) e grava o título direto no Firestore —
//      filme vira 1 documento; série/anime importa temporadas/episódios
//      também, do jeito que o "Importar do IMDb" do admin.html faz.
//   5) Edita a própria mensagem no grupo avisando "✅ Adicionado!" com um
//      botão "Assistir no site" — isso já serve de aviso pro grupo, não
//      manda mensagem duplicada.
//
// IMPORTANTE — limite de tempo da função (Vercel):
// Séries/animes grandes (muitas temporadas) podem ter dezenas ou centenas
// de episódios. Gravar cada episódio é 1 requisição ao Firestore, então
// séries enormes podem não terminar dentro do tempo de execução da função
// (10s no plano Hobby, 60s+ no Pro). Por isso o import é limitado a
// LIMITE_TEMPORADAS temporadas e LIMITE_EPS_POR_TEMPORADA episódios por
// temporada (ajuste abaixo se precisar). Se faltar episódio, o bot avisa
// no próprio card e você completa o resto pelo admin.html normalmente —
// nada quebra, só fica parcial.
//
// IMPORTANTE — conta de admin:
// FIREBASE_ADMIN_EMAIL/FIREBASE_ADMIN_PASSWORD precisam ser o e-mail e a
// senha de uma conta que já está liberada em firestore.rules (isAdmin()).
// É a MESMA conta com que você loga no admin.html — o bot só está fazendo
// login com e-mail/senha por baixo dos panos (mesma forma que o site faz).
//
// ===================== ESTRUTURA DO PROJETO =====================
//
// Crie um repositório NOVO no GitHub (separado do repositório do site),
// só pra esse bot, com esta estrutura:
//
//   meu-bot-busca/
//     package.json
//     api/
//       telegram-busca.js   <- este arquivo
//
// package.json (mínimo necessário):
//   {
//     "name": "animaxa-telegram-busca",
//     "version": "1.0.0",
//     "type": "module"
//   }
//
// ===================== DEPLOY NA VERCEL =====================
//
// 1) Suba esse repositório novo pro GitHub.
// 2) Entre em vercel.com, faça login com sua conta do GitHub, e clique em
//    "Add New… > Project", escolhendo esse repositório novo.
// 3) Antes de clicar em Deploy, vá em "Environment Variables" e adicione:
//      TELEGRAM_BUSCA_BOT_TOKEN -> token do bot (do @BotFather)
//      TELEGRAM_GRUPO_ID        -> (opcional, recomendado) ID do grupo
//      TELEGRAM_ADMIN_CHAT_ID   -> (opcional) seu chat privado com o bot,
//                                   só usado quando NEM o catálogo NEM o
//                                   TMDB acham o título (pedido manual)
//      TMDB_READ_TOKEN          -> Read Access Token do TMDB (o mesmo que
//                                   está em admin.html, ou gere um novo em
//                                   https://www.themoviedb.org/settings/api
//      FIREBASE_ADMIN_EMAIL     -> e-mail da conta admin (a mesma do
//                                   admin.html, liberada em firestore.rules)
//      FIREBASE_ADMIN_PASSWORD  -> senha dessa conta
// 4) Clique em Deploy. Quando terminar, a Vercel te dá uma URL tipo:
//      https://animaxa-telegram-busca.vercel.app
//    A função fica acessível em:
//      https://animaxa-telegram-busca.vercel.app/api/telegram-busca
//
// 5) Registre o webhook (uma vez só), trocando TOKEN e a URL acima:
//
//    curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://animaxa-telegram-busca.vercel.app/api/telegram-busca"
//
//    Pra conferir:
//    curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
//
// 6) Adicione o bot no grupo, com permissão de enviar mensagens.
//
// Se esse bot já teve um webhook configurado antes (ex: tentativa com
// Netlify) ou já rodou em polling (getUpdates) via GitHub Actions, rode
// "deleteWebhook" antes de configurar o novo, e desative o workflow do
// GitHub Actions pra não ficar com dois bots respondendo ao mesmo tempo:
//    curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

const PROJECT_ID = "anima-65cc3";
const API_KEY = "AIzaSyDXwUdq1SIQdwqsWJZc5wq0KTqpN9V9Cs0";
const SITE_URL = "https://animaxabrasil.netlify.app";
const FIRESTORE_DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CATALOGO_BACKUP_URL = `${SITE_URL}/.netlify/functions/catalogo-backup`;
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";

const BOT_TOKEN = process.env.TELEGRAM_BUSCA_BOT_TOKEN;
const GRUPO_ID = process.env.TELEGRAM_GRUPO_ID || null; // opcional, mas recomendado
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || null; // seu chat privado com o bot, só usado quando nem o catálogo nem o TMDB acham nada
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || null;
const FIREBASE_ADMIN_EMAIL = process.env.FIREBASE_ADMIN_EMAIL || null;
const FIREBASE_ADMIN_PASSWORD = process.env.FIREBASE_ADMIN_PASSWORD || null;

const PAGINA_FIRESTORE = 300;

// Limites do import automático de série/anime — ver comentário lá em cima
// sobre o tempo de execução da função na Vercel.
const LIMITE_TEMPORADAS = 6;
const LIMITE_EPS_POR_TEMPORADA = 30;
const PAUSA_ENTRE_EPISODIOS_MS = 60;

const ALVOS = {
  "#filme": { colecao: "movies", pagina: "filme.html", emoji: "🍿", rotulo: "Filme" },
  "#anime": { colecao: "animes", pagina: "anime.html", emoji: "🎌", rotulo: "Anime" },
  "#serie": { colecao: "series", pagina: "serie.html", emoji: "📺", rotulo: "Série" },
  "#série": { colecao: "series", pagina: "serie.html", emoji: "📺", rotulo: "Série" },
};

const LIMIAR_SIMILARIDADE = 0.72;

// ===================== HELPERS (Firestore) =====================

function texto(campo) {
  return campo?.stringValue ?? "";
}

function idDoDoc(doc) {
  return doc.name.split("/").pop();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listarColecaoCompleta(colecao) {
  const docs = [];
  let cursorAtual = null;

  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: colecao }],
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
      limit: PAGINA_FIRESTORE,
    };
    if (cursorAtual) {
      structuredQuery.startAt = { values: [cursorAtual], before: false };
    }

    let res;
    let corpoErro = "";
    const TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      res = await fetch(`${FIRESTORE_DOCS}:runQuery?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structuredQuery }),
      });
      if (res.ok) break;
      if ((res.status === 429 || res.status === 503) && tentativa < TENTATIVAS) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * tentativa));
        continue;
      }
      corpoErro = await res.text().catch(() => "");
      break;
    }
    if (!res.ok) {
      throw new Error(
        `Firestore (runQuery) respondeu ${res.status} ${res.statusText} para "${colecao}": ${corpoErro.slice(0, 300)}`
      );
    }

    const json = await res.json();
    const pagina = (Array.isArray(json) ? json : [])
      .filter((item) => item && item.document)
      .map((item) => item.document);

    docs.push(...pagina);

    if (pagina.length < PAGINA_FIRESTORE) break; // acabou

    const ultimo = pagina[pagina.length - 1];
    const proximoCursor = ultimo.fields?.createdAt;
    if (!proximoCursor) break; // sem createdAt não dá pra paginar com segurança
    cursorAtual = proximoCursor;
  }

  return docs;
}

let backupCache = null;
async function buscarBackupCatalogo() {
  if (!backupCache) {
    backupCache = fetch(CATALOGO_BACKUP_URL).then((res) => {
      if (!res.ok) throw new Error(`Backup do catálogo respondeu ${res.status}`);
      return res.json();
    });
  }
  return backupCache;
}

function valorParaCampoFirestore(valor) {
  if (valor == null) return { nullValue: null };
  if (typeof valor === "boolean") return { booleanValue: valor };
  if (typeof valor === "number") {
    return Number.isInteger(valor) ? { integerValue: String(valor) } : { doubleValue: valor };
  }
  if (Array.isArray(valor)) return { arrayValue: { values: valor.map(valorParaCampoFirestore) } };
  return { stringValue: String(valor) };
}

function docViaBackup(item, colecao) {
  const { id, ...campos } = item;
  const fields = {};
  for (const [chave, valor] of Object.entries(campos)) {
    fields[chave] = chave === "createdAt" || chave === "updatedAt"
      ? { timestampValue: valor }
      : valorParaCampoFirestore(valor);
  }
  return { name: `projects/${PROJECT_ID}/databases/(default)/documents/${colecao}/${id}`, fields };
}

async function listarColecaoViaBackup(colecao) {
  const backup = await buscarBackupCatalogo();
  return (backup[colecao] || []).map((item) => docViaBackup(item, colecao));
}

async function listarColecao(colecao) {
  // Ordem invertida de propósito: o backup é um arquivo estático servido
  // pela Netlify (sem nenhum custo de leitura no Firestore), então é a
  // fonte principal. O Firestore ao vivo só entra como fallback — se a
  // cota diária estiver estourada, ele falharia mesmo, então nem vale a
  // pena tentar primeiro.
  try {
    return await listarColecaoViaBackup(colecao);
  } catch (errBackup) {
    console.error(`[telegram-busca] Backup falhou pra "${colecao}": ${errBackup.message}`);
    try {
      return await listarColecaoCompleta(colecao);
    } catch (errFirestore) {
      throw new Error(`Backup: ${errBackup.message} | Firestore: ${errFirestore.message}`);
    }
  }
}

// ===================== BUSCA POR TÍTULO (no catálogo já cadastrado) =====

function normalizar(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const linha = new Array(n + 1);
  for (let j = 0; j <= n; j++) linha[j] = j;

  for (let i = 1; i <= m; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = linha[j];
      linha[j] = a[i - 1] === b[j - 1]
        ? anterior
        : 1 + Math.min(anterior, linha[j], linha[j - 1]);
      anterior = temp;
    }
  }
  return linha[n];
}

function similaridade(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function melhorMatch(docs, queryNormalizada) {
  let melhor = null;
  let melhorScore = 0;

  for (const doc of docs) {
    const titulo = texto(doc.fields?.title);
    if (!titulo) continue;
    const tituloNormalizado = normalizar(titulo);

    let score;
    if (tituloNormalizado === queryNormalizada) {
      score = 1;
    } else if (
      tituloNormalizado.includes(queryNormalizada) ||
      queryNormalizada.includes(tituloNormalizado)
    ) {
      score = 0.9;
    } else {
      score = similaridade(tituloNormalizado, queryNormalizada);
    }

    if (score > melhorScore) {
      melhorScore = score;
      melhor = doc;
    }
  }

  return melhorScore >= LIMIAR_SIMILARIDADE ? melhor : null;
}

async function buscarTitulo(gatilho, nomeBuscado) {
  const alvo = ALVOS[gatilho];
  const docs = await listarColecao(alvo.colecao);
  const encontrado = melhorMatch(docs, normalizar(nomeBuscado));
  if (!encontrado) return null;

  const id = idDoDoc(encontrado);
  const f = encontrado.fields || {};
  return {
    titulo: texto(f.title) || nomeBuscado,
    capa: texto(f.coverUrl),
    link: `${SITE_URL}/${alvo.pagina}?id=${encodeURIComponent(id)}`,
    emoji: alvo.emoji,
    rotulo: alvo.rotulo,
  };
}

// ===================== TMDB (achar candidato pra título não cadastrado) =

function tmdbConfigurado() {
  return Boolean(TMDB_READ_TOKEN);
}

function tmdbHeaders() {
  return { Authorization: `Bearer ${TMDB_READ_TOKEN}`, accept: "application/json" };
}

async function tmdbBuscar(tipo, titulo) {
  // tipo: "movie" | "tv"
  const url = `https://api.themoviedb.org/3/search/${tipo}?language=pt-BR&query=${encodeURIComponent(titulo)}`;
  const res = await fetch(url, { headers: tmdbHeaders() });
  if (res.status === 401) throw new Error("TMDB 401 — TMDB_READ_TOKEN inválido/expirado.");
  if (res.status === 429) throw new Error("TMDB 429 — rate limit, tente de novo em instantes.");
  if (!res.ok) throw new Error(`TMDB search/${tipo} respondeu ${res.status}`);
  const data = await res.json();
  return data.results?.[0] || null;
}

// Busca no TMDB um candidato pro título que não foi achado no catálogo.
// Retorna null se TMDB não estiver configurado ou não achar nada — nesses
// casos o chamador cai de volta pro fluxo antigo (registra pedido).
async function buscarCandidatoTmdb(gatilho, nomeBuscado) {
  if (!tmdbConfigurado()) return null;

  if (gatilho === "#filme") {
    const achado = await tmdbBuscar("movie", nomeBuscado);
    if (!achado) return null;
    return {
      kindCode: "f",
      tmdbId: achado.id,
      titulo: achado.title || achado.original_title || nomeBuscado,
      tituloOriginal: nomeBuscado,
      ano: (achado.release_date || "").slice(0, 4),
      poster: achado.poster_path ? `${TMDB_IMG_BASE}${achado.poster_path}` : "",
      emoji: "🍿",
    };
  }

  const alvo = ALVOS[gatilho];
  const kindCode = gatilho === "#anime" ? "a" : "s";
  const achado = await tmdbBuscar("tv", nomeBuscado);
  if (!achado) return null;
  return {
    kindCode,
    tmdbId: achado.id,
    titulo: achado.name || achado.original_name || nomeBuscado,
    tituloOriginal: nomeBuscado,
    ano: (achado.first_air_date || "").slice(0, 4),
    poster: achado.poster_path ? `${TMDB_IMG_BASE}${achado.poster_path}` : "",
    emoji: alvo.emoji,
  };
}

// ===================== SLUG (mesma lógica de assets/slug-utils.js) =====

function slugify(t) {
  return String(t || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function slugUnico(base, usados) {
  if (!usados.has(base)) return base;
  let n = 2;
  let candidato = `${base}-${n}`;
  while (usados.has(candidato)) {
    n++;
    candidato = `${base}-${n}`;
  }
  return candidato;
}

// ===================== FIRESTORE — ESCRITA (precisa login de admin) ====
//
// Diferente das leituras acima (públicas, com API_KEY), criar documento
// exige que request.auth.token.email seja uma das contas liberadas em
// firestore.rules. Por isso a gente loga com e-mail/senha (mesma conta do
// admin.html) via API do Firebase Auth pra conseguir um idToken, e manda
// esse idToken como Bearer nas escritas do Firestore.

async function obterIdTokenAdmin() {
  if (!FIREBASE_ADMIN_EMAIL || !FIREBASE_ADMIN_PASSWORD) {
    throw new Error("Configure FIREBASE_ADMIN_EMAIL e FIREBASE_ADMIN_PASSWORD na Vercel.");
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: FIREBASE_ADMIN_EMAIL,
        password: FIREBASE_ADMIN_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Login do admin no Firebase falhou: ${json.error?.message || res.status}`);
  }
  return json.idToken;
}

function camposFirestore(obj, chavesTimestamp = []) {
  const fields = {};
  for (const [chave, valor] of Object.entries(obj)) {
    fields[chave] = chavesTimestamp.includes(chave)
      ? { timestampValue: valor }
      : valorParaCampoFirestore(valor);
  }
  return fields;
}

async function criarDocumento(colecao, campos, chavesTimestamp, idToken) {
  const fields = camposFirestore(campos, chavesTimestamp);
  const res = await fetch(`${FIRESTORE_DOCS}/${colecao}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Firestore recusou criar em "${colecao}": ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json.name.split("/").pop();
}

// ===================== ADICIONAR AO CATÁLOGO (após confirmação) ========

async function adicionarFilme(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?language=pt-BR&append_to_response=external_ids`;
  const res = await fetch(url, { headers: tmdbHeaders() });
  if (!res.ok) throw new Error(`TMDB movie/${tmdbId} respondeu ${res.status}`);
  const d = await res.json();

  const imdbId = d.external_ids?.imdb_id;
  if (!imdbId) throw new Error("esse filme não tem IMDb ID cadastrado no TMDB");

  const docsAtuais = await listarColecao("movies");
  const slugsUsados = new Set(docsAtuais.map((doc) => texto(doc.fields?.slug)).filter(Boolean));
  const slug = slugUnico(slugify(d.title || d.original_title || String(tmdbId)), slugsUsados);

  const idToken = await obterIdTokenAdmin();
  const agora = new Date().toISOString();

  const docId = await criarDocumento(
    "movies",
    {
      title: d.title || d.original_title || "",
      synopsis: (d.overview || "").trim(),
      genres: (d.genres || []).map((g) => g.name).filter(Boolean),
      coverUrl: d.poster_path ? `${TMDB_IMG_BASE}${d.poster_path}` : "",
      backdropUrl: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : "",
      category: "lancamento",
      tmdbId: String(tmdbId),
      videoUrl: `<iframe src="https://vidsrcme.ru/embed/movie/${imdbId}" width="100%" height="560" frameborder="0" allowfullscreen></iframe>`,
      rating: d.vote_average || 0,
      slug,
      createdAt: agora,
      updatedAt: agora,
    },
    ["createdAt", "updatedAt"],
    idToken
  );

  return {
    titulo: d.title || d.original_title || "",
    link: `${SITE_URL}/filme.html?id=${docId}`,
  };
}

async function adicionarSerieOuAnime(tmdbId, tipo) {
  const colecao = tipo === "anime" ? "animes" : "series";
  const colecaoEpisodios = tipo === "anime" ? "episodes" : "seriesEpisodes";
  const pagina = tipo === "anime" ? "anime.html" : "serie.html";

  const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?language=pt-BR`, { headers: tmdbHeaders() });
  if (!res.ok) throw new Error(`TMDB tv/${tmdbId} respondeu ${res.status}`);
  const d = await res.json();

  const docsAtuais = await listarColecao(colecao);
  const slugsUsados = new Set(docsAtuais.map((doc) => texto(doc.fields?.slug)).filter(Boolean));
  const slug = slugUnico(slugify(d.name || d.original_name || String(tmdbId)), slugsUsados);

  const idToken = await obterIdTokenAdmin();
  const agora = new Date().toISOString();

  const camposBase = {
    title: d.name || d.original_name || "",
    synopsis: (d.overview || "").trim(),
    genres: (d.genres || []).map((g) => g.name).filter(Boolean),
    coverUrl: d.poster_path ? `${TMDB_IMG_BASE}${d.poster_path}` : "",
    backdropUrl: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : "",
    category: "lancamento",
    rating: d.vote_average || 0,
    slug,
    createdAt: agora,
    updatedAt: agora,
  };
  // Anime na Animaxa não guarda tmdbId (mesmo schema do addAnime do
  // admin.html); série guarda, pra permitir "pular duplicado" no import
  // em massa do admin.html mais tarde.
  if (tipo === "serie") camposBase.tmdbId = String(tmdbId);

  const docId = await criarDocumento(colecao, camposBase, ["createdAt", "updatedAt"], idToken);

  // Anime na Animaxa é tratado como "maratona única" (episódio numerado
  // sequencialmente, sem campo de temporada) — ver assets/firebase-client.js.
  // Série guarda temporada + número, igual o import em massa do admin.html.
  let temporadas = (d.seasons || [])
    .filter((s) => s.episode_count > 0 && s.season_number !== 0) // pula "Especiais" (temporada 0)
    .slice(0, LIMITE_TEMPORADAS);

  let numeroGlobal = 0;
  let episodiosAdicionados = 0;
  let episodiosEsperados = 0;

  for (const temporada of temporadas) {
    const num = temporada.season_number;
    episodiosEsperados += Math.min(temporada.episode_count || 0, LIMITE_EPS_POR_TEMPORADA);

    let episodiosDaTemporada = [];
    try {
      const rEp = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${num}?language=pt-BR`,
        { headers: tmdbHeaders() }
      );
      if (rEp.ok) {
        const dEp = await rEp.json();
        episodiosDaTemporada = (dEp.episodes || []).slice(0, LIMITE_EPS_POR_TEMPORADA);
      }
    } catch (e) {
      console.error(`[telegram-busca] Falha ao buscar temporada ${num}:`, e.message);
    }

    for (const ep of episodiosDaTemporada) {
      numeroGlobal++;
      const epNum = ep.episode_number;
      const epTitulo = (ep.name && ep.name.trim()) || `Episódio ${epNum}`;
      const videoUrl = `<iframe src="https://vidsrcme.ru/embed/tv/${tmdbId}/${num}/${epNum}" width="100%" height="560" frameborder="0" allowfullscreen></iframe>`;

      const camposEp = tipo === "anime"
        ? { animeId: docId, number: numeroGlobal, title: epTitulo, videoUrl, createdAt: agora }
        : { seriesId: docId, season: num, number: epNum, title: epTitulo, videoUrl, createdAt: agora };

      try {
        await criarDocumento(colecaoEpisodios, camposEp, ["createdAt"], idToken);
        episodiosAdicionados++;
      } catch (e) {
        console.error(`[telegram-busca] Falha ao salvar episódio T${num}E${epNum}:`, e.message);
      }

      if (PAUSA_ENTRE_EPISODIOS_MS > 0) await dormir(PAUSA_ENTRE_EPISODIOS_MS);
    }
  }

  return {
    titulo: d.name || d.original_name || "",
    link: `${SITE_URL}/${pagina}?id=${docId}`,
    episodiosAdicionados,
    episodiosEsperados,
  };
}

// ===================== TELEGRAM =====================

async function chamarTelegram(metodo, corpo) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    console.error(`[telegram-busca] Telegram recusou ${metodo}:`, json.description || res.status);
  }
  return json;
}

async function responderEncontrado(chatId, resultado) {
  const legenda = `${resultado.emoji} <b>${escapeHtml(resultado.titulo)}</b>\n${resultado.rotulo} encontrado!`;
  const teclado = { inline_keyboard: [[{ text: "▶️ Assistir no site", url: resultado.link }]] };

  if (resultado.capa) {
    await chamarTelegram("sendPhoto", {
      chat_id: chatId,
      photo: resultado.capa,
      caption: legenda,
      parse_mode: "HTML",
      reply_markup: teclado,
    });
  } else {
    await chamarTelegram("sendMessage", {
      chat_id: chatId,
      text: legenda,
      parse_mode: "HTML",
      reply_markup: teclado,
    });
  }
}

// ---- confirmação com o usuário (título não achado no catálogo, mas
// achado no TMDB) ----

async function enviarConfirmacao(chatId, candidato, usuario) {
  const identificacao = usuario.username ? `@${usuario.username}` : usuario.first_name || "você";
  const anoTxt = candidato.ano ? ` (${candidato.ano})` : "";
  const legenda =
    `🔎 Não achei <b>${escapeHtml(candidato.tituloOriginal)}</b> no catálogo, mas encontrei isso no TMDB:\n\n` +
    `${candidato.emoji} <b>${escapeHtml(candidato.titulo)}</b>${anoTxt}\n\n` +
    `É esse, ${escapeHtml(identificacao)}?`;

  // callback_data carrega só o essencial (tipo, tmdbId e quem pode
  // confirmar) — dá pra reconstruir tudo de novo consultando o TMDB de
  // novo quando o botão for apertado, sem precisar guardar estado em
  // lugar nenhum entre as duas mensagens.
  const teclado = {
    inline_keyboard: [[
      { text: "✅ É esse!", callback_data: `cfy:${candidato.kindCode}:${candidato.tmdbId}:${usuario.id}` },
      { text: "❌ Não é", callback_data: `cfn:${usuario.id}` },
    ]],
  };

  if (candidato.poster) {
    await chamarTelegram("sendPhoto", {
      chat_id: chatId,
      photo: candidato.poster,
      caption: legenda,
      parse_mode: "HTML",
      reply_markup: teclado,
    });
  } else {
    await chamarTelegram("sendMessage", {
      chat_id: chatId,
      text: legenda,
      parse_mode: "HTML",
      reply_markup: teclado,
    });
  }
}

// Edita a mensagem de confirmação (que pode ter sido mandada como foto OU
// como texto, dependendo se o TMDB tinha capa) — tenta como legenda de
// foto primeiro, cai pra texto se a mensagem original não tinha foto.
async function editarResultadoConfirmacao(chatId, messageId, texto, replyMarkup) {
  const resp = await chamarTelegram("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption: texto,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
  if (resp.ok === false) {
    await chamarTelegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }
}

async function responderCallback(callbackQueryId, texto, mostrarAlerta) {
  await chamarTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: texto,
    show_alert: Boolean(mostrarAlerta),
  });
}

async function notificarPedidoAdmin(msg, nomeBuscado) {
  if (!ADMIN_CHAT_ID) {
    console.error("[telegram-busca] TELEGRAM_ADMIN_CHAT_ID não configurado, pedido não notificado.");
    return;
  }

  const usuario = msg.from || {};
  const identificacao = usuario.username ? `@${usuario.username}` : usuario.first_name || "alguém";
  const nomeChat = msg.chat?.title || "chat privado";

  await chamarTelegram("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `📩 <b>Novo pedido</b>\n\n` +
      `🎬 Título: <b>${escapeHtml(nomeBuscado)}</b>\n` +
      `👤 Pedido por: ${escapeHtml(identificacao)}\n` +
      `💬 Grupo: ${escapeHtml(nomeChat)}`,
    parse_mode: "HTML",
  });
}

async function responderNaoEncontrado(chatId, gatilho, nomeBuscado, usuario) {
  const identificacao = usuario.username ? `@${usuario.username}` : usuario.first_name || "alguém";
  const rotulo = ALVOS[gatilho]?.rotulo || "Título";

  await chamarTelegram("sendMessage", {
    chat_id: chatId,
    text:
      `❌ Não encontrei <b>${escapeHtml(nomeBuscado)}</b> (${rotulo}) no catálogo nem no TMDB.\n\n` +
      `📩 Pedido registrado! Pedido por: ${escapeHtml(identificacao)}`,
    parse_mode: "HTML",
  });
}

// Título não achado no catálogo -> tenta achar candidato no TMDB pra
// confirmar com o usuário; se não achar nada em lugar nenhum, cai pro
// fluxo antigo (só avisa que o pedido foi registrado).
async function tratarNaoEncontrado(gatilho, nomeBuscado, msg) {
  const chatId = msg.chat.id;

  try {
    const candidato = await buscarCandidatoTmdb(gatilho, nomeBuscado);
    if (candidato) {
      await enviarConfirmacao(chatId, candidato, msg.from);
      return;
    }
  } catch (errTmdb) {
    console.error("[telegram-busca] Busca no TMDB falhou:", errTmdb.message);
  }

  await responderNaoEncontrado(chatId, gatilho, nomeBuscado, msg.from);
}

// ---- callback_query (usuário apertou um botão de confirmação) ----

async function processarCallback(cq) {
  const dados = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) return;

  if (dados.startsWith("cfn:")) {
    const userIdEsperado = dados.slice(4);
    if (String(cq.from.id) !== userIdEsperado) {
      await responderCallback(cq.id, "Só quem pediu pode responder isso.", true);
      return;
    }
    await responderCallback(cq.id, "Ok, cancelado.");
    await editarResultadoConfirmacao(
      chatId,
      messageId,
      `❌ Ok, não era esse. Manda <code>#pedido NomeCorreto</code> que eu anoto pra gente adicionar depois.`,
      { inline_keyboard: [] }
    );
    return;
  }

  if (dados.startsWith("cfy:")) {
    const [, kindCode, tmdbIdStr, userIdEsperado] = dados.split(":");
    if (String(cq.from.id) !== userIdEsperado) {
      await responderCallback(cq.id, "Só quem pediu pode confirmar isso.", true);
      return;
    }

    await responderCallback(cq.id, "Adicionando...");
    await editarResultadoConfirmacao(chatId, messageId, "⏳ Adicionando ao site, aguenta aí...", {
      inline_keyboard: [],
    });

    const tmdbId = Number(tmdbIdStr);
    try {
      let resultado;
      if (kindCode === "f") {
        resultado = await adicionarFilme(tmdbId);
      } else if (kindCode === "a") {
        resultado = await adicionarSerieOuAnime(tmdbId, "anime");
      } else {
        resultado = await adicionarSerieOuAnime(tmdbId, "serie");
      }

      let legenda = `✅ <b>${escapeHtml(resultado.titulo)}</b> foi adicionado ao site!`;
      if (typeof resultado.episodiosAdicionados === "number") {
        if (resultado.episodiosAdicionados < resultado.episodiosEsperados) {
          legenda +=
            `\n📼 ${resultado.episodiosAdicionados} de ${resultado.episodiosEsperados} episódio(s) importado(s) ` +
            `(faltou tempo pra terminar — complete o resto pelo admin.html).`;
        } else {
          legenda += `\n📼 ${resultado.episodiosAdicionados} episódio(s) importado(s).`;
        }
      }

      await editarResultadoConfirmacao(chatId, messageId, legenda, {
        inline_keyboard: [[{ text: "▶️ Assistir no site", url: resultado.link }]],
      });
    } catch (err) {
      console.error("[telegram-busca] Erro ao adicionar automaticamente:", err.message);
      await editarResultadoConfirmacao(
        chatId,
        messageId,
        `⚠️ Não consegui adicionar automaticamente (${escapeHtml(err.message)}). Registrei pra adicionarmos manualmente.`,
        { inline_keyboard: [] }
      );
      if (ADMIN_CHAT_ID) {
        await chamarTelegram("sendMessage", {
          chat_id: ADMIN_CHAT_ID,
          text: `⚠️ Auto-adicionar falhou (tmdbId ${tmdbIdStr}, tipo ${kindCode}): ${escapeHtml(err.message)}`,
          parse_mode: "HTML",
        });
      }
    }
  }
}

// ===================== MENSAGENS DE ERRO =====================

function ehCotaExcedida(mensagemErro) {
  const m = String(mensagemErro).toLowerCase();
  return (
    m.includes("resource_exhausted") ||
    m.includes("quota") ||
    m.includes("429") ||
    m.includes("exceeded")
  );
}

async function avisarErroBusca(chatId, err) {
  if (ehCotaExcedida(err.message)) {
    await chamarTelegram("sendMessage", {
      chat_id: chatId,
      text:
        `⚠️ <b>Bot de busca temporariamente indisponível</b>\n\n` +
        `Estamos trabalhando para normalizar o quanto antes.\n\n` +
        `🌐 Enquanto isso, acesse o catálogo direto pelo site: <a href="${SITE_URL}/catalogo">Catálogo de Animes — Animaxa</a>`,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
    return;
  }

  await chamarTelegram("sendMessage", {
    chat_id: chatId,
    text: `⚠️ Não consegui consultar o catálogo agora.\n<code>${escapeHtml(err.message)}</code>`,
    parse_mode: "HTML",
  });
}

// ===================== HANDLER (Vercel) =====================
//
// Formato de função da Vercel (Node.js runtime): recebe (req, res), bem
// diferente do formato da Netlify (que recebe um único "event"). O corpo
// da requisição já vem parseado em req.body quando o Content-Type é
// application/json (é o que o Telegram manda).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  if (!BOT_TOKEN) {
    console.error("[telegram-busca] Falta configurar TELEGRAM_BUSCA_BOT_TOKEN na Vercel.");
    res.status(200).send("ok");
    return;
  }

  const update = req.body || {};

  // Usuário apertou um botão de confirmação (✅/❌) numa mensagem anterior.
  if (update.callback_query) {
    try {
      await processarCallback(update.callback_query);
    } catch (err) {
      console.error("[telegram-busca] Erro processando callback:", err.message);
    }
    res.status(200).send("ok");
    return;
  }

  const msg = update.message || update.edited_message;
  const texto = msg?.text?.trim();

  if (!msg || !texto) {
    res.status(200).send("ok");
    return;
  }

  if (GRUPO_ID && String(msg.chat.id) !== String(GRUPO_ID)) {
    res.status(200).send("ok");
    return;
  }

  if (texto.toLowerCase().startsWith("#pedido")) {
    const nomePedido = texto.slice("#pedido".length).trim();
    const chatId = msg.chat.id;

    if (!nomePedido) {
      await chamarTelegram("sendMessage", { chat_id: chatId, text: "Uso: #pedido NomeDoTítulo" });
      res.status(200).send("ok");
      return;
    }

    await notificarPedidoAdmin(msg, nomePedido);
    await chamarTelegram("sendMessage", {
      chat_id: chatId,
      text: `📩 Pedido de <b>${escapeHtml(nomePedido)}</b> registrado! Assim que possível, vamos adicionar ao catálogo.`,
      parse_mode: "HTML",
    });

    res.status(200).send("ok");
    return;
  }

  const gatilho = Object.keys(ALVOS).find((g) => texto.toLowerCase().startsWith(g));
  if (!gatilho) {
    res.status(200).send("ok");
    return;
  }

  const nomeBuscado = texto.slice(gatilho.length).trim();
  const chatId = msg.chat.id;

  if (!nomeBuscado) {
    await chamarTelegram("sendMessage", { chat_id: chatId, text: `Uso: ${gatilho} NomeDoTítulo` });
    res.status(200).send("ok");
    return;
  }

  try {
    const resultado = await buscarTitulo(gatilho, nomeBuscado);
    if (resultado) {
      await responderEncontrado(chatId, resultado);
    } else {
      await tratarNaoEncontrado(gatilho, nomeBuscado, msg);
    }
  } catch (err) {
    console.error("[telegram-busca] Erro ao processar busca:", err.message);
    await avisarErroBusca(chatId, err);
  }

  // Sempre responde 200 pro Telegram, senão ele fica reenviando o update.
  res.status(200).send("ok");
}

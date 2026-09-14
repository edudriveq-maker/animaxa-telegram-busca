// ANIMAXA — bot de BUSCA por #filme (ou #anime / #serie), rodando como
// Vercel Serverless Function (webhook do Telegram). Projeto TOTALMENTE
// separado do site (que continua na Netlify) — só consome o catálogo do
// Firestore (leitura pública) e o backup público do site via HTTP, sem
// precisar de nenhum acesso à Netlify.
//
// Diferente da versão em polling (GitHub Actions), aqui o Telegram chama
// essa função direto, em tempo real, assim que alguém manda mensagem no
// grupo.
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
const SITE_URL = "https://animaxaplays.netlify.app";
const FIRESTORE_DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CATALOGO_BACKUP_URL = `${SITE_URL}/.netlify/functions/catalogo-backup`;

const BOT_TOKEN = process.env.TELEGRAM_BUSCA_BOT_TOKEN;
const GRUPO_ID = process.env.TELEGRAM_GRUPO_ID || null; // opcional, mas recomendado
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || null; // seu chat privado com o bot, pra receber os #pedido

const PAGINA_FIRESTORE = 300;

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

// ===================== BUSCA POR TÍTULO =====================

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
      `❌ Não encontrei <b>${escapeHtml(nomeBuscado)}</b> (${rotulo}) no catálogo.\n\n` +
      `📩 Pedido registrado! Pedido por: ${escapeHtml(identificacao)}`,
    parse_mode: "HTML",
  });
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
      await responderNaoEncontrado(chatId, gatilho, nomeBuscado, msg.from);
    }
  } catch (err) {
    console.error("[telegram-busca] Erro ao processar busca:", err.message);
    await avisarErroBusca(chatId, err);
  }

  // Sempre responde 200 pro Telegram, senão ele fica reenviando o update.
  res.status(200).send("ok");
}

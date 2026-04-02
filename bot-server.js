/**
 * WhatsApp Bot — FlowCash Edition (FINAL)
 * Tabela principal: transactions
 * Colunas: id, workspace_id, type, description, category, value, date, source, obs, bank_account_id
 *
 * npm install express axios dotenv
 * node bot-server.js
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json({ limit: "50mb" }));

const C = {
  EVO_URL:       process.env.EVOLUTION_API_URL,
  EVO_KEY:       process.env.EVOLUTION_API_KEY,
  EVO_INSTANCE:  process.env.EVOLUTION_INSTANCE,
  CLAUDE_KEY:    process.env.CLAUDE_API_KEY,
  SUPABASE_URL:  process.env.SUPABASE_URL,         // https://XXXX.supabase.co
  SUPABASE_KEY:  process.env.SUPABASE_SERVICE_KEY, // service_role key
  WORKSPACE_ID:  process.env.WORKSPACE_ID,         // seu workspace_id (uuid)
  CREATED_BY:    process.env.USER_ID,              // seu user id (uuid)
  ALLOWED:       process.env.ALLOWED_NUMBERS?.split(",") || [],
  PORT:          process.env.PORT || 3000,
};

// ─── IDs DAS CONTAS BANCÁRIAS (bank_accounts) ─────────────────────────────────
// Copie os UUIDs reais de: Supabase → bank_accounts
// Ex: SELECT id, name FROM bank_accounts WHERE workspace_id = 'seu-workspace';
const BANK_ACCOUNTS = {
  pix:     process.env.BANK_ID_PIX,      // uuid da conta Pix
  cartao:  process.env.BANK_ID_CARTAO,   // uuid da conta Cartão
  dinheiro:process.env.BANK_ID_DINHEIRO, // uuid da conta Dinheiro
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente financeiro do FlowCash.
Analise mensagens, fotos, prints e PDFs do WhatsApp e extraia os dados financeiros.

TIPOS de transação:
- "entrada" → receita, venda, recebimento, pagamento recebido
- "despesa" → gasto, pagamento feito, custo, saída

MÉTODO DE PAGAMENTO (campo category):
- "Pix" → pix, transferência, ted, doc, pixzinho
- "Cartão" → cartão, crédito, débito, maquininha, card
- "Dinheiro" → dinheiro, espécie, cash, nota, cédula
- null → quando não mencionado

SOURCE (de onde vem o lançamento):
- "Caixa do Dia" → transação do dia, caixa diário, entrada/saída rápida
- "Balanço" → venda formal, despesa registrada, nota fiscal
- "Boleto" → boleto, financiamento, parcela → use tabela boletos separada
- "Custos Fixos" → aluguel, mensalidade, recorrente → use tabela budget_items
- "Custos Variáveis" → matéria-prima, insumo, variável → use tabela budget_items

Responda SOMENTE em JSON válido, sem markdown, sem texto extra.

{
  "tabela": "transactions|boletos|budget_items",
  "confianca": 0.95,
  "resumo": "Descrição curta do registro",
  "dados": {
    "type": "entrada|despesa",
    "description": "descrição do lançamento",
    "category": "Pix|Cartão|Dinheiro|null",
    "value": 150.00,
    "date": "2026-04-01",
    "source": "Caixa do Dia|Balanço|Boleto|Custos Fixos|Custos Variáveis",
    "obs": "observação opcional"
  }
}

Para boletos, use este formato em dados:
{
  "descricao": "nome do boleto",
  "valor_total": 1000.00,
  "num_parcelas": 10,
  "data_vencimento": "2026-05-10",
  "obs": ""
}

Para budget_items (custos fixos/variáveis), use:
{
  "name": "nome do custo",
  "amount": 500.00,
  "category": "categoria",
  "type": "fixed|variable",
  "description": "descrição"
}`;

// ─── CLASSIFICAR COM CLAUDE ───────────────────────────────────────────────────
async function classificar(texto, base64 = null, mimeType = null) {
  const content = [];

  if (base64 && mimeType) {
    if (mimeType.includes("pdf")) {
      content.push({ type: "document", source: { type: "base64", media_type: mimeType, data: base64 } });
    } else if (mimeType.includes("image")) {
      content.push({ type: "image", source: { type: "base64", media_type: mimeType, data: base64 } });
    }
  }

  content.push({
    type: "text",
    text: texto
      ? `Mensagem: "${texto}"\nData de hoje: ${new Date().toISOString().split("T")[0]}`
      : `Analise esta imagem/documento. Data de hoje: ${new Date().toISOString().split("T")[0]}`,
  });

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    },
    {
      headers: {
        "x-api-key": C.CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  const raw = res.data.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ─── SALVAR NO SUPABASE ───────────────────────────────────────────────────────
async function salvar(classificacao, textoOriginal, mediaUrl = null) {
  const { tabela, dados } = classificacao;

  let payload;

  if (tabela === "transactions") {
    // Mapeia exatamente para as colunas reais da tabela transactions
    payload = {
      workspace_id:    C.WORKSPACE_ID,
      created_by:      C.CREATED_BY,
      type:            dados.type,
      description:     dados.description || textoOriginal,
      category:        dados.category || null,
      value:           Number(dados.value) || 0,
      date:            dados.date || new Date().toISOString().split("T")[0],
      source:          dados.source || "Caixa do Dia",
      obs:             dados.obs
        ? `${dados.obs} | via WhatsApp Bot`
        : "via WhatsApp Bot",
      bank_account_id: dados.category ? BANK_ACCOUNTS[dados.category.toLowerCase().replace("ã", "a")] : null,
    };

  } else if (tabela === "boletos") {
    payload = {
      workspace_id:    C.WORKSPACE_ID,
      created_by:      C.CREATED_BY,
      descricao:       dados.descricao || dados.description || textoOriginal,
      valor_total:     Number(dados.valor_total) || 0,
      num_parcelas:    Number(dados.num_parcelas) || 1,
      data_vencimento: dados.data_vencimento || null,
      parcelas_pagas:  0,
      status:          "pendente",
      obs:             "via WhatsApp Bot",
    };

  } else if (tabela === "budget_items") {
    payload = {
      workspace_id:    C.WORKSPACE_ID,
      created_by:      C.CREATED_BY,
      name:            dados.name || dados.description || textoOriginal,
      amount:          Number(dados.amount) || 0,
      category:        dados.category || null,
      type:            dados.type || "variable",
      description:     `${dados.description || ""} | via WhatsApp Bot`,
    };

  } else {
    // Fallback: salva em transactions como despesa genérica
    payload = {
      workspace_id:    C.WORKSPACE_ID,
      created_by:      C.CREATED_BY,
      type:            "despesa",
      description:     textoOriginal,
      category:        null,
      value:           0,
      date:            new Date().toISOString().split("T")[0],
      source:          "Caixa do Dia",
      obs:             "⚠️ Não classificado automaticamente — revisar | via WhatsApp Bot",
    };
  }

  const res = await axios.post(
    `${C.SUPABASE_URL}/rest/v1/${tabela}`,
    payload,
    {
      headers: {
        apikey:          C.SUPABASE_KEY,
        Authorization:   `Bearer ${C.SUPABASE_KEY}`,
        "Content-Type":  "application/json",
        Prefer:          "return=representation",
      },
    }
  );

  return { tabela, id: res.data?.[0]?.id };
}

// ─── BAIXAR MÍDIA DA EVOLUTION ────────────────────────────────────────────────
async function baixarMidia(msgId) {
  try {
    const res = await axios.get(
      `${C.EVO_URL}/chat/getBase64FromMediaMessage/${C.EVO_INSTANCE}`,
      { headers: { apikey: C.EVO_KEY }, data: { message: { key: { id: msgId } } } }
    );
    return res.data;
  } catch { return null; }
}

// ─── ENVIAR RESPOSTA WHATSAPP ─────────────────────────────────────────────────
async function responder(numero, texto) {
  await axios.post(
    `${C.EVO_URL}/message/sendText/${C.EVO_INSTANCE}`,
    { number: numero, options: { delay: 600 }, textMessage: { text: texto } },
    { headers: { apikey: C.EVO_KEY } }
  );
}

// ─── FORMATAR RESPOSTA ────────────────────────────────────────────────────────
function formatarResposta(cl, tabela, id) {
  const d = cl.dados;
  const isEntrada = d?.type === "entrada";

  const linhas = [
    isEntrada ? "💚 *Entrada registrada!*" : "🔴 *Despesa registrada!*",
    "",
    `📂 *Módulo:* ${d?.source || tabela}`,
    `📝 *Descrição:* ${d?.description || d?.descricao || d?.name || "—"}`,
  ];

  const valor = d?.value || d?.valor_total || d?.amount;
  if (valor) linhas.push(`💵 *Valor:* R$ ${Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);

  if (d?.category) linhas.push(`💳 *Pagamento:* ${d.category}`);
  if (d?.date) linhas.push(`📅 *Data:* ${d.date}`);
  if (d?.num_parcelas) linhas.push(`🔢 *Parcelas:* ${d.num_parcelas}x`);
  if (d?.data_vencimento) linhas.push(`⏰ *Vencimento:* ${d.data_vencimento}`);

  const confianca = Math.round(cl.confianca * 100);
  linhas.push("", `🎯 *Confiança:* ${confianca}%`);

  if (confianca < 80) {
    linhas.push("", "⚠️ Confiança baixa — confirme em fl-cash.lovable.app");
  }

  return linhas.join("\n");
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.data?.key?.fromMe) return;

    const numero = body.data?.key?.remoteJid?.replace("@s.whatsapp.net", "");
    if (!numero) return;

    if (C.ALLOWED.length > 0 && !C.ALLOWED.includes(numero)) {
      await responder(numero, "❌ Número não autorizado no FlowCash Bot.");
      return;
    }

    const tipo = body.data?.messageType;
    const msg  = body.data?.message;
    let texto = "", base64 = null, mimeType = null, mediaUrl = null;

    if (tipo === "conversation" || tipo === "extendedTextMessage") {
      texto = msg?.conversation || msg?.extendedTextMessage?.text || "";

    } else if (tipo === "imageMessage") {
      texto = msg?.imageMessage?.caption || "";
      const m = await baixarMidia(body.data?.key?.id);
      if (m?.base64) { base64 = m.base64; mimeType = "image/jpeg"; mediaUrl = m.mediaUrl; }

    } else if (tipo === "documentMessage") {
      texto = msg?.documentMessage?.caption || msg?.documentMessage?.fileName || "";
      const m = await baixarMidia(body.data?.key?.id);
      if (m?.base64) { base64 = m.base64; mimeType = msg?.documentMessage?.mimetype || "application/pdf"; mediaUrl = m.mediaUrl; }

    } else if (tipo === "videoMessage") {
      texto = msg?.videoMessage?.caption || "";
    } else {
      return;
    }

    if (!texto && !base64) return;

    await responder(numero, "⏳ Registrando no FlowCash...");

    const classificacao = await classificar(texto, base64, mimeType);
    const resultado = await salvar(classificacao, texto, mediaUrl);

    await responder(numero, formatarResposta(classificacao, resultado.tabela, resultado.id));

  } catch (err) {
    console.error("❌ Erro:", err.response?.data || err.message);
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(C.PORT, () => console.log(`🤖 FlowCash Bot :${C.PORT}`));

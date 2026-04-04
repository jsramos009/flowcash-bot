/**
 * WhatsApp Bot — FlowCash Edition (FINAL v2)
 * 
 * Novidade: busca contas bancárias dinamicamente do Supabase
 * antes de classificar, para o Claude saber quais contas existem
 * e vincular corretamente o bank_account_id.
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
  SUPABASE_URL:  process.env.SUPABASE_URL,
  SUPABASE_KEY:  process.env.SUPABASE_SERVICE_KEY,
  WORKSPACE_ID:  process.env.WORKSPACE_ID,
  CREATED_BY:    process.env.USER_ID,
  ALLOWED:       process.env.ALLOWED_NUMBERS?.split(",") || [],
  PORT:          process.env.PORT || 3000,
};

// ─── BUSCAR CONTAS BANCÁRIAS DO SUPABASE ─────────────────────────────────────
// Chamado uma vez por mensagem — retorna as contas cadastradas no workspace
async function buscarContas() {
  try {
    const res = await axios.get(
      `${C.SUPABASE_URL}/rest/v1/bank_accounts?workspace_id=eq.${C.WORKSPACE_ID}&select=id,bank_name,bank_code`,
      {
        headers: {
          apikey: C.SUPABASE_KEY,
          Authorization: `Bearer ${C.SUPABASE_KEY}`,
        },
      }
    );
    return res.data || [];
  } catch (err) {
    console.error("Erro ao buscar contas:", err.message);
    return [];
  }
}

// ─── MONTAR SYSTEM PROMPT DINÂMICO ────────────────────────────────────────────
// Injeta as contas reais do usuário no prompt para o Claude poder vincular
function montarPrompt(contas) {
  const listaContas = contas.length > 0
    ? contas.map(c => `  - "${c.bank_name}" → id: "${c.id}"`).join("\n")
    : "  - Nenhuma conta cadastrada";

  return `Você é o assistente financeiro do FlowCash.
Analise mensagens, fotos, prints e PDFs do WhatsApp e extraia os dados financeiros.

CONTAS BANCÁRIAS CADASTRADAS NO SISTEMA:
${listaContas}

TIPOS de transação:
- "entrada" → receita, venda, recebimento, pagamento recebido
- "despesa" → gasto, pagamento feito, custo, saída

MÉTODO DE PAGAMENTO (campo category) — valores exatos:
- "Pix" → pix, transferência, ted, doc
- "Cartão" → cartão, crédito, débito, maquininha
- "Dinheiro" → dinheiro, espécie, cash, nota
- null → quando não mencionado

CONTA BANCÁRIA (bank_account_id):
- Identifique qual banco foi mencionado na mensagem
- Cruze com a lista de contas cadastradas acima
- Se o banco for mencionado e existir na lista, use o id correspondente
- Se não for mencionado ou não existir, use null

SOURCE — de onde vem o lançamento:
- "Caixa do Dia" → transação rápida do dia, entrada ou saída de caixa
- "Balanço" → venda formal, despesa com nota, registro contábil
- "Boleto" → boleto, financiamento, parcela → tabela: boletos
- "Custos Fixos" → aluguel, mensalidade, recorrente → tabela: budget_items
- "Custos Variáveis" → matéria-prima, insumo, material → tabela: budget_items

Responda SOMENTE em JSON válido, sem markdown, sem texto extra.

Para transações normais (Caixa do Dia ou Balanço):
{
  "tabela": "transactions",
  "confianca": 0.95,
  "resumo": "descrição curta",
  "dados": {
    "type": "entrada|despesa",
    "description": "descrição do lançamento",
    "category": "Pix|Cartão|Dinheiro|null",
    "value": 500.00,
    "date": "2026-04-01",
    "source": "Caixa do Dia|Balanço",
    "obs": "observação opcional",
    "bank_account_id": "uuid-da-conta-ou-null"
  }
}

Para boletos:
{
  "tabela": "boletos",
  "confianca": 0.95,
  "resumo": "descrição curta",
  "dados": {
    "descricao": "nome do boleto",
    "valor_total": 1000.00,
    "num_parcelas": 10,
    "data_vencimento": "2026-05-10",
    "bank_account_id": "uuid-da-conta-ou-null",
    "obs": ""
  }
}

Para custos fixos ou variáveis:
{
  "tabela": "budget_items",
  "confianca": 0.95,
  "resumo": "descrição curta",
  "dados": {
    "name": "nome do custo",
    "amount": 500.00,
    "category": "categoria livre",
    "type": "fixed|variable",
    "description": "descrição"
  }
}`;
}

// ─── CLASSIFICAR COM CLAUDE ───────────────────────────────────────────────────
async function classificar(texto, contas, base64 = null, mimeType = null) {
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
      system: montarPrompt(contas),
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
async function salvar(classificacao, textoOriginal) {
  const { tabela, dados } = classificacao;

  let payload;

  if (tabela === "transactions") {
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
      bank_account_id: dados.bank_account_id || null,
    };

  } else if (tabela === "boletos") {
    payload = {
      workspace_id:    C.WORKSPACE_ID,
      created_by:      C.CREATED_BY,
      descricao:       dados.descricao || textoOriginal,
      valor_total:     Number(dados.valor_total) || 0,
      num_parcelas:    Number(dados.num_parcelas) || 1,
      data_vencimento: dados.data_vencimento || null,
      parcelas_pagas:  0,
      status:          "pendente",
      bank_account_id: dados.bank_account_id || null,
      obs:             "via WhatsApp Bot",
    };

  } else if (tabela === "budget_items") {
    payload = {
      workspace_id: C.WORKSPACE_ID,
      created_by:   C.CREATED_BY,
      name:         dados.name || textoOriginal,
      amount:       Number(dados.amount) || 0,
      category:     dados.category || null,
      type:         dados.type || "variable",
      description:  `${dados.description || ""} | via WhatsApp Bot`.trim(),
    };

  } else {
    // Fallback seguro
    payload = {
      workspace_id: C.WORKSPACE_ID,
      created_by:   C.CREATED_BY,
      type:         "despesa",
      description:  textoOriginal,
      category:     null,
      value:        0,
      date:         new Date().toISOString().split("T")[0],
      source:       "Caixa do Dia",
      obs:          "⚠️ Não classificado — revisar | via WhatsApp Bot",
    };
  }

  const res = await axios.post(
    `${C.SUPABASE_URL}/rest/v1/${tabela}`,
    payload,
    {
      headers: {
        apikey:         C.SUPABASE_KEY,
        Authorization:  `Bearer ${C.SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "return=representation",
      },
    }
  );

  return { tabela, id: res.data?.[0]?.id };
}

// ─── EVOLUTION: BAIXAR MÍDIA ──────────────────────────────────────────────────
async function baixarMidia(msgId) {
  try {
    const res = await axios.get(
      `${C.EVO_URL}/chat/getBase64FromMediaMessage/${C.EVO_INSTANCE}`,
      { headers: { apikey: C.EVO_KEY }, data: { message: { key: { id: msgId } } } }
    );
    return res.data;
  } catch { return null; }
}

// ─── EVOLUTION: RESPONDER ─────────────────────────────────────────────────────
async function responder(numero, texto) {
  await axios.post(
    `${C.EVO_URL}/message/sendText/${C.EVO_INSTANCE}`,
    { number: numero, options: { delay: 600 }, textMessage: { text: texto } },
    { headers: { apikey: C.EVO_KEY } }
  );
}

// ─── FORMATAR RESPOSTA ────────────────────────────────────────────────────────
function formatarResposta(cl, contas) {
  const d = cl.dados;
  const isEntrada = d?.type === "entrada";
  const emoji = isEntrada ? "💚" : "🔴";
  const titulo = isEntrada ? "Entrada registrada!" : "Despesa registrada!";

  // Descobre o nome do banco pelo id
  const conta = contas.find(c => c.id === d?.bank_account_id);
  const nomeConta = conta?.bank_name || null;

  const linhas = [
    `${emoji} *${titulo}*`,
    "",
    `📂 *Módulo:* ${d?.source || cl.tabela}`,
    `📝 *Descrição:* ${d?.description || d?.descricao || d?.name || "—"}`,
  ];

  const valor = d?.value || d?.valor_total || d?.amount;
  if (valor) linhas.push(`💵 *Valor:* R$ ${Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
  if (d?.category) linhas.push(`💳 *Pagamento:* ${d.category}`);
  if (nomeConta) linhas.push(`🏦 *Conta:* ${nomeConta}`);
  if (d?.date) linhas.push(`📅 *Data:* ${d.date}`);
  if (d?.num_parcelas) linhas.push(`🔢 *Parcelas:* ${d.num_parcelas}x`);
  if (d?.data_vencimento) linhas.push(`⏰ *Vencimento:* ${d.data_vencimento}`);

  const pct = Math.round(cl.confianca * 100);
  linhas.push("", `🎯 *Confiança:* ${pct}%`);

  if (pct < 80) linhas.push("\n⚠️ Confiança baixa — confirme em fl-cash.lovable.app");
  if (!nomeConta && !d?.bank_account_id) linhas.push("\n📌 Conta não identificada — vincule manualmente no sistema");

  return linhas.join("\n");
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responde imediatamente para a Evolution não reenviar

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
    let texto = "", base64 = null, mimeType = null;

    if (tipo === "conversation" || tipo === "extendedTextMessage") {
      texto = msg?.conversation || msg?.extendedTextMessage?.text || "";

    } else if (tipo === "imageMessage") {
      texto = msg?.imageMessage?.caption || "";
      const m = await baixarMidia(body.data?.key?.id);
      if (m?.base64) { base64 = m.base64; mimeType = "image/jpeg"; }

    } else if (tipo === "documentMessage") {
      texto = msg?.documentMessage?.caption || msg?.documentMessage?.fileName || "";
      const m = await baixarMidia(body.data?.key?.id);
      if (m?.base64) { base64 = m.base64; mimeType = msg?.documentMessage?.mimetype || "application/pdf"; }

    } else if (tipo === "videoMessage") {
      texto = msg?.videoMessage?.caption || "";

    } else {
      return;
    }

    if (!texto && !base64) return;

    await responder(numero, "⏳ Registrando no FlowCash...");

    // Busca contas em tempo real antes de classificar
    const contas = await buscarContas();

    const classificacao = await classificar(texto, contas, base64, mimeType);
    const resultado = await salvar(classificacao, texto);

    await responder(numero, formatarResposta(classificacao, contas));

  } catch (err) {
    console.error("❌ Erro:", err.response?.data || err.message);
  }
});

app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(C.PORT, () => {
  console.log(`🤖 FlowCash Bot rodando na porta ${C.PORT}`);
  console.log(`📡 Webhook → POST http://localhost:${C.PORT}/webhook`);
});

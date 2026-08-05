import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = 'v21.0';
const PORT = process.env.PORT || 8787;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const ACCOUNTS = {
  goalfy: '3161900040691854',
  educ:   '1668613276969859',
  assess: '942303367281147'
};

const ACCOUNT_LABELS = {
  goalfy: 'Goalfy',
  educ:   'Hapo Educação',
  assess: 'Hapo Assessoria'
};

// Meta's raw Graph API has no single "Results" field like Ads Manager shows —
// it's derived per-campaign from the objective, and not every custom
// conversion named "cadastro" actually feeds into it (some are legacy/unused
// funnels). This list was validated against Ads Manager's own totals for
// 01/06–02/07/2026 (Goalfy 137, Educação 124, Assessoria 70) — the generic
// 'lead' action_type already covers Educação and Assessoria; Goalfy also
// needs its "Cadastros Novo - 20/03" custom conversion, which is tagged
// OTHER so it doesn't roll up into 'lead' automatically. Re-check against
// Ads Manager if these numbers drift (e.g. after new campaigns/conversions
// are created) and adjust per account below.
const ACCOUNT_LEAD_ACTION_TYPES = {
  goalfy: ['lead', 'offsite_conversion.custom.3983603505258234'],
  educ:   ['lead'],
  assess: ['lead']
};

function getLeadActionTypes(key) {
  return ACCOUNT_LEAD_ACTION_TYPES[key] || ['lead'];
}

const METAS = {
  goalfy: { leads: 222, spend: 10000, cpl: 45 },
  educ:   { leads: 250, spend: 5000,  cpl: 20 },
  // Ago/26: a meta oficial da Assessoria virou reconhecimento (alcance 5.500 /
  // freq. 4x, ver META_RECONHECIMENTO no index.html) — estes valores de
  // leads/cpl ficam só como referência interna pra não quebrar telas
  // secundárias (Meta Diária, prompt de estratégia) que ainda leem daqui.
  assess: { leads: 59,  spend: 3000,  cpl: 50.55 }
};

function countLeads(actions, leadActionTypes) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter(a => leadActionTypes.includes(a.action_type))
    .reduce((s, a) => s + (parseInt(a.value, 10) || 0), 0);
}

async function graphGet(pathAndQuery) {
  if (!TOKEN) throw new Error('META_ACCESS_TOKEN não configurado — crie um arquivo .env (veja .env.example)');
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/${API_VERSION}/${pathAndQuery}${sep}access_token=${TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Erro na Graph API');
  return json;
}

function nextPageQuery(json) {
  if (!json.paging?.next) return null;
  return json.paging.next.replace(/^https:\/\/graph\.facebook\.com\/[^/]+\//, '');
}

async function fetchStatuses(accountId) {
  const statuses = {};
  let q = `act_${accountId}/campaigns?fields=id,effective_status&limit=500`;
  while (q) {
    const json = await graphGet(q);
    for (const c of json.data) statuses[c.id] = c.effective_status;
    q = nextPageQuery(json);
  }
  return statuses;
}

// ─── DAILY LOCAL CACHE ──────────────────────────────────────────────────────
// One JSON file per calendar date (data/YYYY-MM-DD.json), holding raw
// campaign- and ad-level rows for all 3 accounts for that single day. Once a
// day is in the past it's treated as immutable and never re-fetched from
// Meta — this is what avoids re-pulling the whole date range from the API on
// every dashboard refresh. "Today" is always fetched live (it's still
// accumulating) and never written to disk.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dayFilePath(date) { return path.join(DATA_DIR, `${date}.json`); }

function readDayFile(date) {
  try { return JSON.parse(fs.readFileSync(dayFilePath(date), 'utf8')); }
  catch { return null; }
}

// Serializes read-modify-write per date file so two accounts being cached
// around the same time don't clobber each other's write.
const fileLocks = new Map();
function writeDayAccount(date, key, data) {
  const prev = fileLocks.get(date) || Promise.resolve();
  const next = prev.then(() => {
    let full = {};
    try { full = JSON.parse(fs.readFileSync(dayFilePath(date), 'utf8')); } catch {}
    full[key] = data;
    fs.writeFileSync(dayFilePath(date), JSON.stringify(full));
  }).catch(err => console.warn(`Falha ao gravar cache ${date}/${key}: ${err.message}`));
  fileLocks.set(date, next);
  return next;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayISO() { return toISODate(new Date()); }
function dateNDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return toISODate(d); }

function enumerateDates(since, until) {
  const dates = [];
  const cur = new Date(since + 'T00:00:00');
  const end = new Date(until + 'T00:00:00');
  while (cur <= end) { dates.push(toISODate(cur)); cur.setDate(cur.getDate() + 1); }
  return dates;
}

async function fetchDayFromMeta(accountId, date) {
  const timeRange = encodeURIComponent(JSON.stringify({ since: date, until: date }));
  const campFields = 'campaign_id,campaign_name,spend,impressions,reach,actions';
  const adFields = 'ad_id,ad_name,campaign_id,campaign_name,spend,impressions,ctr,cpm,frequency,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,actions';

  async function fetchAll(level, fields) {
    const rows = [];
    let q = `act_${accountId}/insights?level=${level}&time_range=${timeRange}&fields=${fields}&limit=500`;
    while (q) { const json = await graphGet(q); rows.push(...json.data); q = nextPageQuery(json); }
    return rows;
  }

  const [campaigns, ads] = await Promise.all([
    fetchAll('campaign', campFields),
    fetchAll('ad', adFields)
  ]);
  return { campaigns, ads };
}

const inFlight = new Map(); // dedupes concurrent requests for the same key+date

async function getDay(key, date, { forceRefresh = false } = {}) {
  const isToday = date === todayISO();
  if (!forceRefresh && !isToday) {
    const cached = readDayFile(date);
    if (cached && cached[key]) return cached[key];
  }
  const cacheKey = `${key}:${date}`;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = (async () => {
    const fresh = await fetchDayFromMeta(ACCOUNTS[key], date);
    if (!isToday) await writeDayAccount(date, key, fresh); // "today" stays live, never cached
    return fresh;
  })();
  inFlight.set(cacheKey, promise);
  try { return await promise; } finally { inFlight.delete(cacheKey); }
}

async function getRangeDays(key, since, until) {
  const dates = enumerateDates(since, until);
  const results = new Array(dates.length);
  let idx = 0;
  async function worker() {
    while (idx < dates.length) {
      const my = idx++;
      results[my] = { date: dates[my], ...(await getDay(key, dates[my])) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, dates.length) }, worker));
  return results;
}

// Keeps the last few days fresh (Meta's conversion attribution can trickle
// in for a couple of days after the fact) and backfills anything missing
// further back, so the cache is self-healing if the server was off a while.
const REFRESH_WINDOW_DAYS = 3;
const BACKFILL_WINDOW_DAYS = 14;

async function backfillRecent() {
  for (let i = 1; i <= BACKFILL_WINDOW_DAYS; i++) {
    const date = dateNDaysAgo(i);
    const cached = readDayFile(date);
    const forceRefresh = i <= REFRESH_WINDOW_DAYS;
    for (const key of Object.keys(ACCOUNTS)) {
      if (!forceRefresh && cached && cached[key]) continue;
      try { await getDay(key, date, { forceRefresh }); }
      catch (err) { console.warn(`Falha ao pré-carregar ${key} ${date}: ${err.message}`); }
    }
  }
}

// ─── AGGREGATIONS (built from cached days, no direct Graph calls beyond fetchStatuses) ──
async function getAccountSummary(key, since, until) {
  if (!ACCOUNTS[key]) throw new Error('Conta desconhecida: ' + key);
  const [days, statuses] = await Promise.all([
    getRangeDays(key, since, until),
    fetchStatuses(ACCOUNTS[key])
  ]);
  const leadActionTypes = getLeadActionTypes(key);

  const byCampaign = {};
  for (const day of days) {
    for (const r of day.campaigns) {
      const spend = parseFloat(r.spend) || 0;
      if (spend === 0) continue;
      const cur = byCampaign[r.campaign_id] || {
        name: r.campaign_name,
        status: statuses[r.campaign_id] || 'UNKNOWN',
        spend: 0, leads: 0, impressions: 0, reach: 0
      };
      cur.spend += spend;
      cur.leads += countLeads(r.actions, leadActionTypes);
      cur.impressions += parseInt(r.impressions, 10) || 0;
      // Reach somado dia-a-dia — mesma aproximação já usada no reach total da
      // conta (ver totalReach abaixo): não é reach único deduplicado no
      // período, mas segue o mesmo padrão do resto do app.
      cur.reach += parseInt(r.reach, 10) || 0;
      byCampaign[r.campaign_id] = cur;
    }
  }

  const campaigns = Object.values(byCampaign)
    .map(c => ({ ...c, cpl: c.leads > 0 ? c.spend / c.leads : null, frequency: c.reach > 0 ? c.impressions / c.reach : null }))
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalLeads = campaigns.reduce((s, c) => s + c.leads, 0);
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalReach = days.reduce((s, d) => s + d.campaigns.reduce((s2, r) => s2 + (parseInt(r.reach, 10) || 0), 0), 0);

  return {
    spend: totalSpend,
    leads: totalLeads,
    cpl: totalLeads > 0 ? totalSpend / totalLeads : 0,
    impressions: totalImpressions,
    reach: totalReach,
    campaigns
  };
}

const isBelowAverage = rank => typeof rank === 'string' && rank.startsWith('BELOW_AVERAGE');

// Minimum impressions before a campaign's CTR/CPM is compared against the
// account average — below this, sample size is too small to mean anything.
const MIN_IMPRESSIONS_FOR_BENCHMARK = 500;

async function getAccountInsights(key, since, until) {
  if (!ACCOUNTS[key]) throw new Error('Conta desconhecida: ' + key);
  const leadActionTypes = getLeadActionTypes(key);
  const days = await getRangeDays(key, since, until);
  const adRows = days.flatMap(d => d.ads);

  const ads = adRows
    .map(r => ({
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      spend: parseFloat(r.spend) || 0,
      impressions: parseInt(r.impressions, 10) || 0,
      ctr: parseFloat(r.ctr) || 0,
      cpm: parseFloat(r.cpm) || 0,
      frequency: parseFloat(r.frequency) || 0,
      qualityRanking: r.quality_ranking,
      engagementRanking: r.engagement_rate_ranking,
      conversionRanking: r.conversion_rate_ranking,
      leads: countLeads(r.actions, leadActionTypes)
    }))
    .filter(a => a.spend > 0);

  const totalImpressions = ads.reduce((s, a) => s + a.impressions, 0) || 1;
  const avgCtr = ads.reduce((s, a) => s + a.ctr * a.impressions, 0) / totalImpressions;
  const avgCpm = ads.reduce((s, a) => s + a.cpm * a.impressions, 0) / totalImpressions;

  const byCampaign = {};
  for (const a of ads) {
    const c = byCampaign[a.campaignId] || {
      name: a.campaignName, spend: 0, leads: 0, impressions: 0, maxFrequency: 0,
      worstQuality: null, worstEngagement: null, worstConversion: null,
      ctrWeighted: 0, cpmWeighted: 0
    };
    c.spend += a.spend;
    c.leads += a.leads;
    c.impressions += a.impressions;
    c.maxFrequency = Math.max(c.maxFrequency, a.frequency);
    c.ctrWeighted += a.ctr * a.impressions;
    c.cpmWeighted += a.cpm * a.impressions;
    if (isBelowAverage(a.qualityRanking)) c.worstQuality = a.qualityRanking;
    if (isBelowAverage(a.engagementRanking)) c.worstEngagement = a.engagementRanking;
    if (isBelowAverage(a.conversionRanking)) c.worstConversion = a.conversionRanking;
    byCampaign[a.campaignId] = c;
  }

  const campaigns = Object.values(byCampaign).map(c => ({
    name: c.name,
    spend: c.spend,
    leads: c.leads,
    cpl: c.leads > 0 ? c.spend / c.leads : null,
    ctr: c.impressions ? c.ctrWeighted / c.impressions : 0,
    cpm: c.impressions ? c.cpmWeighted / c.impressions : 0,
    frequency: c.maxFrequency,
    impressions: c.impressions,
    worstQuality: c.worstQuality,
    worstEngagement: c.worstEngagement,
    worstConversion: c.worstConversion
  }));

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0) || 1;
  const meta = METAS[key];
  const findings = [];

  const RANKING_LABEL = { worstQuality: 'qualidade do anúncio', worstEngagement: 'taxa de engajamento', worstConversion: 'taxa de conversão' };
  const RANKING_ACTION = {
    worstQuality: 'Revisar relevância do criativo/copy em relação ao público-alvo.',
    worstEngagement: 'Testar novos formatos de criativo (vídeo, carrossel, novo copy).',
    worstConversion: 'Revisar a landing page/formulário — fricção depois do clique.'
  };

  for (const c of campaigns) {
    const spendShare = c.spend / totalSpend;

    if (c.frequency >= 5) {
      findings.push({ severity: 'critical', campaign: c.name, message: `Frequência muito alta (${c.frequency.toFixed(1)}x) — público provavelmente saturado.`, action: 'Trocar os criativos ou ampliar/atualizar o público-alvo.' });
    } else if (c.frequency >= 3.5) {
      findings.push({ severity: 'warning', campaign: c.name, message: `Frequência elevada (${c.frequency.toFixed(1)}x).`, action: 'Preparar novos criativos antes que o público sature de vez.' });
    }

    for (const field of ['worstQuality', 'worstEngagement', 'worstConversion']) {
      if (c[field]) {
        findings.push({ severity: 'warning', campaign: c.name, message: `Ranking de ${RANKING_LABEL[field]} abaixo da média (${c[field]}).`, action: RANKING_ACTION[field] });
      }
    }

    if (c.impressions >= MIN_IMPRESSIONS_FOR_BENCHMARK) {
      if (avgCtr > 0 && c.ctr < avgCtr * 0.6) {
        findings.push({ severity: 'warning', campaign: c.name, message: `CTR (${c.ctr.toFixed(2)}%) bem abaixo da média da conta (${avgCtr.toFixed(2)}%).`, action: 'Criativo pouco atrativo — considerar testar um novo anúncio.' });
      }
      if (avgCpm > 0 && c.cpm > avgCpm * 1.5) {
        findings.push({ severity: 'info', campaign: c.name, message: `CPM (R$${c.cpm.toFixed(2)}) bem acima da média da conta (R$${avgCpm.toFixed(2)}).`, action: 'Público pode estar saturado/concorrido — considerar ampliar a segmentação.' });
      }
    }

    if (meta && c.cpl != null) {
      if (c.cpl > meta.cpl * 1.5 && spendShare > 0.1) {
        findings.push({ severity: 'critical', campaign: c.name, message: `CPL (R$${c.cpl.toFixed(2)}) muito acima da meta (R$${meta.cpl.toFixed(2)}) e consome ${(spendShare * 100).toFixed(0)}% do orçamento da conta.`, action: 'Pausar ou revisar segmentação/criativo antes de continuar investindo.' });
      } else if (c.cpl <= meta.cpl * 0.8) {
        findings.push({ severity: 'opportunity', campaign: c.name, message: `CPL (R$${c.cpl.toFixed(2)}) está ${(100 - (c.cpl / meta.cpl * 100)).toFixed(0)}% abaixo da meta.`, action: 'Considerar aumentar o orçamento para escalar essa campanha.' });
      }
    }
  }

  const severityOrder = { critical: 0, warning: 1, opportunity: 2, info: 3 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return { avgCtr, avgCpm, campaigns, findings };
}

async function getAccountDaily(key, since, until) {
  if (!ACCOUNTS[key]) throw new Error('Conta desconhecida: ' + key);
  const leadActionTypes = getLeadActionTypes(key);
  const days = await getRangeDays(key, since, until);
  return days.map(d => ({
    date: d.date,
    leads: d.campaigns.reduce((s, r) => s + countLeads(r.actions, leadActionTypes), 0),
    spend: d.campaigns.reduce((s, r) => s + (parseFloat(r.spend) || 0), 0)
  }));
}

async function fetchCampaignStructure(accountId) {
  const campaigns = await (async () => {
    const rows = [];
    let q = `act_${accountId}/campaigns?fields=id,name,objective,effective_status&limit=500`;
    while (q) { const json = await graphGet(q); rows.push(...json.data); q = nextPageQuery(json); }
    return rows;
  })();
  const adsets = await (async () => {
    const rows = [];
    let q = `act_${accountId}/adsets?fields=id,name,campaign_id,optimization_goal,daily_budget,lifetime_budget,effective_status&limit=500`;
    while (q) { const json = await graphGet(q); rows.push(...json.data); q = nextPageQuery(json); }
    return rows;
  })();
  return { campaigns, adsets };
}

// Splits the period in half to compare trajectory (improving vs worsening)
// rather than just a single-period snapshot. Built from the same cached
// days as everything else — no extra Graph API calls.
async function getTrendSplit(key, since, until) {
  const leadActionTypes = getLeadActionTypes(key);
  const days = await getRangeDays(key, since, until);
  const mid = Math.ceil(days.length / 2);

  function summarize(slice) {
    const spend = slice.reduce((s, d) => s + d.campaigns.reduce((s2, r) => s2 + (parseFloat(r.spend) || 0), 0), 0);
    const leads = slice.reduce((s, d) => s + d.campaigns.reduce((s2, r) => s2 + countLeads(r.actions, leadActionTypes), 0), 0);
    return { since: slice[0]?.date, until: slice[slice.length - 1]?.date, spend, leads, cpl: leads > 0 ? spend / leads : null };
  }

  return { h1: summarize(days.slice(0, mid)), h2: summarize(days.slice(mid)) };
}

function buildStrategyPrompt(key, since, until, summary, insights, structure, trend) {
  const accountName = ACCOUNT_LABELS[key] || key;
  const meta = METAS[key];
  const { campaigns, adsets } = structure;
  const campaignById = Object.fromEntries(campaigns.map(c => [c.id, c]));

  const campaignLines = campaigns
    .filter(c => summary.campaigns.some(sc => sc.name === c.name))
    .map(c => {
      const sc = summary.campaigns.find(x => x.name === c.name);
      return `- [${c.objective}] [${c.effective_status}] "${c.name}" — gasto R$${sc.spend.toFixed(0)}, ${sc.leads} leads, CPL ${sc.cpl ? 'R$' + sc.cpl.toFixed(2) : 'sem leads'}`;
    }).join('\n');

  const adsetLines = adsets
    .filter(a => a.effective_status === 'ACTIVE')
    .map(a => {
      const camp = campaignById[a.campaign_id];
      const budget = a.daily_budget ? `R$${(a.daily_budget / 100).toFixed(0)}/dia` : a.lifetime_budget ? `R$${(a.lifetime_budget / 100).toFixed(0)} vitalício` : 'orçamento no nível da campanha (CBO)';
      return `- "${a.name}" (campanha: "${camp?.name || '?'}") — objetivo de otimização: ${a.optimization_goal}, orçamento: ${budget}`;
    }).join('\n') || '(nenhum conjunto ativo no momento)';

  const findingLines = insights.findings.map(f => `- [${f.severity}] ${f.campaign}: ${f.message}`).join('\n') || '(nenhum sinal técnico relevante)';

  return `Você é um gestor de tráfego brasileiro sênior, com mais de 10 anos de mercado, especialista em Meta Ads e focado em growth. Um cliente (Hapo Group) te passou os dados abaixo da conta "${accountName}" para você dar sua leitura estratégica real, como se estivesse numa reunião de resultado com o time de marketing. Não repita métricas óbvias sem interpretá-las — pense em causa raiz, estrutura de conta, alocação de orçamento e funil (frio vs remarketing).

PERÍODO ANALISADO: ${since} a ${until}
META MENSAL: ${meta.leads} leads · CPL alvo R$${meta.cpl.toFixed(2)} · verba R$${meta.spend}

RESUMO DO PERÍODO: gasto R$${summary.spend.toFixed(0)}, ${summary.leads} leads, CPL médio R$${summary.cpl.toFixed(2)}

TENDÊNCIA (1ª metade do período vs 2ª metade):
- 1ª metade (${trend.h1.since} a ${trend.h1.until}): gasto R$${trend.h1.spend.toFixed(0)}, ${trend.h1.leads} leads, CPL ${trend.h1.cpl ? 'R$' + trend.h1.cpl.toFixed(2) : '-'}
- 2ª metade (${trend.h2.since} a ${trend.h2.until}): gasto R$${trend.h2.spend.toFixed(0)}, ${trend.h2.leads} leads, CPL ${trend.h2.cpl ? 'R$' + trend.h2.cpl.toFixed(2) : '-'}

CAMPANHAS COM GASTO NO PERÍODO (objetivo, status, resultado):
${campaignLines}

CONJUNTOS DE ANÚNCIOS ATIVOS AGORA (estrutura/orçamento/otimização):
${adsetLines}

SINAIS TÉCNICOS JÁ DETECTADOS (frequência/fadiga, rankings de qualidade/engajamento/conversão, CTR/CPM fora da média da conta):
${findingLines}

Escreva sua análise em português, em HTML simples usando SOMENTE as tags <h4>, <p>, <ul>, <li> e <strong> (sem markdown, sem \`\`\`, sem <html>/<body>/<head>). Estruture em três blocos com <h4>: "Diagnóstico" (o que está realmente acontecendo e por quê — causa raiz, não sintoma), "Riscos para bater a meta" e "Recomendações" (3 a 5 ações práticas e priorizadas, citando campanhas ou conjuntos específicos pelo nome). Seja direto, sem enrolação, como um gestor de tráfego experiente falaria de verdade.`;
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY não configurado — crie um .env (veja .env.example)');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Erro na API do Gemini');
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('Gemini não retornou nenhum texto — resposta: ' + JSON.stringify(json).slice(0, 300));
  return text;
}

async function getAccountStrategy(key, since, until) {
  if (!ACCOUNTS[key]) throw new Error('Conta desconhecida: ' + key);

  const [summary, insights, structure, trend] = await Promise.all([
    getAccountSummary(key, since, until),
    getAccountInsights(key, since, until),
    fetchCampaignStructure(ACCOUNTS[key]),
    getTrendSplit(key, since, until)
  ]);

  const prompt = buildStrategyPrompt(key, since, until, summary, insights, structure, trend);
  const html = await callGemini(prompt);
  return { html };
}

const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/account/')) {
    const parts = url.pathname.split('/').filter(Boolean); // api, account, key, (daily|insights|strategy)?
    const key = parts[2];
    const suffix = parts[3];
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!since || !until) throw new Error('Parâmetros since/until obrigatórios');
      const data = suffix === 'daily' ? await getAccountDaily(key, since, until)
        : suffix === 'insights' ? await getAccountInsights(key, since, until)
        : suffix === 'strategy' ? await getAccountStrategy(key, since, until)
        : await getAccountSummary(key, since, until);
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = path.join(__dirname, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Hapo Marketing Dashboard rodando em http://localhost:${PORT}`);
  if (!TOKEN) console.warn('⚠ META_ACCESS_TOKEN não definido — crie um .env (veja .env.example). Os dados não vão carregar até lá.');
  if (!GEMINI_API_KEY) console.warn('⚠ GEMINI_API_KEY não definido — a "visão do gestor de tráfego" na aba Insights não vai funcionar até lá.');

  if (TOKEN) {
    backfillRecent().catch(err => console.warn('Backfill inicial falhou:', err.message));
    setInterval(() => backfillRecent().catch(err => console.warn('Backfill periódico falhou:', err.message)), 60 * 60 * 1000);
  }
});

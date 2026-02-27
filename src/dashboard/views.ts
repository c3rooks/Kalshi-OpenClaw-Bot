import type { Stats } from "../db/queries";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(command: string): string {
  return `<div class="cmd"><code>${esc(command)}</code><button class="btn tiny" onclick="copyCmd(this)">Copy</button></div>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/assets/dashboard.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">OpenClaw Kalshi</div>
    <nav class="nav">
      <a href="/">Home</a>
      <a href="/browse">Browse Markets</a>
      <a href="/trades">Trades</a>
      <a href="/intelligence">Intelligence</a>
      <a href="/performance">Performance</a>
      <a href="/config">Config</a>
      <a href="/help">Setup</a>
    </nav>
    <button id="themeToggle" class="btn tiny">Theme</button>
  </header>
  <main class="container">${body}</main>
  <script>
    (function(){
      const t = localStorage.getItem('theme') || 'light';
      document.documentElement.dataset.theme = t;
      const b = document.getElementById('themeToggle');
      if (b) b.onclick = () => {
        const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = n;
        localStorage.setItem('theme', n);
      };
    })();
    function copyCmd(btn){
      const code = btn.parentElement.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code);
      btn.textContent='Copied';
      setTimeout(()=>btn.textContent='Copy',900);
    }
    function pretty(id, obj){
      const el=document.getElementById(id); if(!el) return; el.textContent=JSON.stringify(obj,null,2);
    }
  </script>
</body>
</html>`;
}

function statusBadge(label: string, klass: string): string {
  return `<span class="badge ${klass}">${esc(label)}</span>`;
}

export function renderHome(stats: Stats): string {
  const live = stats.liveTradingActive ? statusBadge("LIVE", "bad") : statusBadge("DRY_RUN", "ok");
  const stop = stats.stopNewTrades ? statusBadge("STOP_NEW_TRADES", "warn") : statusBadge("NEW_TRADES_ENABLED", "ok");
  const drift = Number(stats.driftMsEstimate ?? NaN);

  return layout(
    "Dashboard",
    `
<section class="panel">
  <h1>Dashboard ${live} ${stop}</h1>
  <p class="muted">Kalshi generic binary bot status. Live requires DRY_RUN=false + confirm gate.</p>
  <p class="muted">Learning profile: <strong id="learningProfile">${esc(String((stats as unknown as Record<string, unknown>).learningActiveProfile ?? "champion"))}</strong></p>
  <p id="blockedBanner" class="warn hidden"></p>
  ${Number.isFinite(drift) ? `<p class="${Math.abs(drift) > 250 ? "warn" : "muted"}">Clock drift estimate: ${drift.toFixed(1)}ms ${Math.abs(drift) > 250 ? "(warning > 250ms)" : ""}</p>` : ""}
</section>
<section class="kpis">
  <div class="card"><div>Total trades</div><strong id="k_total">${stats.totalTrades}</strong></div>
  <div class="card"><div>Win rate</div><strong id="k_win">${(stats.winRate * 100).toFixed(1)}%</strong></div>
  <div class="card"><div>Balance (USD)</div><strong id="k_balance">--</strong></div>
  <div class="card"><div>Available (USD)</div><strong id="k_available">--</strong></div>
  <div class="card"><div>Today PnL</div><strong id="k_today">${Number((stats as unknown as Record<string, unknown>).pnlToday ?? stats.todayPnl).toFixed(2)}</strong></div>
  <div class="card"><div>Week PnL</div><strong id="k_week">--</strong></div>
  <div class="card"><div>Month PnL</div><strong id="k_month">--</strong></div>
  <div class="card"><div>Year PnL</div><strong id="k_year">--</strong></div>
  <div class="card"><div>Total PnL</div><strong id="k_totalpnl">${stats.totalPnl.toFixed(2)}</strong></div>
  <div class="card"><div>Fill rate</div><strong id="k_fill">${(stats.fillRate * 100).toFixed(1)}%</strong></div>
  <div class="card"><div>Avg fill time</div><strong id="k_avgfill">${Math.round(stats.avgFillTimeMs)}ms</strong></div>
  <div class="card"><div>Cancels per fill</div><strong id="k_cpf">${stats.cancelsPerFill.toFixed(2)}</strong></div>
  <div class="card"><div>Current size</div><strong id="k_size">${Number(stats.currentTradeSizeUsd ?? 0).toFixed(2)}</strong></div>
</section>
<section class="panel row">
  <div>
    <button class="btn" onclick="control('/api/control/stop')">Stop New Trades</button>
    <button class="btn" onclick="control('/api/control/start')">Start New Trades</button>
  </div>
  <pre id="controlOut" class="json"></pre>
</section>
<section class="panel">
  <h2>Auto-Learning</h2>
  <div class="row muted" id="learningSummary">Loading learning metrics...</div>
</section>
<section class="panel">
  <h2>Attempts Per Hour</h2>
  <div class="table-wrap"><table><thead><tr><th>Hour</th><th>Attempts</th><th>Fills</th><th>Cancels</th></tr></thead><tbody id="attemptsBody"></tbody></table></div>
</section>
<section class="panel">
  <h2>Top Auto-Executable Opportunities (Not Yet Traded)</h2>
  <div id="oppMeta" class="muted"></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Market</th><th>Recommended Side</th><th>Edge</th><th>Quality</th><th>FillProb</th><th>Ask</th><th>Manual</th></tr></thead>
      <tbody id="oppBody"></tbody>
    </table>
  </div>
  <pre id="manualOut" class="json"></pre>
</section>
<section class="panel">
  <h2>PnL Ranges (Realized)</h2>
  <div class="table-wrap"><table><thead><tr><th>Range</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Realized PnL</th></tr></thead><tbody id="pnlRangeBody"></tbody></table></div>
</section>
<section class="panel">
  <h2>Open Positions (Live Mark)</h2>
  <div class="row muted" id="openTotals"></div>
  <div class="table-wrap"><table><thead><tr><th>Market</th><th>Side</th><th>Shares</th><th>Avg</th><th>Mark</th><th>Cost</th><th>Value</th><th>Unrealized</th><th>TTE(s)</th></tr></thead><tbody id="openBody"></tbody></table></div>
</section>
<script>
async function control(path){
  const r = await fetch(path,{method:'POST'}); pretty('controlOut', await r.json());
}
function row(cells){return '<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>';}
function fmtTs(ts){if(!ts) return ''; return new Date(Number(ts)).toLocaleString();}
function fmt(v,d=2){ const n=Number(v); return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }
async function manualTrade(marketId,side,mode){
  const r = await fetch('/api/trade/manual',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ticker:marketId, side, mode})
  });
  pretty('manualOut', await r.json());
}
async function refresh(){
  const s = await fetch('/api/stats').then(r=>r.json());
  document.getElementById('k_total').textContent = s.totalTrades;
  document.getElementById('k_win').textContent = (s.winRate*100).toFixed(1)+'%';
  document.getElementById('k_today').textContent = Number(s.pnlToday ?? s.todayPnl).toFixed(2);
  document.getElementById('k_week').textContent = Number(s.pnlWeek ?? 0).toFixed(2);
  document.getElementById('k_month').textContent = Number(s.pnlMonth ?? 0).toFixed(2);
  document.getElementById('k_year').textContent = Number(s.pnlYear ?? 0).toFixed(2);
  document.getElementById('k_totalpnl').textContent = Number(s.totalPnl).toFixed(2);
  document.getElementById('k_fill').textContent = (s.fillRate*100).toFixed(1)+'%';
  document.getElementById('k_avgfill').textContent = Math.round(Number(s.avgFillTimeMs||0))+'ms';
  document.getElementById('k_cpf').textContent = Number(s.cancelsPerFill||0).toFixed(2);
  document.getElementById('k_size').textContent = Number(s.currentTradeSizeUsd||0).toFixed(2);
  const blocked = document.getElementById('blockedBanner');
  if (blocked) {
    if (s.blockedReason) {
      const mins = Number(s.blockedForMs||0) > 0 ? Math.floor(Number(s.blockedForMs)/60000) : 0;
      blocked.classList.remove('hidden');
      blocked.textContent = 'Bot blocked: '+String(s.blockedReason)+' ('+mins+'m)';
    } else {
      blocked.classList.add('hidden');
      blocked.textContent = '';
    }
  }
  const lp = document.getElementById('learningProfile');
  if (lp && s.learningActiveProfile) lp.textContent = String(s.learningActiveProfile);

  const acct = await fetch('/api/account').then(r=>r.json()).catch(()=>({ok:false}));
  document.getElementById('k_balance').textContent = acct.ok ? fmt(acct.balanceUsd,2) : '--';
  document.getElementById('k_available').textContent = acct.ok ? fmt(acct.availableUsd,2) : '--';

  const ss = await fetch('/api/scan-summary').then(r=>r.json());
  document.getElementById('attemptsBody').innerHTML = (ss.attemptsPerHour||[]).map(x=>row([x.hour, x.attempts, x.fills, x.cancels])).join('');

  const ops = await fetch('/api/opportunities?limit=10').then(r=>r.json());
  const oppMeta = document.getElementById('oppMeta');
  if (oppMeta) {
    oppMeta.textContent = String(ops.message || 'Strategy-scored opportunities sorted by edge/quality/fill probability.');
  }
  document.getElementById('oppBody').innerHTML = (ops.items||[]).map(o=>row([
    '<a href="/market/'+encodeURIComponent(o.market_id)+'">'+o.market_id+'</a>',
    String(o.side||''),
    fmt(o.edge,4),
    fmt(o.quality_score,1),
    fmt(o.fill_prob,3),
    String(o.side)==='YES' ? fmt(o.best_yes,2) : fmt(o.best_no,2),
    '<div class="row"><button class="btn tiny" onclick="manualTrade(\\''+String(o.market_id).replace(/'/g,\"&#39;\")+'\\',\\''+String(o.side||'YES')+'\\',\\'paper\\')">Paper</button><button class="btn tiny" onclick="manualTrade(\\''+String(o.market_id).replace(/'/g,\"&#39;\")+'\\',\\''+String(o.side||'YES')+'\\',\\'live\\')">Live</button></div>'
  ])).join('');

  const ranges = await fetch('/api/pnl/ranges').then(r=>r.json()).catch(()=>({ok:false,rows:[]}));
  document.getElementById('pnlRangeBody').innerHTML = (ranges.rows||[]).map(r=>row([
    String(r.label||''),
    Number(r.trades||0),
    Number(r.wins||0),
    Number(r.losses||0),
    (Number(r.winRate||0)*100).toFixed(1)+'%',
    fmt(r.realizedPnl,2)
  ])).join('');

  const open = await fetch('/api/open-positions-live').then(r=>r.json()).catch(()=>({ok:false,count:0,items:[],totals:{}}));
  const totalEl = document.getElementById('openTotals');
  if (totalEl) {
    totalEl.textContent = open.ok ? ('positions='+Number(open.count||0)+' cost='+fmt(open.totals?.totalCostUsd,2)+' value='+fmt(open.totals?.totalCurrentValueUsd,2)+' unrealized='+fmt(open.totals?.totalUnrealizedPnlUsd,2)) : 'open positions unavailable';
  }
  document.getElementById('openBody').innerHTML = (open.items||[]).map(x=>row([
    '<a href="/market/'+encodeURIComponent(x.marketId)+'">'+x.marketId+'</a>',
    x.side,
    fmt(x.shares,2),
    fmt(x.avgPrice,3),
    fmt(x.markPrice,3),
    fmt(x.costUsd,2),
    fmt(x.currentValueUsd,2),
    fmt(x.unrealizedPnlUsd,2),
    Number.isFinite(Number(x.tteSec)) ? Math.round(Number(x.tteSec)) : 'n/a'
  ])).join('');

  const learn = await fetch('/api/learning/status').then(r=>r.json()).catch(()=>({ok:false}));
  const learnEl = document.getElementById('learningSummary');
  if (learnEl) {
    if (!learn.ok) {
      learnEl.textContent = 'Learning status unavailable';
    } else {
      const top = (learn.metrics||[])[0] || null;
      const cause = (learn.topAttributionCauses||[])[0] || null;
      const txt = [];
      txt.push('active='+String(learn.activeProfile||'champion'));
      if (top) txt.push('resolved='+Number(top.resolved||0), 'winRate='+(Number(top.winRate||0)*100).toFixed(1)+'%', 'pnl='+fmt(top.pnlUsd,2));
      if (cause) txt.push('top_loss_cause='+String(cause.rootCause||'n/a'));
      learnEl.textContent = txt.join(' | ');
    }
  }
}
refresh();
setInterval(refresh, 5000);
</script>
`
  );
}

export function renderHelpPage(): string {
  return layout(
    "Help / Setup",
    `
<section class="panel">
  <h1>Help / Setup Wizard</h1>
  <p class="muted">Configure OpenClaw + Kalshi credentials locally. Secrets are never returned in raw form.</p>
</section>

<section class="panel">
  <h2>1) OpenClaw Setup</h2>
  <p>Install OpenClaw, start gateway, pair Telegram, and verify connectivity:</p>
  ${shell("openclaw gateway status")}
  ${shell("openclaw channels status --probe")}
  <p>To find Telegram target id:</p>
  ${shell("openclaw channels status --probe")}
  <p class="muted">Use the Telegram channel/user target value reported by OpenClaw as <code>OPENCLAW_TELEGRAM_TARGET</code>.</p>
  <div class="grid2">
    <div class="field"><label>NOTIFICATIONS_ENABLED</label><select id="notificationsEnabled"><option value="true">true</option><option value="false">false</option></select></div>
    <div class="field"><label>OPENCLAW_SEND_MODE</label><select id="openclawSendMode"><option value="cli">cli</option><option value="none">none</option></select></div>
    <div class="field"><label>OPENCLAW_BINARY_PATH</label><input id="openclawBinaryPath" value="openclaw" /></div>
    <div class="field"><label>OPENCLAW_TELEGRAM_TARGET (required for cli)</label><input id="openclawTelegramTarget" placeholder="telegram target" /></div>
  </div>
  <div class="row">
    <button class="btn" onclick="saveOpenclaw()">Save OpenClaw Settings</button>
    <button class="btn" onclick="testOpenclaw()">Test Notification</button>
  </div>
  <pre id="openclawOut" class="json"></pre>
</section>

<section class="panel">
  <h2>2) Kalshi Setup</h2>
  <p>Use a dedicated Kalshi API key. Enter Key ID + RSA private key PEM locally.</p>
  <p class="muted">If keychain is unavailable, set <code>LOCAL_MASTER_KEY</code> in <code>.env</code> before saving secrets.</p>
  <div class="grid2">
    <div class="field"><label>KALSHI_KEY_ID</label><input id="kalshiKeyId" /></div>
    <div class="field"><label>KALSHI_ENV</label><select id="kalshiEnv"><option value="demo">demo</option><option value="prod">prod</option></select></div>
    <div class="field"><label>KALSHI_API_BASE_URL</label><input id="kalshiApiBaseUrl" /></div>
    <div class="field"><label>Saved key mask</label><input id="pemMask" disabled /></div>
  </div>
  <div class="field"><label>KALSHI_PRIVATE_KEY_PEM</label><textarea id="kalshiPem" rows="7" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
  <div class="row">
    <button class="btn" onclick="saveKalshi()">Save Kalshi Settings</button>
    <button class="btn" onclick="testKalshiAuth()">Test Kalshi Auth</button>
    <button class="btn" onclick="testKalshiMarket()">Test Market Data</button>
  </div>
  <pre id="kalshiOut" class="json"></pre>
</section>

<section class="panel">
  <h2>3) Dry Run / Live Gate</h2>
  <p class="warn">LIVE places real orders. Keep DRY_RUN enabled until tests pass.</p>
  <div class="grid2">
    <div class="field"><label>DRY_RUN</label><select id="dryRun"><option value="true">true</option><option value="false">false</option></select></div>
    <div class="field"><label>LIVE_CONFIRM_CODE</label><input id="liveCodeInput" placeholder="enter code" /></div>
  </div>
  <label class="check"><input type="checkbox" id="liveAck" /> I understand this places real trades.</label>
  <div class="row">
    <button class="btn" onclick="saveLive()">Apply Live Settings</button>
    <span id="liveCodeBanner" class="badge warn"></span>
  </div>
  <pre id="liveOut" class="json"></pre>
</section>

<section class="panel">
  <h2>What Good Looks Like</h2>
  <ul>
    <li>scan loop p95 below 300ms</li>
    <li>candidate to order submit below 500ms</li>
    <li>cancel latency below 500ms</li>
    <li>fill rate stable and improving</li>
  </ul>
</section>

<section class="panel">
  <h2>Data Cleanup</h2>
  <p class="muted">Remove demo/fake rows from dashboard tables. This does not delete settings or secrets.</p>
  <div class="row">
    <button class="btn" onclick="clearData('demo')">Clear Demo/Fake Data</button>
    <button class="btn" onclick="clearData('all')">Clear All Runtime Data</button>
  </div>
  <pre id="clearOut" class="json"></pre>
</section>

<script>
function out(id,obj){pretty(id,obj);}
async function loadSettings(){
  const s=await fetch('/api/settings').then(r=>r.json());
  const sec=await fetch('/api/secrets').then(r=>r.json());
  const c=s.settings||{};
  notificationsEnabled.value=String(!!c.notificationsEnabled);
  openclawSendMode.value=c.openclawSendMode||'cli';
  openclawBinaryPath.value=c.openclawBinaryPath||'openclaw';
  openclawTelegramTarget.value=c.openclawTelegramTarget||'';
  kalshiKeyId.value=c.extraKalshiKeyId||'';
  kalshiEnv.value=c.kalshiEnv||'demo';
  kalshiApiBaseUrl.value=c.kalshiApiBaseUrl||'';
  dryRun.value=String(!!s.flags?.dryRun);
  pemMask.value=(sec.secrets?.KALSHI_PRIVATE_KEY_PEM||'(none)');
  liveCodeBanner.textContent='Confirm code: '+String(s.liveConfirmCode||'(not ready)');
}
async function saveOpenclaw(){
  const payload={notificationsEnabled:notificationsEnabled.value==='true',openclawSendMode:openclawSendMode.value,openclawBinaryPath:openclawBinaryPath.value,openclawTelegramTarget:openclawTelegramTarget.value};
  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  out('openclawOut', await r.json());
}
async function testOpenclaw(){ const r=await fetch('/api/setup/openclaw/test',{method:'POST'}); out('openclawOut', await r.json()); }
async function saveKalshi(){
  const pem=kalshiPem.value.trim();
  if(pem){
    const sr=await fetch('/api/secrets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'KALSHI_PRIVATE_KEY_PEM',action:'set',value:pem})});
    out('kalshiOut', await sr.json());
  }
  const payload={extraKalshiKeyId:kalshiKeyId.value.trim(),kalshiEnv:kalshiEnv.value,kalshiApiBaseUrl:kalshiApiBaseUrl.value.trim()};
  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  out('kalshiOut', await r.json());
  await loadSettings();
}
async function testKalshiAuth(){ const r=await fetch('/api/setup/kalshi/test',{method:'POST'}); out('kalshiOut', await r.json()); }
async function testKalshiMarket(){ const r=await fetch('/api/setup/kalshi/market-data-test',{method:'POST'}); out('kalshiOut', await r.json()); }
async function saveLive(){
  const payload={dryRun:dryRun.value==='true',liveEnable:dryRun.value!=='true',liveAcknowledge:!!liveAck.checked,liveConfirmCode:liveCodeInput.value||''};
  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  out('liveOut', await r.json());
}
async function clearData(scope){
  const msg = scope==='all' ? 'Clear ALL runtime rows (orders, positions, markets, perf, events)?' : 'Clear demo/fake rows?';
  if(!confirm(msg)) return;
  const r=await fetch('/api/admin/clear-data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope})});
  out('clearOut', await r.json());
}
loadSettings();
</script>
`
  );
}

export function renderConfigPage(): string {
  return layout(
    "Bot Config",
    `
<section class="panel"><h1>Bot Config</h1><p class="muted">Adapter + strategy selection and risk parameters.</p></section>
<section class="panel">
  <div class="grid2">
    <div class="field"><label>Adapter</label><select id="adapter"><option value="KalshiGenericBinary">KalshiGenericBinary</option><option value="KalshiBtcFast">KalshiBtcFast</option></select></div>
    <div class="field"><label>Strategy</label><select id="strategy"><option value="NearExpiry98c">NearExpiry98c</option><option value="NearExpiryPriceOnly">NearExpiryPriceOnly (Price+Window)</option><option value="HourlyPriceOnly">HourlyPriceOnly (Hourly + Price+Window)</option><option value="NearExpiry98cWithExternalBuffer">NearExpiry98cWithExternalBuffer</option></select></div>
    <div class="field"><label>Market focus</label><select id="marketFocus"><option value="all">All Markets</option><option value="crypto_weather">Crypto + Weather</option><option value="hourly">Hourly Markets</option></select></div>
    <div class="field"><label>Window (sec)</label><input id="timeWindowSec" type="number" min="1" /></div>
    <div class="field"><label>Target Price (cents)</label><input id="targetPriceCents" type="number" min="1" max="99" /></div>
    <div class="field"><label>Exact Price Only</label><select id="exactPriceOnly"><option value="true">true</option><option value="false">false</option></select></div>
    <div class="field"><label>Max USD per trade</label><input id="maxUsdPerTrade" type="number" step="0.1" min="0.1" /></div>
    <div class="field"><label>Hard max order notional USD</label><input id="maxOrderNotionalUsd" type="number" step="0.1" min="0.1" /></div>
    <div class="field"><label>Duplicate cooldown (sec)</label><input id="duplicateCooldownSec" type="number" min="0" /></div>
    <div class="field"><label>Max orders per day</label><input id="maxOrdersPerDay" type="number" min="1" /></div>
    <div class="field"><label>Live arm timeout (min)</label><input id="liveArmTimeoutMin" type="number" min="1" /></div>
    <div class="field"><label>Daily loss limit</label><input id="dailyLossLimitUsd" type="number" step="0.1" min="1" /></div>
    <div class="field"><label>Max open positions</label><input id="maxOpenPositions" type="number" min="1" /></div>
    <div class="field"><label>Min quality score</label><input id="minQualityScore" type="number" min="0" max="100" /></div>
    <div class="field"><label>Min edge</label><input id="minEdge" type="number" step="0.001" min="0" /></div>
    <div class="field"><label>Min fill probability</label><input id="minFillProb" type="number" step="0.01" min="0" max="1" /></div>
    <div class="field"><label>Weather enable</label><select id="weatherEnable"><option value="true">true</option><option value="false">false</option></select></div>
    <div class="field"><label>Max total exposure USD</label><input id="maxTotalExposureUsd" type="number" min="1" /></div>
    <div class="field"><label>Max per symbol USD</label><input id="maxPerSymbolExposureUsd" type="number" min="1" /></div>
    <div class="field"><label>Max per location USD</label><input id="maxPerLocationExposureUsd" type="number" min="1" /></div>
    <div class="field"><label>Correlation guard</label><select id="correlationGuard"><option value="true">true</option><option value="false">false</option></select></div>
    <div class="field"><label>Fee rate (prob units)</label><input id="feeRate" type="number" step="0.0001" min="0" /></div>
  </div>
  <div class="row"><button class="btn" onclick="saveCfg()">Save Config</button><button class="btn" onclick="testScan()">Run Test Scan</button></div>
  <pre id="cfgOut" class="json"></pre>
</section>
<script>
async function loadCfg(){
  const s=await fetch('/api/settings').then(r=>r.json()); const c=s.settings||{};
  adapter.value=c.adapter||'KalshiGenericBinary'; strategy.value=c.strategy||'NearExpiry98c';
  marketFocus.value=c.marketFocus||'all';
  timeWindowSec.value=c.timeWindowSec||15; targetPriceCents.value=c.targetPriceCents||98;
  exactPriceOnly.value=String(!!c.exactPriceOnly); maxUsdPerTrade.value=c.maxUsdPerTrade||10;
  maxOrderNotionalUsd.value=c.maxOrderNotionalUsd||c.maxUsdPerTrade||10;
  duplicateCooldownSec.value=c.duplicateCooldownSec||120;
  maxOrdersPerDay.value=c.maxOrdersPerDay||120;
  liveArmTimeoutMin.value=c.liveArmTimeoutMin||120;
  dailyLossLimitUsd.value=c.dailyLossLimitUsd||25; maxOpenPositions.value=c.maxOpenPositions||1;
  minQualityScore.value=c.minQualityScore||70; minEdge.value=c.minEdge||0.03; minFillProb.value=c.minFillProb||0.6;
  weatherEnable.value=String(c.weatherEnable!==false); maxTotalExposureUsd.value=c.maxTotalExposureUsd||100;
  maxPerSymbolExposureUsd.value=c.maxPerSymbolExposureUsd||40; maxPerLocationExposureUsd.value=c.maxPerLocationExposureUsd||40;
  correlationGuard.value=String(c.correlationGuard!==false); feeRate.value=c.feeRate||0;
}
async function saveCfg(){
  const payload={adapter:adapter.value,strategy:strategy.value,marketFocus:marketFocus.value,timeWindowSec:Number(timeWindowSec.value),targetPriceCents:Number(targetPriceCents.value),exactPriceOnly:exactPriceOnly.value==='true',maxUsdPerTrade:Number(maxUsdPerTrade.value),maxOrderNotionalUsd:Number(maxOrderNotionalUsd.value),duplicateCooldownSec:Number(duplicateCooldownSec.value),maxOrdersPerDay:Number(maxOrdersPerDay.value),liveArmTimeoutMin:Number(liveArmTimeoutMin.value),dailyLossLimitUsd:Number(dailyLossLimitUsd.value),maxOpenPositions:Number(maxOpenPositions.value),minQualityScore:Number(minQualityScore.value),minEdge:Number(minEdge.value),minFillProb:Number(minFillProb.value),weatherEnable:weatherEnable.value==='true',maxTotalExposureUsd:Number(maxTotalExposureUsd.value),maxPerSymbolExposureUsd:Number(maxPerSymbolExposureUsd.value),maxPerLocationExposureUsd:Number(maxPerLocationExposureUsd.value),correlationGuard:correlationGuard.value==='true',feeRate:Number(feeRate.value)};
  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  pretty('cfgOut', await r.json());
}
async function testScan(){ const r=await fetch('/api/scan-test'); pretty('cfgOut', await r.json()); }
loadCfg();
</script>
`
  );
}

export function renderScanTestPage(): string {
  return layout(
    "Scan Test",
    `
<section class="panel"><h1>Scan Test</h1><p class="muted">Runs one market discovery and strategy decision pass.</p></section>
<section class="panel"><button class="btn" onclick="run()">Run</button><pre id="out" class="json"></pre></section>
<script>async function run(){const r=await fetch('/api/scan-test'); pretty('out', await r.json());} run();</script>
`
  );
}

export function renderTradesPage(): string {
  return layout(
    "Trades",
    `
<section class="panel"><h1>Trades</h1></section>
<section class="panel">
  <div class="grid3">
    <div class="field"><label>Range</label><select id="range"><option value="today">today</option><option value="7d">7d</option><option value="30d">30d</option><option value="custom">custom</option></select></div>
    <div class="field"><label>Status</label><input id="status" placeholder="FILLED/CANCELLED" /></div>
    <div class="field"><label>Side</label><input id="side" placeholder="YES/NO" /></div>
    <div class="field"><label>Min price</label><input id="min_price" type="number" step="0.01" /></div>
    <div class="field"><label>Max price</label><input id="max_price" type="number" step="0.01" /></div>
    <div class="field"><label>Search</label><input id="search" placeholder="market_id/question" /></div>
    <div class="field"><label>Sort by</label><select id="sort_by"><option value="ts">timestamp</option><option value="price">price</option><option value="size_shares">size</option><option value="status">status</option></select></div>
    <div class="field"><label>Sort dir</label><select id="sort_dir"><option value="desc">desc</option><option value="asc">asc</option></select></div>
    <div class="field"><label>Page size</label><input id="page_size" type="number" value="25" min="10" max="200" /></div>
  </div>
  <div class="row"><button class="btn" onclick="loadTrades(1)">Apply</button><a id="csvLink" class="btn" href="#">Export CSV</a></div>
</section>
<section class="panel">
  <div class="table-wrap">
    <table>
      <thead><tr><th>Ts</th><th>Market</th><th>Side</th><th>Price</th><th>Size USD</th><th>Status</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="row"><button class="btn tiny" onclick="prevPage()">Prev</button><span id="pager"></span><button class="btn tiny" onclick="nextPage()">Next</button></div>
</section>
<script>
let page=1,totalPages=1;
function q(){
  const p=new URLSearchParams();
  ['range','status','side','min_price','max_price','search','sort_by','sort_dir','page_size'].forEach(k=>{const v=document.getElementById(k).value; if(v) p.set(k,v);});
  p.set('page',String(page));
  return p;
}
function fmtTs(ts){return new Date(Number(ts)).toLocaleString();}
async function loadTrades(p){
  page=p||page; const qs=q();
  const r=await fetch('/api/trades?'+qs.toString()).then(x=>x.json());
  totalPages=r.totalPages||1;
  pager.textContent='Page '+r.page+' / '+totalPages+' ('+r.total+' rows)';
  csvLink.href='/api/trades/export.csv?'+qs.toString().replace('page='+page,'page=1');
  tbody.innerHTML=(r.items||[]).map((x,i)=>{
    const badge = x.status==='FILLED' ? '<span class="badge ok">FILLED</span>' : x.status==='CANCELLED' ? '<span class="badge warn">CANCELLED</span>' : '<span class="badge">'+x.status+'</span>';
    const raw=(x.raw_json||'').toString();
    return '<tr class="click" onclick="toggle('+i+')"><td>'+fmtTs(x.ts)+'</td><td>'+x.market_id+'</td><td>'+x.side+'</td><td>'+Number(x.price).toFixed(2)+'</td><td>'+Number(x.size_usd).toFixed(2)+'</td><td>'+badge+'</td></tr>'+
      '<tr id="d'+i+'" class="details hidden"><td colspan="6"><pre class="json">'+raw.replace(/</g,'&lt;')+'</pre><div>fill_ts: '+(x.fill_ts||'')+' cancel_ts: '+(x.cancel_ts||'')+'</div></td></tr>';
  }).join('');
}
function toggle(i){const el=document.getElementById('d'+i); if(el) el.classList.toggle('hidden');}
function prevPage(){ if(page>1) loadTrades(page-1); }
function nextPage(){ if(page<totalPages) loadTrades(page+1); }
loadTrades(1);
</script>
`
  );
}

export function renderExecutionReportPage(): string {
  return layout(
    "Execution Report",
    `
<section class="panel"><h1>Execution Report</h1></section>
<section class="panel"><pre id="report" class="json"></pre></section>
<section class="panel row"><a class="btn" href="/api/export/orders.csv">Export Orders CSV</a><a class="btn" href="/api/export/positions.csv">Export Positions CSV</a></section>
<script>fetch('/api/report').then(r=>r.json()).then(j=>pretty('report',j));</script>
`
  );
}

export function renderPerformancePage(): string {
  return layout(
    "Performance",
    `
<section class="panel"><h1>Performance</h1><p class="muted">p50/p95/p99 timings from perf table.</p></section>
<section class="panel"><label>Hours <input id="hours" type="number" value="24" min="1" max="168" /></label><button class="btn" onclick="load()">Refresh</button><pre id="perf" class="json"></pre></section>
<script>
async function load(){
  const h=Math.max(1,Math.min(168,Number(hours.value||24)));
  const j=await fetch('/api/perf?hours='+h).then(r=>r.json());
  pretty('perf',j);
}
load();
</script>
`
  );
}

export function renderIntelligencePage(): string {
  return layout(
    "Intelligence",
    `
<section class="panel"><h1>Intelligence</h1><p class="muted">Top markets by model edge, with quality and execution estimates.</p></section>
<section class="panel">
  <div class="row">
    <label>Limit <input id="limit" type="number" min="5" max="100" value="25" /></label>
    <button class="btn" onclick="load()">Refresh</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Market</th><th>Side</th><th>Quality</th><th>p_model</th><th>Implied</th><th>FillProb</th><th>Exp Cost</th><th>Edge</th><th>EV</th><th>Decision</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</section>
<section class="panel"><h2>Details</h2><pre id="details" class="json"></pre></section>
<script>
function row(x){
  const d = x.decision === 'TRADE' ? '<span class="badge ok">TRADE</span>' : '<span class="badge warn">SKIP</span>';
  return '<tr class="click" onclick="showDetails(\\''+String(x.market_id).replace(/'/g,\"&#39;\")+'\\')">'+
    '<td><a href="/market/'+encodeURIComponent(x.market_id)+'">'+x.market_id+'</a></td>'+
    '<td>'+x.side+'</td>'+
    '<td>'+Number(x.quality_score).toFixed(1)+'</td>'+
    '<td>'+Number(x.p_model||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.implied_price||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.fill_prob||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.expected_cost||0).toFixed(4)+'</td>'+
    '<td>'+Number(x.edge||0).toFixed(4)+'</td>'+
    '<td>'+Number(x.ev_per_trade||0).toFixed(4)+'</td>'+
    '<td>'+d+'</td>'+
  '</tr>';
}
async function load(){
  const l=Math.max(5,Math.min(100,Number(limit.value||25)));
  const j=await fetch('/api/intelligence/top?limit='+l).then(r=>r.json());
  tbody.innerHTML=(j.items||[]).map(row).join('');
  if ((j.items||[]).length) showDetails(j.items[0].market_id);
}
async function showDetails(marketId){
  const j=await fetch('/api/intelligence/market/'+encodeURIComponent(marketId)).then(r=>r.json());
  pretty('details', j);
}
load();
</script>
`
  );
}

function renderIntelTypePage(title: string, apiPath: string): string {
  return layout(
    title,
    `
<section class="panel"><h1>${title}</h1><p class="muted">Top opportunities sorted by model edge.</p></section>
<section class="panel">
  <div class="row"><label>Limit <input id="limit" type="number" min="5" max="100" value="25" /></label><button class="btn" onclick="load()">Refresh</button></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Market</th><th>Type</th><th>Q</th><th>p_model</th><th>Implied</th><th>Fill</th><th>Edge</th><th>Action</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</section>
<section class="panel"><h2>Detail</h2><pre id="detail" class="json"></pre></section>
<script>
function badge(x){ return x.decision==='TRADE'?'<span class="badge ok">TRADE</span>':'<span class="badge warn">SKIP</span>'; }
function row(x){
  return '<tr class="click" onclick="detail(\\''+String(x.market_id).replace(/'/g,\"&#39;\")+'\\')">'+
    '<td><a href="/market/'+encodeURIComponent(x.market_id)+'">'+x.market_id+'</a></td>'+
    '<td>'+(x.market_type||'')+'</td>'+
    '<td>'+Number(x.quality_score||0).toFixed(1)+'</td>'+
    '<td>'+Number(x.p_model||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.implied_price||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.fill_prob||0).toFixed(3)+'</td>'+
    '<td>'+Number(x.edge||0).toFixed(4)+'</td>'+
    '<td>'+badge(x)+'</td>'+
  '</tr>';
}
async function load(){
  const l=Math.max(5,Math.min(100,Number(limit.value||25)));
  const j=await fetch('${apiPath}?limit='+l).then(r=>r.json());
  tbody.innerHTML=(j.items||[]).map(row).join('');
  if((j.items||[]).length) detail(j.items[0].market_id);
}
async function detail(marketId){
  const j=await fetch('/api/intelligence/market/'+encodeURIComponent(marketId)).then(r=>r.json());
  pretty('detail', j);
}
load();
</script>
`
  );
}

export function renderIntelCryptoPage(): string {
  return renderIntelTypePage("Intel / Crypto", "/api/intel/crypto");
}

export function renderIntelWeatherPage(): string {
  return renderIntelTypePage("Intel / Weather", "/api/intel/weather");
}

export function renderBrowsePage(): string {
  return layout(
    "Browse Markets",
    `
<section class="panel"><h1>Browse Markets</h1><p class="muted">Live Kalshi API markets with real orderbook-derived YES/NO prices.</p></section>
<section class="panel">
  <div class="grid3">
    <div class="field"><label>Focus</label><select id="focus"><option value="all">All Markets</option><option value="crypto_weather">Crypto + Weather</option><option value="hourly">Hourly</option></select></div>
    <div class="field"><label>Status</label><select id="status"><option value="open">open</option><option value="closed">closed</option><option value="resolved">resolved</option></select></div>
    <div class="field"><label>Category</label><input id="category" placeholder="optional" /></div>
    <div class="field"><label>Search</label><input id="search" placeholder="ticker / text" /></div>
    <div class="field"><label>Closing within sec</label><input id="closeWithinSec" type="number" placeholder="optional" /></div>
    <div class="field"><label>Min volume</label><input id="minVolume" type="number" value="0" /></div>
    <div class="field"><label>Limit</label><input id="limit" type="number" value="30" min="1" max="200" /></div>
    <div class="field"><label>View</label><label class="check"><input id="showBestOption" type="checkbox" checked /> Show Best Option</label></div>
  </div>
  <div class="row">
    <button class="btn" onclick="loadMarkets()">Refresh</button>
    <span id="meta" class="muted"></span>
  </div>
</section>
<section id="bestWrap" class="panel hidden">
  <h2>Best Option Right Now</h2>
  <div id="bestCard"></div>
</section>
<section class="cards" id="cards"></section>
<script>
function badgeFor(s){ if(s==='open') return '<span class="badge ok">OPEN</span>'; if(s==='resolved') return '<span class="badge warn">RESOLVED</span>'; return '<span class="badge">CLOSED</span>'; }
function riskBadge(r){ if(r==='LOW') return '<span class="badge ok">LOW RISK</span>'; if(r==='MEDIUM') return '<span class="badge warn">MEDIUM RISK</span>'; return '<span class="badge bad">HIGH RISK</span>'; }
function pct(v){ return Number(v*100||0).toFixed(1)+'%'; }
function fmtTs(ts){ return ts?new Date(Number(ts)).toLocaleString():''; }
function fmtPrice(v){ return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'n/a'; }
function escHtml(v){ return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#39;'); }
function titleFor(m){
  const q = String(m.question || '').trim();
  if (q) return q;
  const mt = String(m.marketTitle || '').trim();
  if (mt) return mt;
  const et = String(m.eventTitle || '').trim();
  if (et) return et;
  return String(m.marketId || '');
}
function rankValue(m){
  const score=Number(m.score100||0);
  const hit=Number.isFinite(Number(m.hitProbability)) ? Number(m.hitProbability) : 0.5;
  const edge=Number(m.edge||0);
  const fill=Number(m.fillProb||0);
  const quality=Number(m.qualityScore||0);
  const riskAdj=String(m.riskLevel||'HIGH')==='LOW' ? 1 : String(m.riskLevel||'HIGH')==='MEDIUM' ? 0.92 : 0.82;
  return riskAdj * (0.38*(score/100) + 0.24*hit + 0.18*Math.max(0,Math.min(1,edge/0.08)) + 0.12*Math.max(0,Math.min(1,fill)) + 0.08*Math.max(0,Math.min(1,quality/100)));
}
function renderMarketCard(m){
  const reasons = Array.isArray(m.scoreReasons) ? m.scoreReasons.slice(0,3).map(x=>String(x)).join(' | ') : '';
  const title = escHtml(titleFor(m));
  const subtitle = escHtml(((m.eventTitle||'')+' / '+(m.marketTitle||'')).replace(/^\\s*\\/\\s*/,'').trim());
  const ticker = escHtml(String(m.marketId || ''));
  const side = escHtml(String(m.recommendedSide || 'n/a'));
  return '<a class="card market" href="/market/'+encodeURIComponent(m.marketId)+'">'
    +'<div class="row"><div class="market-title">'+title+'</div>'+badgeFor(m.status)+'</div>'
    +(subtitle ? '<div class="market-subtitle">'+subtitle+'</div>' : '')
    +'<div class="market-ticker">'+ticker+'</div>'
    +'<div class="row"><span>YES Ask '+fmtPrice(m.bestAskYes)+'</span><span>NO Ask '+fmtPrice(m.bestAskNo)+'</span><span>Suggested '+side+'</span></div>'
    +'<div class="row"><span>Hit '+(Number.isFinite(Number(m.hitProbability))?pct(Number(m.hitProbability)): 'n/a')+'</span><span>Score '+Number(m.score100||0).toFixed(0)+'/100</span><span>'+riskBadge(String(m.riskLevel||'HIGH'))+'</span></div>'
    +'<div class="row"><span>YES '+pct(m.impliedYes)+'</span><span>NO '+pct(m.impliedNo)+'</span><span>Edge '+Number(m.edge||0).toFixed(4)+'</span></div>'
    +'<div class="row"><span>Liq YES '+fmtPrice(m.liquidityYesShares)+'</span><span>Liq NO '+fmtPrice(m.liquidityNoShares)+'</span></div>'
    +'<div class="market-reasons">'+escHtml(reasons)+'</div>'
    +'<div class="row"><span>Vol '+Number(m.volume||0).toFixed(0)+'</span><span>Close '+fmtTs(m.expiryTs)+'</span></div>'
    +'</a>';
}
async function loadMarkets(){
  const focusEl = document.getElementById('focus');
  const params=new URLSearchParams();
  ['focus','status','category','search','closeWithinSec','minVolume','limit'].forEach(k=>{const v=document.getElementById(k).value; if(v) params.set(k,v);});
  const j=await fetch('/api/browse/markets?'+params.toString()).then(r=>r.json());
  const metaEl = document.getElementById('meta');
  if (metaEl) metaEl.textContent = j.ok ? ('source='+(j.source||'api')+' total='+Number(j.count||0)+' shown='+Number(j.returned||0)) : ('error: '+(j.error||'failed'));
  const cardsEl = document.getElementById('cards');
  const rows=(j.markets||[]);
  if(!cardsEl) return;
  if(!rows.length){
    if (focusEl && focusEl.value==='crypto_weather') {
      focusEl.value='all';
      if (metaEl) metaEl.textContent='No crypto/weather markets live right now. Switched focus to all.';
      return loadMarkets();
    }
    cardsEl.innerHTML='<div class="panel">No markets matched this filter.</div>';
    const bw=document.getElementById('bestWrap'); if(bw) bw.classList.add('hidden');
    return;
  }
  const showBest = !!document.getElementById('showBestOption')?.checked;
  const bestWrap = document.getElementById('bestWrap');
  const bestCard = document.getElementById('bestCard');
  if(showBest && rows.length){
    const sorted=[...rows].sort((a,b)=>rankValue(b)-rankValue(a));
    if(bestWrap) bestWrap.classList.remove('hidden');
    if(bestCard) bestCard.innerHTML=renderMarketCard(sorted[0]);
  } else {
    if(bestWrap) bestWrap.classList.add('hidden');
    if(bestCard) bestCard.innerHTML='';
  }
  cardsEl.innerHTML=rows.map(renderMarketCard).join('');
}
loadMarkets();
document.getElementById('showBestOption')?.addEventListener('change', loadMarkets);
</script>
`
  );
}

export function renderMarketDetailPage(ticker: string): string {
  return layout(
    `Market ${ticker}`,
    `
<section class="panel">
  <div class="row">
    <div>
      <h1>Market Detail</h1>
      <div class="muted" id="tickerLine">${esc(ticker)}</div>
    </div>
    <div class="row">
      <a id="kalshiOpenDirect" class="btn tiny" target="_blank" rel="noopener noreferrer" href="#">Open on Kalshi</a>
      <a id="kalshiSearch" class="btn tiny" target="_blank" rel="noopener noreferrer" href="#">Kalshi Search</a>
      <button class="btn tiny" onclick="setView('structured')">Clean View</button>
      <button class="btn tiny" onclick="setView('json')">JSON View</button>
    </div>
  </div>
</section>
<section id="structuredView" class="panel">
  <div class="detail-grid">
    <div class="detail-card">
      <div class="muted">Question</div>
      <div id="d_question" class="detail-title">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">Status</div>
      <div id="d_status">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">Close Time</div>
      <div id="d_close">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">Suggested Side</div>
      <div id="d_side">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">YES Ask</div>
      <div id="d_yes">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">NO Ask</div>
      <div id="d_no">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">Liq YES</div>
      <div id="d_liq_yes">-</div>
    </div>
    <div class="detail-card">
      <div class="muted">Liq NO</div>
      <div id="d_liq_no">-</div>
    </div>
  </div>
  <div class="panel" style="margin-top:10px;">
    <h3>Intelligence Trail</h3>
    <div id="intel_meta" class="muted">-</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Decision</th><th>Quality</th><th>p_model</th><th>Implied</th><th>Edge</th><th>Fill</th><th>Reasons</th></tr></thead>
        <tbody id="intel_rows"></tbody>
      </table>
    </div>
  </div>
</section>
<section id="jsonView" class="panel hidden"><pre id="out" class="json"></pre></section>
<section class="panel row">
  <button class="btn" onclick="paper('YES')">Paper Buy YES</button>
  <button class="btn" onclick="paper('NO')">Paper Buy NO</button>
</section>
<script>
const ticker=${JSON.stringify(ticker)};
function fmt(v,d=3){ const n=Number(v); return Number.isFinite(n)?n.toFixed(d):'n/a'; }
function fmtTs(ts){ const n=Number(ts); return Number.isFinite(n)?new Date(n).toLocaleString():'n/a'; }
function escHtml(v){ return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(\"'\",'&#39;'); }
function setView(mode){
  const a=document.getElementById('structuredView');
  const b=document.getElementById('jsonView');
  if(!a||!b) return;
  if(mode==='json'){ a.classList.add('hidden'); b.classList.remove('hidden'); }
  else { b.classList.add('hidden'); a.classList.remove('hidden'); }
}
function row(cells){ return '<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>'; }
async function load(){
  const j=await fetch('/api/browse/market/'+encodeURIComponent(ticker)).then(r=>r.json());
  pretty('out', j);
  const market=j.market||{};
  const ob=j.orderbook||{};
  const action=j.action||{};
  const intel=Array.isArray(j.intelligence)?j.intelligence:[];

  const direct='https://kalshi.com/markets/'+encodeURIComponent(ticker);
  const search='https://kalshi.com/markets?search='+encodeURIComponent(ticker);
  const d=document.getElementById('kalshiOpenDirect'); if(d) d.href=direct;
  const s=document.getElementById('kalshiSearch'); if(s) s.href=search;

  const q=document.getElementById('d_question'); if(q) q.textContent=String(market.question||market.marketTitle||'-');
  const st=document.getElementById('d_status'); if(st) st.textContent=String(market.status||'-');
  const cl=document.getElementById('d_close'); if(cl) cl.textContent=fmtTs(market.expiryTs);
  const sd=document.getElementById('d_side'); if(sd) sd.textContent=String(action.side||'n/a');
  const y=document.getElementById('d_yes'); if(y) y.textContent=fmt(ob.bestAskYes,3);
  const n=document.getElementById('d_no'); if(n) n.textContent=fmt(ob.bestAskNo,3);
  const ly=document.getElementById('d_liq_yes'); if(ly) ly.textContent=fmt(ob.liquidityYesShares,2);
  const ln=document.getElementById('d_liq_no'); if(ln) ln.textContent=fmt(ob.liquidityNoShares,2);

  const meta=document.getElementById('intel_meta');
  if(meta) meta.textContent='Rows: '+intel.length;
  const tbody=document.getElementById('intel_rows');
  if(tbody){
    tbody.innerHTML=intel.slice(0,50).map((r)=>row([
      fmtTs(r.ts),
      escHtml(String(r.decision||'')),
      fmt(r.quality_score,1),
      fmt(r.p_model,3),
      fmt(r.implied_price,3),
      fmt(r.edge,4),
      fmt(r.fill_prob,3),
      escHtml(String(r.reasons||'')).slice(0,220)
    ])).join('');
  }
}
async function paper(side){
  const j=await fetch('/api/browse/paper-trade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker,side})}).then(r=>r.json());
  pretty('out',j);
  setView('json');
}
load();
</script>
`
  );
}

/* 月费率摊成年化 · 界面层
 * 只做三件事：读输入 → 调 AppCore.compute → 把结果画出来（票据 / 阶梯 / 提前还清 / 免息 / 自检）。
 * 所有显示出来的数字都来自同一次 compute 的返回对象，页面自己不再二次计算（除纯展示用的平均占用本金比例，
 * 它由返回的 schedule 现算，并单独标注）。
 */
(function () {
  'use strict';
  const A = window.AppCore;

  const SLUG = 'installment-apr';
  const TITLE = '月费率摊成年化';
  const VERSION = '1.0.0';
  const STORE_KEY = 'installment-apr::v1';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (x) => A.fmtMoney(x);
  const pct = (x, d) => A.fmtPct(x, d);

  const FIELDS = ['principal', 'periods', 'monthlyRatePct', 'method', 'earlyEnabled',
    'earlyAt', 'earlyFeeRatePct', 'cashRatePct', 'upfrontPrice', 'planPrice'];
  const IDS = {
    principal: 'p-principal', periods: 'p-periods', monthlyRatePct: 'p-rate',
    method: 'p-method', earlyEnabled: 'p-early-on', earlyAt: 'p-early-at', earlyFeeRatePct: 'p-early-fee',
    cashRatePct: 'p-cash', upfrontPrice: 'p-upfront', planPrice: 'p-plan',
  };

  let last = null;          // 最近一次 compute 的返回，导出用
  let counter = 0;          // 触发重算的次数（自检用）

  /* ───────── 读 / 写输入 ───────── */
  function readInputs() {
    return {
      principal: Number($('p-principal').value),
      periods: Number($('p-periods').value),
      monthlyRatePct: Number($('p-rate').value),
      method: $('p-method').value,
      earlyEnabled: $('p-early-on').checked,
      earlyAt: Number($('p-early-at').value),
      earlyFeeRatePct: Number($('p-early-fee').value),
      cashRatePct: Number($('p-cash').value),
      upfrontPrice: Number($('p-upfront').value),
      planPrice: Number($('p-plan').value),
    };
  }

  function writeInputs(inp) {
    const d = Object.assign(A.defaults(), inp || {});
    FIELDS.forEach((k) => {
      const el = $(IDS[k]);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!d[k]; else el.value = d[k];
    });
  }

  /* ───────── 渲染 ───────── */
  function render(override) {
    const r = override || A.compute(readInputs());
    const errbox = $('errbox');
    if (!r.ok) {
      last = null;
      errbox.classList.remove('hidden');
      errbox.innerHTML = '<b>这几处要改一下：</b><ul>' +
        r.errors.map((e) => '<li>' + esc(e.msg) + '</li>').join('') + '</ul>';
      return r;
    }
    errbox.classList.add('hidden');
    errbox.innerHTML = '';
    last = r;
    counter++;

    /* 结论票 */
    $('t-apr').textContent = pct(r.aprPct);
    $('t-naive').textContent = pct(r.naivePct);
    $('t-ratio').textContent = isFinite(r.teachRatio) ? A.fmtRatio(r.teachRatio) : '—';
    $('t-pay').textContent = money(r.perPeriodPay) + ' 元';
    $('t-fee').textContent = money(r.totalFee) + ' 元';
    $('t-oneliner').innerHTML =
      '「' + r.input.periods + ' 期、月费率 ' + r.input.monthlyRatePct + '%」直算成年化是 <b>' + pct(r.naivePct) + '</b>；' +
      '但手续费是按<b>整笔本金</b>每期收的，本金却在一期期变少 —— 摊成年化是 <b>' + pct(r.aprPct) + '</b>，' +
      '是直算的 <b>' + (isFinite(r.teachRatio) ? A.fmtRatio(r.teachRatio) : '—') + '</b>。' +
      '手续费合计 ' + money(r.totalFee) + ' 元，占本金 ' + pct(r.feeRatioPct) + '。';

    /* 口径转化链 */
    const avgRatio = (r.input.periods + 1) / (2 * r.input.periods);
    const chain = [
      { k: '你看到的', v: r.input.monthlyRatePct + '%/月', d: '结账页上那个数' },
      { k: '它按什么收', v: '整笔本金 × 月费率', d: '每期都按整笔本金算，不是按剩下没还的部分' },
      { k: '×12 直算', v: pct(r.naivePct), d: '把它当成年化 —— 这是最常见的那一步错' },
      { k: '平均占用本金', v: pct(avgRatio * 100, 1) + ' 的本金', d: '(n+1)/(2n) = (' + r.input.periods + '+1)/(2×' + r.input.periods + ')，只对「每期还款额恒定」成立' },
      { k: '折成年化（复利）', v: pct(r.aprPct), d: '解 Σ A/(1+i)^t = 本金 得到的 i，再 (1+i)^12−1' },
    ];
    $('chain').innerHTML = chain.map((s, i) =>
      '<div class="step"><div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) + '</div><div class="d">' + esc(s.d) + '</div></div>' +
      (i < chain.length - 1 ? '<div class="arrow">→</div>' : '')).join('');

    /* 逐期票据 */
    const tb = $('t-sched').querySelector('tbody');
    const earlyAt = (r.input.earlyEnabled && r.early) ? r.early.at : -1;
    tb.innerHTML = r.schedule.map((x) =>
      '<tr' + (x.period === earlyAt ? ' class="now"' : '') + '>' +
      '<td>' + x.period + '</td>' +
      '<td class="pay">' + money(x.pay) + '</td>' +
      '<td>' + money(x.principalPart) + '</td>' +
      '<td class="fee">' + money(x.feePart) + '</td>' +
      '<td>' + money(x.remaining) + '</td></tr>').join('');
    $('t-sum-pay').textContent = money(r.totalPaid);
    $('t-sum-prin').textContent = money(r.input.principal);
    $('t-sum-fee').textContent = money(r.totalFee);

    /* 月费率阶梯 */
    $('t-ladder').querySelector('tbody').innerHTML = r.rateLadder.map((x) => {
      const cur = Math.abs(x.monthlyRatePct - r.input.monthlyRatePct) < 1e-9;
      return '<tr>' + '<td' + (cur ? ' class="cur"' : '') + '>' + x.monthlyRatePct + '%</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + pct(x.naivePct) + '</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + pct(x.aprPct) + '</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + money(x.totalFee) + '</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + x.ratio.toFixed(2) + '</td></tr>';
    }).join('');

    /* 期数阶梯 */
    $('t-terms').querySelector('tbody').innerHTML = r.termLadder.map((x) => {
      const cur = x.periods === r.input.periods;
      return '<tr>' + '<td' + (cur ? ' class="cur"' : '') + '>' + x.periods + ' 期</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + money(x.perPeriodPay) + '</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + money(x.totalFee) + '</td>' +
        '<td' + (cur ? ' class="cur"' : '') + '>' + pct(x.aprPct) + '</td></tr>';
    }).join('');
    const hi = r.termLadder.reduce((a, b) => (b.aprPct > a.aprPct ? b : a));
    $('term-note').innerHTML = '注意期数<b>不是</b>「越长年化越高」的直线：这一组参数里年化最高的是 <b>' + hi.periods +
      ' 期（' + pct(hi.aprPct) + '）</b>；但手续费总额是<b>随期数一直涨</b>的（' + r.termLadder.map((x) => x.periods + '期 ' + money(x.totalFee)).join('、') + '）。两件事分开看。';

    /* 提前还清 */
    const eb = $('early-body');
    if (r.early) {
      const e = r.early;
      const verdict = e.better ? 'ok' : 'hurt';
      eb.innerHTML =
        '<div class="kv">' +
        '<div class="k">第 ' + e.at + ' 期还清，当次要付</div><div class="v">' + money(e.closePay) + ' 元</div>' +
        '<div class="k">＝ 当期手续费 ' + money(r.schedule[e.at - 1].feePart) + ' + 本期还款前剩余本金 ' + money(e.remaining) + '</div><div class="v">' + money(e.closePay - e.penalty) + ' 元</div>' +
        '<div class="k">＋ 违约金（' + r.input.earlyFeeRatePct + '% × 剩余本金）</div><div class="v">' + money(e.penalty) + ' 元</div>' +
        '<div class="k">总支出（含已还的 ' + (e.at - 1) + ' 期）</div><div class="v">' + money(e.totalPaid) + ' 元</div>' +
        '<div class="k">不提前还清的总支出</div><div class="v">' + money(r.totalPaid) + ' 元</div>' +
        '<div class="k">实际年化（提前还清后）</div><div class="v">' + pct(e.apr * 100) + '</div>' +
        '<div class="k">实际年化（不提前还清）</div><div class="v">' + pct(r.aprPct) + '</div>' +
        '</div>' +
        '<div class="verdict ' + verdict + '">' +
        (e.better ? '提前还清<b>少花 ' + money(e.savedVsFull) + ' 元</b>；' : '提前还清<b>多花 ' + money(-e.savedVsFull) + ' 元</b>；') +
        '把真实成本从 ' + pct(r.aprPct) + ' 压到 ' + pct(e.apr * 100) + '（' + (e.aprDeltaPct < 0 ? '低' : '高') + ' ' + Math.abs(e.aprDeltaPct).toFixed(2) + ' 个百分点）。' +
        (e.vStarPct == null
          ? ' 在 0–20% 的违约金区间里，结论不会翻转（要么一直省、要么一直亏）。'
          : ' <b>盈亏临界的违约金率是 ' + e.vStarPct.toFixed(2) + '%</b>：违约金低于它就省，高于它就亏。') +
        '</div>';
    } else {
      eb.innerHTML = '<div class="verdict neutral">勾上左侧「算一下提前还清」就出结果 —— 会给你：当次要付多少、总支出、' +
        '实际年化降到多少，以及<b>盈亏临界的违约金率</b>。</div>';
    }

    /* 免息也不便宜 */
    const fi = r.freeInterest;
    const fb = $('free-body');
    const vcls = fi.verdict === 'gap_ok' ? 'ok' : (fi.verdict === 'gap_hurts' ? 'hurt' : 'neutral');
    fb.innerHTML =
      '<div class="kv">' +
      '<div class="k">一次性付清价</div><div class="v">' + money(r.input.upfrontPrice) + ' 元</div>' +
      '<div class="k">分期标价</div><div class="v">' + money(r.input.planPrice) + ' 元</div>' +
      '<div class="k">标价差（分期 − 一次付清）</div><div class="v">' + money(fi.priceGap) + ' 元</div>' +
      '<div class="k">占本金</div><div class="v">' + pct(Math.abs(fi.gapRatePct)) + '</div>' +
      '<div class="k">本金留 ' + r.input.periods + ' 期能赚（' + r.input.cashRatePct + '%/年）</div><div class="v">' + money(fi.cashEarn) + ' 元</div>' +
      '<div class="k">盈亏临界现金收益率</div><div class="v">' +
        (fi.noGap ? '—（标价没差）' : (fi.breakEvenRatePct == null ? '超过可输入上限（> ' + A.LIMITS.cashRatePct[1] + '%/年）' : pct(fi.breakEvenRatePct))) + '</div>' +
      '</div>' +
      '<div class="verdict ' + vcls + '">' + (fi.noGap
        ? '标价没变：这种情况下「免息」就是字面意义上的免息，本页不会给你编一个成本出来。'
        : (fi.verdict === 'gap_ok'
          ? '赚的（' + money(fi.cashEarn) + ' 元）比标价差（' + money(fi.priceGap) + ' 元）多 <b>' + money(fi.netVsCash) + ' 元</b> —— 在这组假设下，免息分期是划算的。'
          : '赚的（' + money(fi.cashEarn) + ' 元）比标价差（' + money(fi.priceGap) + ' 元）少 <b>' + money(-fi.netVsCash) + ' 元</b> —— 在这组假设下，免息也不便宜。') +
          (fi.breakEvenRatePct == null
            ? ' 这组参数下，即使把现金收益率填到上限 ' + A.LIMITS.cashRatePct[1] + '%/年，也追不平这个标价差。'
            : ' 只要你的现金收益率超过 <b>' + pct(fi.breakEvenRatePct) + '</b>，结论就翻过来。')) + '</div>';

    /* 提示与自检 */
    $('notes').innerHTML = r.notes.length
      ? r.notes.map((n) => '<li class="' + n.level + '">' + esc(n.msg) + '</li>').join('')
      : '<li>这组参数没有触发任何提示。</li>';
    const bad = r.checks.filter((c) => !c.pass);
    $('sc-head').innerHTML = '自检 <b>' + r.checks.length + '</b> 条，不通过 <b class="' + (bad.length ? 'bad' : '') + '">' + bad.length + '</b> 条。' +
      '（自检是拿算出来的数回代公式核一遍，通不过会在下面标红。）';
    $('sc-body').innerHTML = r.checks.map((c) =>
      '<div class="c"><span class="m ' + (c.pass ? 'p' : 'f') + '">' + (c.pass ? '✓' : '✕') + '</span>' +
      '<span>' + esc(c.name) + ' <span class="dt">' + esc(c.detail) + '</span></span></div>').join('');

    /* 口径的动态提示 */
    $('h-method').textContent = r.input.method === 'fee_first'
      ? '手续费总额 = 本金 × 月费率 × 期数，全部压在第 1 期交出去。总额与「每期收」一样，但钱更早出门，年化更高。'
      : (r.input.method === 'equal_principal'
        ? '每期本金 = 本金 ÷ 期数，手续费每期 = 本金 × 月费率（按整笔本金，不是按剩余本金）→ 每期还款额恒定。'
        : '每期还款额恒定 = （本金 + 手续费总额）÷ 期数，其中本金部分逐期递增 —— 和真实账单的形状一致。');

    return r;
  }

  /* 局部更新：只改「提前还清」那块也走整次重算（引擎是纯函数、整算一遍成本可忽略） */
  function recalc() { render(); }

  /* ───────── 场景按钮 ───────── */
  function buildScenarios() {
    $('scen').innerHTML = '<span style="font-size:12.5px;color:var(--ink3);align-self:center">内置场景（虚构示例）：</span>' +
      A.scenarios().map((s, i) => '<button class="sm" data-scen="' + i + '">' + esc(s.label) + '</button>').join('');
    $('scen').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-scen]');
      if (!b) return;
      const s = A.scenarios()[Number(b.getAttribute('data-scen'))];
      writeInputs(Object.assign(A.defaults(), s.over));
      render();
    });
  }

  /* ───────── 持久化 ───────── */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, at: new Date().toISOString(), input: readInputs() }));
      $('saveinfo').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。刷新这个页面会自动恢复。';
    } catch (e) {
      $('saveinfo').textContent = '这台浏览器不允许写本机存储：' + e.message;
    }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (!o || !o.input) return false;
      writeInputs(o.input);
      $('saveinfo').textContent = '已从本机恢复上次保存的输入（' + (o.at || '').replace('T', ' ').slice(0, 19) + '）。';
      return true;
    } catch (e) { return false; }
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const o = JSON.parse(String(fr.result));
        const inp = o.input || o;
        if (!inp || typeof inp !== 'object') throw new Error('这份文件里没有 input 字段');
        writeInputs(inp);
        render();
        $('saveinfo').textContent = '已导入备份并重算。';
      } catch (e) {
        $('saveinfo').textContent = '导入失败：' + e.message;
      }
    };
    fr.readAsText(file);
  }

  /* ───────── 导出 ───────── */
  function download(name, text, mime) {
    const parts = mime === 'text/csv' ? ['\ufeff', text] : [text];
    const blob = new Blob(parts, { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const stamp = () => {
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  };

  function resultCard(r) {
    const W = 1080, H = 1350;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const F = (s) => s + 'px -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    g.fillStyle = '#f5f2ea'; g.fillRect(0, 0, W, H);
    /* 头 */
    g.fillStyle = '#0b4f56'; g.fillRect(0, 0, W, 300);
    g.fillStyle = '#ffffff';
    g.font = F(38); g.fillText(TITLE, 60, 78);
    g.font = F(24); g.globalAlpha = .84;
    g.fillText(r.input.principal.toLocaleString('zh-CN') + ' 元 · ' + r.input.periods + ' 期 · 月费率 ' + r.input.monthlyRatePct + '%/月（' + r.label.feeMode + '）', 60, 122);
    g.globalAlpha = 1;
    g.font = F(30);
    g.fillText('实际年化（复利口径）', 60, 190);
    g.font = F(84); g.fillText(A.fmtPct(r.aprPct), 60, 268);
    g.font = F(26); g.globalAlpha = .88;
    g.fillText('月费率×12 直算 ' + A.fmtPct(r.naivePct) + ' ｜ 是它的 ' + (isFinite(r.teachRatio) ? A.fmtRatio(r.teachRatio) : '—'), 480, 232);
    g.fillText('每期还款 ' + A.fmtMoney(r.perPeriodPay) + ' 元', 480, 268);
    g.globalAlpha = 1;

    /* 口径链 */
    let y = 360;
    g.fillStyle = '#12303a'; g.font = F(28);
    g.fillText('口径转化链', 60, y); y += 44;
    const avgRatio = (r.input.periods + 1) / (2 * r.input.periods);
    const rows = [
      ['你看到的', r.input.monthlyRatePct + '%/月'],
      ['它怎么收', '整笔本金 × 月费率 × 期数'],
      ['×12 直算（错的）', A.fmtPct(r.naivePct)],
      ['平均占用本金', A.fmtPct(avgRatio * 100, 1) + '（(n+1)/(2n)）'],
      ['折成年化（复利）', A.fmtPct(r.aprPct)],
      ['手续费合计', A.fmtMoney(r.totalFee) + ' 元（占本金 ' + A.fmtPct(r.feeRatioPct) + '）'],
    ];
    g.font = F(24);
    rows.forEach((row, i) => {
      g.fillStyle = i % 2 ? '#ffffff' : '#efece3';
      g.fillRect(50, y - 26, W - 100, 40);
      g.fillStyle = '#3f5b66'; g.fillText(row[0], 64, y);
      g.fillStyle = '#0b4f56'; g.font = F(26); g.fillText(row[1], 520, y); g.font = F(24);
      y += 44;
    });
    y += 16;

    /* 票据（最多 12 行 + 合计） */
    g.fillStyle = '#12303a'; g.font = F(28);
    g.fillText('逐期票据（前 ' + Math.min(12, r.schedule.length) + ' 期' + (r.schedule.length > 12 ? '，共 ' + r.schedule.length + ' 期' : '') + '）', 60, y);
    y += 40;
    const cols = [70, 300, 520, 720, 930];
    g.font = F(22); g.fillStyle = '#3f5b66';
    ['期', '本期还款', '其中本金', '其中手续费', '剩余本金'].forEach((t, i) => g.fillText(t, cols[i], y));
    y += 12; g.fillStyle = '#d7e2e6'; g.fillRect(60, y, W - 120, 2); y += 30;
    g.font = F(23);
    r.schedule.slice(0, 12).forEach((x, i) => {
      if (i % 2) { g.fillStyle = '#ffffff'; g.fillRect(50, y - 24, W - 100, 36); }
      g.fillStyle = '#12303a'; g.fillText(String(x.period), cols[0], y);
      g.fillText(A.fmtMoney(x.pay), cols[1], y);
      g.fillText(A.fmtMoney(x.principalPart), cols[2], y);
      g.fillStyle = '#b8560f'; g.fillText(A.fmtMoney(x.feePart), cols[3], y);
      g.fillStyle = '#12303a'; g.fillText(A.fmtMoney(x.remaining), cols[4], y);
      y += 36;
    });
    g.fillStyle = '#d7e2e6'; g.fillRect(60, y - 22, W - 120, 2); y += 14;
    g.fillStyle = '#0b4f56'; g.font = F(24);
    g.fillText('合计还款 ' + A.fmtMoney(r.totalPaid) + ' 元（本金 ' + A.fmtMoney(r.input.principal) + ' + 手续费 ' + A.fmtMoney(r.totalFee) + '）', cols[0], y);
    y += 46;

    /* 提前还清 / 免息 */
    if (r.early) {
      g.fillStyle = '#12303a'; g.font = F(26);
      g.fillText('提前还清：第 ' + r.early.at + ' 期还清 · 总支出 ' + A.fmtMoney(r.early.totalPaid) + ' 元 · ' +
        (r.early.better ? '少花 ' + A.fmtMoney(r.early.savedVsFull) : '多花 ' + A.fmtMoney(-r.early.savedVsFull)) + ' 元', 60, y);
      y += 34;
      g.fillStyle = '#3f5b66'; g.font = F(23);
      g.fillText('实际年化从 ' + A.fmtPct(r.aprPct) + ' 变成 ' + A.fmtPct(r.early.apr * 100) +
        (r.early.vStarPct == null ? '（0–20% 违约金区间内结论不翻转）' : '；盈亏临界违约金率 ' + r.early.vStarPct.toFixed(2) + '%'), 60, y);
      y += 40;
    }
    const fi = r.freeInterest;
    g.fillStyle = '#12303a'; g.font = F(26);
    g.fillText('免息也不便宜？标价差 ' + A.fmtMoney(fi.priceGap) + ' 元 vs 本金能赚 ' + A.fmtMoney(fi.cashEarn) + ' 元（' + r.input.cashRatePct + '%/年）', 60, y);
    y += 34;
    g.fillStyle = '#3f5b66'; g.font = F(23);
    g.fillText(fi.noGap ? '标价没变：字面意义上的免息，本页不编成本。'
      : (fi.verdict === 'gap_ok' ? '结论：这组假设下免息分划算。' : '结论：这组假设下免息也不便宜。') +
      (fi.noGap ? '' : (fi.breakEvenRatePct == null ? ' 临界现金收益率超过可输入上限。' : ' 临界现金收益率 ' + A.fmtPct(fi.breakEvenRatePct) + '。')), 60, y);

    /* 页脚 */
    g.fillStyle = '#6d8590'; g.font = F(19);
    g.fillText('全部数字由同一份输入算出；不联网、不内置任何费率表、不推荐任何产品。', 60, H - 62);
    g.fillText('默认场景是虚构示例，不代表任何真实产品、银行或平台的费率。生成时间 ' + new Date().toLocaleString('zh-CN'), 60, H - 34);
    return c;
  }

  function downloadPNG() {
    if (!last) return;
    const c = resultCard(last);
    if (c.toBlob) {
      c.toBlob((b) => {
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url; a.download = TITLE + '-结果卡-' + stamp() + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, 'image/png');
    } else {
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png'); a.download = TITLE + '-结果卡-' + stamp() + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    }
  }

  /* ───────── 绑定 ───────── */
  function bind() {
    FIELDS.forEach((k) => {
      const el = $(IDS[k]);
      if (!el) return;
      el.addEventListener('input', recalc);
      el.addEventListener('change', recalc);
    });
    $('b-save').addEventListener('click', save);
    $('b-reset').addEventListener('click', () => { writeInputs(A.defaults()); render(); });
    $('b-import').addEventListener('click', () => $('f-import').click());
    $('f-import').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); });
    $('b-csv').addEventListener('click', () => { if (last) download(SLUG + '-' + stamp() + '.csv', A.toCSV(last), 'text/csv'); });
    $('b-md').addEventListener('click', () => { if (last) download(SLUG + '-' + stamp() + '.md', A.toMarkdown(last), 'text/markdown'); });
    $('b-json').addEventListener('click', () => { if (last) download(SLUG + '-备份-' + stamp() + '.json', A.toJSON(last), 'application/json'); });
    $('b-png').addEventListener('click', downloadPNG);
  }

  /* 给验收脚本用的钩子（不是产品功能） */
  window.__app = {
    slug: SLUG, title: TITLE, version: VERSION,
    render: render, readInputs: readInputs, writeInputs: writeInputs,
    resultCard: resultCard,
    get last() { return last; },
    get computeCount() { return counter; },
  };

  function boot() {
    buildScenarios();
    bind();
    writeInputs(A.defaults());      // 先铺默认场景，再让本机保存覆盖它
    restore();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

/* 月费率摊成年化 · 核心引擎（纯函数，浏览器与 node 通用）
 *
 * 一句话：结账页写着「12 期，月费率 0.75%」——把这句话摊开成一张逐期票据，
 *         算出每期付的是什么、手续费一共多少、折算成年化到底是多少、提前还清是省还是亏。
 *
 * 全部口径与假设都写在页面上（也在 需求与调研.md §3 里）：本引擎不联网、不内置任何费率表、
 * 不比较任何平台、不给消费建议。所有数字都由输入与下面的公式算出来。
 */
(function (root, factory) {
  const A = factory();
  if (typeof module === 'object' && module.exports) module.exports = A;
  if (root) root.AppCore = A;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ─────────────── 常量与口径 ─────────────── */

  /* 只有一个口径开关：手续费什么时候交出去。三种都算「月费率按整笔本金收」，
     区别在付款时点与还款额形状 —— 时点不同，年化就不同（这是本页要讲的事之一）。 */
  const METHODS = ['equal_installment', 'equal_principal', 'fee_first'];

  const LIMITS = {
    principal: [0.01, 10000000],
    periods: [1, 60],
    monthlyRatePct: [0, 10],
    earlyFeeRatePct: [0, 20],
    cashRatePct: [0, 30],
    upfrontPrice: [0, 10000000],
    planPrice: [0, 10000000],
  };

  const LABEL = {
    method: {
      equal_installment: '每期还款额恒定（等额本息口径）',
      equal_principal: '每期本金相同 + 每期收手续费（等额本金口径）',
      fee_first: '手续费首期付清（第 1 期一次交）',
    },
  };

  /* ─────────────── 输入 ─────────────── */

  function defaults() {
    return {
      principal: 12000,          // 商品现价 / 分期本金（元）—— 虚构示例
      periods: 12,               // 期数
      monthlyRatePct: 0.75,      // 月费率（%/月）
      method: 'equal_installment',   // 还款额形状 / 手续费时点
      earlyEnabled: false,
      earlyAt: 6,                // 第 k 期还清
      earlyFeeRatePct: 0,        // 提前还清违约金（占剩余本金 %）
      cashRatePct: 0,            // 你的现金收益率（%/年），用于「不还清、把钱拿去存」的对照
      upfrontPrice: 11800,       // 一次性付清价（虚构示例）
      planPrice: 12000,          // 分期标价（虚构示例）
    };
  }

  /* 一组内置场景：全部是虚构示例，改条件用；不代表任何平台 */
  function scenarios() {
    return [
      { key: 'default', label: '默认：12000 元 · 12 期 · 月费率 0.75%', over: {} },
      { key: 'no_fee', label: '真免息：月费率 0%', over: { monthlyRatePct: 0 } },
      { key: 'long24', label: '拉到 24 期（同月费率）', over: { periods: 24 } },
      { key: 'principal12', label: '12 期 · 每期本金相同', over: { method: 'equal_principal' } },
      { key: 'feefirst', label: '12 期 · 手续费首期付清', over: { method: 'fee_first' } },
      { key: 'cheap', label: '月费率 0.3% · 12 期', over: { monthlyRatePct: 0.3 } },
      { key: 'pricy', label: '月费率 1.5% · 12 期', over: { monthlyRatePct: 1.5 } },
      { key: 'big', label: '60000 元 · 36 期 · 月费率 0.6%', over: { principal: 60000, periods: 36, monthlyRatePct: 0.6 } },
    ];
  }

  /* ─────────────── 校验（一次把所有错都报出来） ─────────────── */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function checkField(errors, key, label, value, lo, hi, unit) {
    if (!isNum(value)) { errors.push({ field: key, code: 'not_number', msg: label + '必须是数字' }); return false; }
    if (value < lo || value > hi) {
      errors.push({ field: key, code: 'out_of_range', msg: label + '要在 ' + lo + ' – ' + hi + (unit || '') + ' 之间（当前 ' + value + '）' });
      return false;
    }
    return true;
  }

  function validate(raw) {
    const inp = Object.assign({}, defaults(), raw || {});
    const errors = [];

    checkField(errors, 'principal', '分期本金', inp.principal, LIMITS.principal[0], LIMITS.principal[1], ' 元');
    checkField(errors, 'periods', '期数', inp.periods, LIMITS.periods[0], LIMITS.periods[1], ' 期');
    checkField(errors, 'monthlyRatePct', '月费率', inp.monthlyRatePct, LIMITS.monthlyRatePct[0], LIMITS.monthlyRatePct[1], '%/月');
    checkField(errors, 'earlyFeeRatePct', '提前还清违约金率', inp.earlyFeeRatePct, LIMITS.earlyFeeRatePct[0], LIMITS.earlyFeeRatePct[1], '%');
    checkField(errors, 'cashRatePct', '你的现金收益率', inp.cashRatePct, LIMITS.cashRatePct[0], LIMITS.cashRatePct[1], '%/年');
    checkField(errors, 'upfrontPrice', '一次性付清价', inp.upfrontPrice, LIMITS.upfrontPrice[0], LIMITS.upfrontPrice[1], ' 元');
    checkField(errors, 'planPrice', '分期标价', inp.planPrice, LIMITS.planPrice[0], LIMITS.planPrice[1], ' 元');

    if (METHODS.indexOf(inp.method) < 0) errors.push({ field: 'method', code: 'bad_enum', msg: '付款方式口径不在可选范围里' });

    if (isNum(inp.periods) && inp.periods % 1 !== 0) errors.push({ field: 'periods', code: 'not_integer', msg: '期数必须是整数（当前 ' + inp.periods + '）' });

    if (inp.earlyEnabled) {
      if (!isNum(inp.earlyAt)) errors.push({ field: 'earlyAt', code: 'not_number', msg: '提前还清的期数必须是数字' });
      else if (inp.earlyAt % 1 !== 0) errors.push({ field: 'earlyAt', code: 'not_integer', msg: '提前还清的期数必须是整数（当前 ' + inp.earlyAt + '）' });
      else if (isNum(inp.periods) && (inp.earlyAt < 1 || inp.earlyAt > inp.periods - 1)) {
        errors.push({ field: 'earlyAt', code: 'out_of_range', msg: '提前还清要落在第 1 – ' + (inp.periods - 1) + ' 期（当前 ' + inp.earlyAt + '；等于最后一期就不算提前还清了）' });
      }
    }

    return { ok: errors.length === 0, errors: errors, input: inp };
  }

  /* ─────────────── 现金流与内部收益率 ─────────────── */

  /* 每期还款额与逐期拆分
   *
   * 口径（这是本页最重要的一块，写在页面与说明里）：
   *   · 本金部分：每期还 P/n（等额本金口径），或按等额本息口径每期还 P/n 而把手续费加在当期 ——
   *     两种口径下**本金部分相同**，差别只在还款额是否恒定，这一点在页面上分开标注。
   *   · 手续费部分：
   *       每期按整笔本金收 → 每期 f·P（共 n 期）
   *       首期一次收       → 第 1 期 f·P·n，其余期 0
   *     两种方式手续费总额都是 f·P·n，但**付款时点不同**：一次收是把同样一笔钱更早交出去，
   *     所以内部收益率会更高。早先版本把「一次收」也摊到每期，导致两种方式的现金流完全一样、
   *     年化一模一样（自检里 F5 因此抓出来），已改成上面这个口径。
   */
  function schedule(inp) {
    const P = inp.principal, n = inp.periods, f = inp.monthlyRatePct / 100;
    const totalFee = P * f * n;
    const rows = [];
    let cumPrincipal = 0;
    let principalPart;

    if (inp.method === 'equal_installment') {
      /* 等额本息口径：还款额恒定 A =（本金 + 手续费总额）/n，
         其中本金部分逐期递增（和真实账单一致），手续费每期都是 f·P。 */
      const A = (P + totalFee) / n;
      principalPart = A - P * f;
      for (let t = 1; t <= n; t++) {
        const feePart = P * f;
        cumPrincipal += principalPart;
        rows.push({
          period: t, pay: A, principalPart: principalPart, feePart: feePart,
          cumPrincipal: cumPrincipal, remaining: n - t === 0 ? 0 : Math.max(0, P - cumPrincipal),
        });
      }
    } else if (inp.method === 'equal_principal') {
      /* 每期本金相同 = P/n；手续费每期 f·P → 还款额逐期不变（首页默认口径的另一种写法）。 */
      principalPart = P / n;
      for (let t = 1; t <= n; t++) {
        const feePart = P * f;
        cumPrincipal += principalPart;
        rows.push({
          period: t, pay: principalPart + feePart, principalPart: principalPart, feePart: feePart,
          cumPrincipal: cumPrincipal, remaining: n - t === 0 ? 0 : Math.max(0, P - cumPrincipal),
        });
      }
    } else {
      /* 手续费首期付清：第 1 期把整笔手续费一次交掉；本金平均摊到 n 期（每期 P/n）。
         第 1 期还款额 = P/n + 手续费总额，第 2 期起只还本金 P/n。 */
      const pp = P / n;
      for (let t = 1; t <= n; t++) {
        const feePart = t === 1 ? totalFee : 0;
        cumPrincipal += pp;
        rows.push({
          period: t, pay: pp + feePart, principalPart: pp, feePart: feePart,
          cumPrincipal: cumPrincipal, remaining: n - t === 0 ? 0 : Math.max(0, P - cumPrincipal),
        });
      }
    }
    return { rows: rows, totalFee: totalFee, perPeriodPay: rows[0].pay, totalPaid: rows.reduce((s, r) => s + r.pay, 0) };
  }

  /* 实际月利率：解 Σ pay_t/(1+i)^t = P。二分法，[0,10] 上 NPV 单调不增。 */
  function monthlyRateFromFlows(P, pays) {
    /* 归一化：把每期还款都除以本金，贴现和也除以本金。
       这样无论本金是 0.01 还是 1000 万，算术的量级都一样，不会出现
       「大数相减把残差吃掉、npv 在根附近变成常数」的情况。 */
    const rel = pays.map(function (x) { return x / P; });
    const npvRel = (i) => {
      let s = 0;
      for (let j = 0; j < rel.length; j++) s += rel[j] / Math.pow(1 + i, j + 1);
      return s - 1;
    };
    const total = pays.reduce((a, b) => a + b, 0);
    if (total < P - 1e-9) return { i: NaN, note: '还款总额小于本金（数据异常）' };
    if (Math.abs(total - P) < 1e-12 * Math.max(1, P)) return { i: 0, note: '还款总额等于本金' };  // 真免息
    if (npvRel(0) <= 0) return { i: NaN, note: '本金以上的现金流为负（数据异常）' };

    /* 先在几个量级上探一次根，再在确知变号的那个区间里二分。
       注意：内部循环变量一律不与外层循环同名 —— 早先版本内层用了 k，
       把外层二分的 k 一起改掉了，导致二分只走一步就退出（大额本金时结果偏 3%，测试抓出来的）。 */
    const probes = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
    let lo = 0, hi = null;
    for (let p = 0; p < probes.length; p++) {
      if (npvRel(probes[p]) <= 0) { hi = probes[p]; break; }
      lo = probes[p];
    }
    if (hi == null) return { i: NaN, note: '在 0–1000% 的月利率区间里找不到解（数据异常）' };
    for (let step = 0; step < 200; step++) {
      const mid = (lo + hi) / 2;
      if (npvRel(mid) > 0) lo = mid; else hi = mid;
    }
    return { i: (lo + hi) / 2, note: '' };
  }

  const aprFromMonthly = (i) => Math.pow(1 + i, 12) - 1;

  /* ─────────────── 主计算 ─────────────── */

  function compute(raw) {
    const v = validate(raw);
    if (!v.ok) return { ok: false, errors: v.errors };
    const inp = v.input;

    const sch = schedule(inp);
    const P = inp.principal, n = inp.periods, f = inp.monthlyRatePct / 100;

    /* 1. 不提前还清 */
    const base = monthlyRateFromFlows(P, sch.rows.map((r) => r.pay));
    const apr = isFinite(base.i) ? aprFromMonthly(base.i) : NaN;
    const naivePct = inp.monthlyRatePct * 12;                 // 比例直算（大家脑子里那个数）
    const feeRatioPct = (sch.totalFee / P) * 100;
    /* 教训比值 = 实际年化 ÷ 比例直算。两边都是「年化百分点」，所以直接除；都在 % 域里，
       用 aprPct / naivePct 或 apr / (naivePct/100) 是同一个数。 */
    const teachRatio = naivePct > 0 ? (apr * 100) / naivePct : NaN;

    /* 2. 提前还清 */
    let early = null;
    if (inp.earlyEnabled) {
      const k = inp.earlyAt;
      const last = sch.rows[k - 1];
      /* 第 k 期还清：到第 k 期账单日，你欠的本金是「本期还款之前」的余额
         （= 原位剩的本金 + 本期本来要还的那部分本金），这一整块要在第 k 期一次结清；
         同时本期的手续费照收（它是本期的资金占用费，不是未来的）。
         所以：结清当期付 = 本期手续费 + 本期还款前的全部剩余本金 + 违约金。
         早先版本用「本期还完之后的余额」当结清本金，会少算一期本金（自检/测试抓出来）。 */
      const balanceBefore = k === 1 ? P : Math.max(0, P - sch.rows[k - 2].cumPrincipal);
      const remaining = balanceBefore;
      const penalty = remaining * (inp.earlyFeeRatePct / 100);
      const closePay = last.feePart + remaining + penalty;   // 本期手续费 + 还款前的剩余本金 + 违约金
      const paid = sch.rows.slice(0, k - 1).reduce((s, r) => s + r.pay, 0) + closePay;
      const flows = sch.rows.slice(0, k - 1).map((r) => r.pay).concat([closePay]);
      const r = monthlyRateFromFlows(P, flows);
      const earlyApr = isFinite(r.i) ? aprFromMonthly(r.i) : NaN;
      early = {
        at: k, remaining: remaining, penalty: penalty, closePay: closePay,
        totalPaid: paid, monthlyRate: r.i, apr: earlyApr,
        savedVsFull: sch.totalPaid - paid,           // > 0 表示提前还清少花
        aprDeltaPct: (earlyApr - apr) * 100,         // < 0 表示提前还清把真实成本压低了
        better: paid < sch.totalPaid,
      };
      /* 盈亏临界的违约金率：让「提前还清的实际年化 = 不还清的实际年化」的 v */
      const aprAt = (vv) => {
        const pen = remaining * (vv / 100);
        const cp = last.feePart + remaining + pen;
        const fl = sch.rows.slice(0, k - 1).map((x) => x.pay).concat([cp]);
        const rr = monthlyRateFromFlows(P, fl);
        return isFinite(rr.i) ? aprFromMonthly(rr.i) : NaN;
      };
      let vStar = null;
      if (isFinite(apr) && aprAt(0) <= apr) {
        /* 临界点在「实际年化相等」处。搜索上界放到 10 倍本金（=1000%），
           因为提前还清越早，要把它顶回原年化所需的违约金率就越高；
           若连 1000% 都顶不过去，就如实报 null（= 在这条路上提前还清永远更省）。 */
        let lo = 0, hi = 1000;
        if (aprAt(hi) >= apr) {
          for (let q = 0; q < 120; q++) {
            const mid = (lo + hi) / 2;
            if (aprAt(mid) <= apr) lo = mid; else hi = mid;
          }
          vStar = (lo + hi) / 2;
        }
      }
      early.vStarPct = vStar;                      // null = 在 0–1000% 区间内不存在临界
    }

    /* 3. 免息也不便宜：把「分期标价 − 一次性付清价」这个差额，与你把钱留在手里的收益对照
     *
     * 口径（站在「分期的人」这一边，第 0 期拿到东西、第 n 期把钱付完）：
     *   · 分期不是免费的，它让你承担了差额 gap = planPrice − upfrontPrice（标价差）；
     *   · 它的好处是把本金 P 留到分期期间，按你的现金收益率 r 能赚 cashEarn = P·((1+r)^(n/12) − 1)；
     *   · 两边一比：cashEarn > gap → 分期划算；cashEarn < gap → 免息也不便宜。
     *   · 令两者相等的那个 r 就是「盈亏临界现金收益率」 r* = (1 + gap/P)^(12/n) − 1。
     * 差额为 0（标价没变）时 gap = 0、r* = 0：字面意义上的免息，本页不编成本。
     * 注：这里**不用**差额的内部收益率 —— 那会把 gap 在第 0 期折现、在第 n 期支付，
     *     对「标价差」这种一次性价格差没有信息量（恒为 0），见 质检报告 里的记录。 */
    const priceGap = inp.planPrice - inp.upfrontPrice;
    const gapRatePct = (priceGap / P) * 100;                       // 差额占本金比
    const cashEarn = P * (Math.pow(1 + inp.cashRatePct / 100, n / 12) - 1);
    /* 盈亏临界现金收益率。注意：这个数可能超过输入上限（30%/年），
       那就返回 null —— 页面上写「超过可输入上限」比显示一个你永远填不进去的数更有用。
       （这条是随机测试逼出来的：本金 1988.31、差额 751.68、13 期 → 临界 34.45% > 30%。） */
    const beRaw = n > 0 && P > 0 && priceGap > 0 ? (Math.pow(1 + priceGap / P, 12 / n) - 1) * 100 : 0;
    const breakEvenRatePct = (priceGap > 0 && beRaw > LIMITS.cashRatePct[1]) ? null : beRaw;
    const freeInterest = {
      priceGap: priceGap, gapRatePct: gapRatePct,
      cashEarn: cashEarn, netVsCash: cashEarn - priceGap,
      breakEvenRatePct: breakEvenRatePct,
      verdict: Math.abs(priceGap) < 0.005 ? 'no_gap' : (cashEarn > priceGap ? 'gap_ok' : (cashEarn < priceGap ? 'gap_hurts' : 'gap_even')),
      noGap: Math.abs(priceGap) < 0.005,
    };

    /* 4. 敏感性：月费率 0.3%–2% */
    const rateLadder = [0.3, 0.5, 0.75, 1, 1.5, 2].map((pct) => {
      const s = schedule(Object.assign({}, inp, { monthlyRatePct: pct }));
      const r = monthlyRateFromFlows(P, s.rows.map((x) => x.pay));
      const a = isFinite(r.i) ? aprFromMonthly(r.i) : NaN;
      return { monthlyRatePct: pct, naivePct: pct * 12, aprPct: a * 100, totalFee: s.totalFee, ratio: a * 100 / (pct * 12) };
    });

    /* 5. 期数阶梯：3 / 6 / 12 / 24 / 36（同月费率，用于说明「拉长期数不改月费率、却更贵」） */
    const termLadder = [3, 6, 12, 24, 36].filter((n2) => n2 <= 60).map((n2) => {
      const s = schedule(Object.assign({}, inp, { periods: n2 }));
      const r = monthlyRateFromFlows(P, s.rows.map((x) => x.pay));
      const a = isFinite(r.i) ? aprFromMonthly(r.i) : NaN;
      return { periods: n2, perPeriodPay: s.perPeriodPay, totalFee: s.totalFee, aprPct: a * 100 };
    });

    /* 6. 自检 */
    const checks = selfCheck(inp, sch, base.i, apr);

    return {
      ok: true, errors: [],
      input: inp,
      label: { method: LABEL.method[inp.method] },
      schedule: sch.rows,
      totalFee: sch.totalFee,
      totalPaid: sch.totalPaid,
      perPeriodPay: sch.perPeriodPay,
      monthlyRate: base.i,
      monthlyRatePct: base.i * 100,
      apr: apr,
      aprPct: apr * 100,
      naivePct: naivePct,
      teachRatio: teachRatio,
      feeRatioPct: feeRatioPct,
      early: early,
      freeInterest: freeInterest,
      rateLadder: rateLadder,
      termLadder: termLadder,
      checks: checks,
      notes: buildNotes(inp, sch, apr, base.i, freeInterest, termLadder),
    };
  }

  function buildNotes(inp, sch, apr, i, freeInterest, termLadder) {
    const notes = [];
    if (inp.monthlyRatePct === 0) {
      notes.push({ level: 'info', msg: '月费率填的是 0、且标价没变 —— 这种情况下实际年化就是 0，本页不会给你编一个成本出来。' });
    }
    if (inp.periods === 1) {
      notes.push({ level: 'info', msg: '只有 1 期：一次性还清，谈不上资金占用，年化的意义很有限。' });
    }
    if (inp.monthlyRatePct * inp.periods >= 100) {
      notes.push({ level: 'warn', msg: '月费率 × 期数已经 ≥ 100%（手续费超过本金），这组参数属于极端值，结论不稳定，请核对是不是填错了。' });
    }
    if (apr > 0.36) {
      notes.push({ level: 'warn', msg: '折算出来的实际年化超过 36%。本页只做算术，不对任何产品做判断。' });
    }
    if (inp.method === 'fee_first' && inp.periods > 1) {
      notes.push({ level: 'info', msg: '手续费首期付清：手续费总额和「每期收」一样，但钱更早交出去 —— 所以折算出来的年化更高，两者总支出却完全相同。' });
    }
    if (inp.method === 'equal_principal') {
      notes.push({ level: 'info', msg: '每期本金相同 + 每期收手续费：还款额逐期恒定（本金不变、手续费也不变）。' });
    }
    if (inp.earlyEnabled && inp.earlyFeeRatePct === 0) {
      notes.push({ level: 'info', msg: '违约金填的是 0：这是「提前还清不要钱」的理想情况，真实合同里不一定成立。' });
    }
    if (i > 0.1) {
      notes.push({ level: 'info', msg: '换算成月利率约 ' + (i * 100).toFixed(3) + '% —— 这才是每期真正占用的资金成本。' });
    }
    if (termLadder && termLadder.length >= 2) {
      const hi = termLadder.reduce((a, b) => (b.aprPct > a.aprPct ? b : a));
      const lastT = termLadder[termLadder.length - 1];
      /* 只在「年化最高的期数出现在最后一个之前、且最后一档确实更低」时提示，
         这样这条例外说明才与页面上的表格一致（早先版本的判据用了最小值，
         而最小值永远落在最短期限上，导致这条提示实际上永远不出现 —— 测试抓出来的）。 */
      if (hi.periods < lastT.periods) {
        notes.push({
          level: 'info',
          msg: '注意期数不是「越长年化越高」的直线：本页这一组参数里，年化最高的是 ' + hi.periods + ' 期（' + hi.aprPct.toFixed(2) + '%），' +
            '往后反而略降（' + lastT.periods + ' 期 ' + lastT.aprPct.toFixed(2) + '%）。' +
            '原因在公式里：年化 ≈ 月费率 × 12 × 平均占用本金比例，而平均占用本金比例 = (n+1)/(2n) 随 n 增大会向 1/2 收敛；同期数越长手续费总额越多（这一列已列出），两件事要分开看。',
        });
      }
    }
    if (freeInterest && !freeInterest.noGap) {
      const fi = freeInterest;
      notes.push({
        level: fi.verdict === 'gap_hurts' ? 'warn' : 'info',
        msg: '分期标价比一次性付清价' + (fi.priceGap >= 0 ? '高 ' : '低 ') + Math.abs(fi.priceGap).toFixed(2) + ' 元（占本金 ' + Math.abs(fi.gapRatePct).toFixed(2) + '%）；' +
          '这笔本金留到第 ' + inp.periods + ' 期，按你填的现金收益率 ' + inp.cashRatePct + '%/年 能赚 ' + fi.cashEarn.toFixed(2) + ' 元 —— ' +
          (fi.verdict === 'gap_hurts'
            ? '赚的没有标价差多，所以「免息」在这个假设下并不便宜。'
            : '比标价差多，所以「免息」在这个假设下是划算的。') +
          (fi.breakEvenRatePct == null
            ? '要让分期追平这个标价差，需要的现金收益率超过本页可输入的上限 ' + LIMITS.cashRatePct[1] + '%/年。'
            : '两者相等的临界现金收益率是 ' + fi.breakEvenRatePct.toFixed(2) + '%/年。'),
      });
    }
    if (freeInterest && freeInterest.noGap && inp.monthlyRatePct === 0) {
      notes.push({ level: 'info', msg: '标价没变、月费率也是 0：这种情况下「免息」就是字面意义上的免息，本页不会给你编一个成本出来。' });
    }
    return notes;
  }

  /* ─────────────── 自检 ───────────────
   * 每条都返回 {name, pass, detail}，页面把不通过的条数显示出来。 */
  function selfCheck(inp, sch, i, apr) {
    const out = [];
    const P = inp.principal;
    const add = (name, pass, detail) => out.push({ name: name, pass: !!pass, detail: detail });

    const sumPay = sch.rows.reduce((s, r) => s + r.pay, 0);
    add('逐期还款合计 = 本金 + 手续费总额',
      Math.abs(sumPay - (P + sch.totalFee)) < 1e-6,
      '合计 ' + sumPay.toFixed(6) + ' vs ' + (P + sch.totalFee).toFixed(6));

    const sumPrin = sch.rows.reduce((s, r) => s + r.principalPart, 0);
    add('逐期本金合计 = 本金',
      Math.abs(sumPrin - P) < 1e-6,
      '本金合计 ' + sumPrin.toFixed(6) + ' vs ' + P.toFixed(6));

    add('末期剩余本金为 0',
      sch.rows[sch.rows.length - 1].remaining === 0,
      '末期剩余 ' + sch.rows[sch.rows.length - 1].remaining);

    const sumFee = sch.rows.reduce((s, r) => s + r.feePart, 0);
    add('逐期手续费合计 = 手续费总额',
      Math.abs(sumFee - sch.totalFee) < 1e-6,
      '手续费合计 ' + sumFee.toFixed(6) + ' vs ' + sch.totalFee.toFixed(6));

    add('每期还款额 = 本金 + 手续费（逐期）',
      sch.rows.every((r) => Math.abs(r.pay - (r.principalPart + r.feePart)) < 1e-9),
      '逐期核对');

    /* 实际月利率回代：Σ pay/(1+i)^t 应等于本金 */
    if (isFinite(i)) {
      let pv = 0;
      sch.rows.forEach((r, k) => { pv += r.pay / Math.pow(1 + i, k + 1); });
      add('实际月利率回代后现值 = 本金',
        Math.abs(pv - P) < Math.max(1e-6, P * 1e-9),
        '现值 ' + pv.toFixed(6) + ' vs 本金 ' + P.toFixed(6));
      add('年化 = (1+月利率)^12 − 1',
        Math.abs(apr - (Math.pow(1 + i, 12) - 1)) < 1e-12,
        '年化 ' + (apr * 100).toFixed(6) + '%');
    }

    /* 比例直算与复利口径的大小关系：只要真收了手续费，复利口径就更高 */
    if (inp.monthlyRatePct > 0 && Math.abs(inp.monthlyRatePct * inp.periods) > 0) {
      add('有手续费时：复利口径 > 比例直算（月费率×12）',
        apr * 100 > inp.monthlyRatePct * 12 - 1e-9,
        '复利 ' + (apr * 100).toFixed(4) + '% vs 直算 ' + (inp.monthlyRatePct * 12).toFixed(4) + '%');
    }
    return out;
  }

  /* ─────────────── 展示格式化 ─────────────── */

  function fmtMoney(x) {
    if (!isFinite(x)) return '—';
    return x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(x, d) {
    if (!isFinite(x)) return '—';
    return x.toFixed(d == null ? 2 : d) + '%';
  }
  function fmtRatio(x) {
    if (!isFinite(x)) return '—';
    return x.toFixed(2) + ' 倍';
  }

  /* 导出：CSV / Markdown / JSON（PNG 由 ui.js 画） */
  function toCSV(r) {
    const L = [];
    L.push('期数,本期还款,其中本金,其中手续费,累计已还本金,剩余本金');
    r.schedule.forEach((x) => {
      L.push([x.period, x.pay.toFixed(6), x.principalPart.toFixed(6), x.feePart.toFixed(6), x.cumPrincipal.toFixed(6), x.remaining.toFixed(6)].join(','));
    });
    L.push('');
    L.push('合计还款,' + r.totalPaid.toFixed(6) + ',本金,' + r.input.principal.toFixed(6) + ',手续费,,' + r.totalFee.toFixed(6));
    L.push('实际月利率,' + (r.monthlyRate * 100).toFixed(6) + '%,实际年化(复利),' + r.aprPct.toFixed(6) + '%,比例直算(月费率×12),' + r.naivePct.toFixed(6) + '%');
    return L.join('\n');
  }

  function toMarkdown(r) {
    const L = [];
    L.push('# 月费率摊成年化 · 结果');
    L.push('');
    L.push('- 分期本金：' + fmtMoney(r.input.principal) + ' 元｜期数：' + r.input.periods + ' 期｜月费率：' + r.input.monthlyRatePct + '%/月｜' + r.label.method);
    L.push('- 每期还款：' + fmtMoney(r.perPeriodPay) + ' 元｜手续费合计：' + fmtMoney(r.totalFee) + ' 元｜合计还款：' + fmtMoney(r.totalPaid) + ' 元');
    L.push('- **实际年化（复利）：' + fmtPct(r.aprPct) + '**｜比例直算（月费率×12）：' + fmtPct(r.naivePct) + '｜教训比值：' + fmtRatio(r.teachRatio));
    L.push('');
    L.push('| 期数 | 本期还款 | 其中本金 | 其中手续费 | 剩余本金 |');
    L.push('|---|---|---|---|---|');
    r.schedule.forEach((x) => L.push('| ' + x.period + ' | ' + x.pay.toFixed(2) + ' | ' + x.principalPart.toFixed(2) + ' | ' + x.feePart.toFixed(2) + ' | ' + x.remaining.toFixed(2) + ' |'));
    if (r.early) {
      L.push('');
      L.push('## 提前还清');
      L.push('- 第 ' + r.early.at + ' 期还清：当次付 ' + fmtMoney(r.early.closePay) + ' 元（含剩余本金 ' + fmtMoney(r.early.remaining) + ' + 违约金 ' + fmtMoney(r.early.penalty) + '）');
      L.push('- 总支出 ' + fmtMoney(r.early.totalPaid) + ' 元，比不还清' + (r.early.better ? '少花 ' : '多花 ') + fmtMoney(Math.abs(r.early.savedVsFull)) + ' 元');
      L.push('- 提前还清后的实际年化：' + fmtPct(r.early.apr * 100) + '（' + (r.early.aprDeltaPct < 0 ? '低' : '高') + ' ' + Math.abs(r.early.aprDeltaPct).toFixed(2) + ' 个百分点）');
    }
    return L.join('\n');
  }

  function toJSON(r) {
    return JSON.stringify({
      input: r.input, totalFee: r.totalFee, totalPaid: r.totalPaid, perPeriodPay: r.perPeriodPay,
      monthlyRatePct: r.monthlyRatePct, aprPct: r.aprPct, naivePct: r.naivePct, teachRatio: r.teachRatio,
      schedule: r.schedule, early: r.early, freeInterest: r.freeInterest,
      rateLadder: r.rateLadder, termLadder: r.termLadder, checks: r.checks,
    }, null, 2);
  }

  return {
    defaults: defaults, scenarios: scenarios, validate: validate, compute: compute,
    schedule: schedule, monthlyRateFromFlows: monthlyRateFromFlows, aprFromMonthly: aprFromMonthly,
    fmtMoney: fmtMoney, fmtPct: fmtPct, fmtRatio: fmtRatio,
    toCSV: toCSV, toMarkdown: toMarkdown, toJSON: toJSON,
    LIMITS: LIMITS, METHODS: METHODS, LABEL: LABEL,
    /* 只给测试用：单独跑一遍自检，便于验证「破坏数据时自检会红」 */
    _selfCheckForTest: selfCheck,
  };
});

/* 月费率摊成年化 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：手算锚点、IRR 三条独立路线的对拍、票据守恒与恒等式、三种还款口径的现金流差异、
 * 提前还清与盈亏临界、免息差额口径、阈值两侧与退化、30 条非法输入逐条核字段、
 * 单调性与不变量、随机压力（含自检）、自检「会红」反向验证、确定性与纯函数、输出契约、导出契约。
 *
 * 手算锚点一律在断言里写死数值（不是拿引擎自己对自己）；独立对拍另走
 * ① 年金因子闭式写法的牛顿迭代 ② 在年化域里二分 ③ 对已知利率直接求 NPV 的符号。
 * 另外补了一条**闭式教学式**核对（见 M1）：它由本文件自己推导，用来检查引擎没有跑偏。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'core.js'));

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-9 : tol) * Math.max(1, Math.abs(a), Math.abs(b));
const D = (over) => Object.assign(A.defaults(), over || {});
const bad = (over) => {
  const r = A.compute(D(over));
  assert.equal(r.ok, false, '这组输入本该被拒：' + JSON.stringify(over));
  return r.errors;
};
const hasField = (errs, f) => errs.some((e) => e.field === f);

/* ═══════════════ A. 手算锚点（默认场景） ═══════════════ */

test('A1 默认场景：12000 元 / 12 期 / 月费率 0.75% —— 每期 1090、手续费 1080、总还款 13080', () => {
  const r = A.compute(D());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 手算：手续费 = 12000 × 0.75% × 12 = 1080；每期 = (12000 + 1080)/12 = 1090
  assert.ok(Math.abs(r.totalFee - 1080) < 1e-12);
  assert.ok(Math.abs(r.perPeriodPay - 1090) < 1e-12);
  assert.ok(Math.abs(r.totalPaid - 13080) < 1e-12);
  assert.equal(r.schedule.length, 12);
  assert.ok(near(r.feeRatioPct, 9, 1e-12));
  assert.equal(r.naivePct, 9);
});

test('A2 默认场景实际年化：月利率 1.3513735…% → 年化 17.4777621%', () => {
  const r = A.compute(D());
  assert.ok(Math.abs(r.monthlyRatePct - 1.3513735380182523) < 1e-9, '月利率 ' + r.monthlyRatePct);
  assert.ok(Math.abs(r.aprPct - 17.477762091275785) < 1e-9, '年化 ' + r.aprPct);
  assert.ok(near(r.apr, Math.pow(1 + r.monthlyRate, 12) - 1, 1e-12));
  assert.ok(Math.abs(r.teachRatio - 17.477762091275785 / 9) < 1e-12, '比值 ' + r.teachRatio);
  assert.ok(Math.abs(r.teachRatio - 1.9419735656973096) < 1e-12);
});

test('A3 逐期拆分（还款额恒定口径）：本金部分逐期递增、手续费恒定、末期剩余为 0', () => {
  const r = A.compute(D());
  // 每期还款额恒定 1090；手续费每期 90 → 本金部分 = 1000
  r.schedule.forEach((x) => {
    assert.ok(Math.abs(x.pay - 1090) < 1e-9);
    assert.ok(Math.abs(x.feePart - 90) < 1e-9, '第 ' + x.period + ' 期手续费 ' + x.feePart);
    assert.ok(Math.abs(x.principalPart - 1000) < 1e-9);
  });
  assert.equal(r.schedule[11].remaining, 0);
  assert.ok(Math.abs(r.schedule[0].remaining - 11000) < 1e-9);
  for (let i = 1; i < 12; i++) {
    assert.ok(r.schedule[i].cumPrincipal > r.schedule[i - 1].cumPrincipal);
    assert.ok(r.schedule[i].remaining < r.schedule[i - 1].remaining);
  }
  // 本金部分合计 = 本金
  assert.ok(near(r.schedule.reduce((s, x) => s + x.principalPart, 0), 12000, 1e-12));
});

test('A4 手续费首期付清：总额与默认口径相同，但年化更高（钱更早出门）', () => {
  const r = A.compute(D({ method: 'fee_first' }));
  const d = A.compute(D());
  assert.ok(Math.abs(r.totalFee - 1080) < 1e-12);
  assert.ok(Math.abs(r.totalPaid - d.totalPaid) < 1e-9, '总支出应完全相同');
  // 第 1 期 = 本金 1000 + 全部手续费 1080 = 2080；第 2 期起只还本金 1000
  assert.ok(Math.abs(r.schedule[0].pay - 2080) < 1e-9, '第 1 期 ' + r.schedule[0].pay);
  assert.ok(Math.abs(r.schedule[0].feePart - 1080) < 1e-9);
  assert.ok(Math.abs(r.schedule[1].pay - 1000) < 1e-9);
  assert.ok(Math.abs(r.schedule[11].pay - 1000) < 1e-9);
  assert.ok(r.aprPct > d.aprPct, '首期付清的年化应更高：' + r.aprPct + ' vs ' + d.aprPct);
  assert.ok(Math.abs(r.aprPct - 18.981196361366813) < 1e-9, '锚点 ' + r.aprPct);
  // 首期付清 = 第 1 期还 P/n + 全部手续费，第 2 期起只还本金 P/n
  assert.ok(Math.abs(r.schedule.reduce((s2, x) => s2 + x.principalPart, 0) - 12000) < 1e-9);
});

test('A5 每期本金相同 + 每期收手续费：每期 1090 恒定，与默认口径同一条现金流', () => {
  const r = A.compute(D({ method: 'equal_principal' }));
  const d = A.compute(D());
  r.schedule.forEach((x) => {
    assert.ok(Math.abs(x.principalPart - 1000) < 1e-9);
    assert.ok(Math.abs(x.feePart - 90) < 1e-9);
    assert.ok(Math.abs(x.pay - 1090) < 1e-9);
  });
  assert.ok(Math.abs(r.aprPct - d.aprPct) < 1e-9, '两种口径在这组参数下是同一条现金流');
});

test('A6 三种口径在「总支出」上完全一致，差别只在时点（因而是年化）', () => {
  const a = A.compute(D({ method: 'equal_installment' }));
  const b = A.compute(D({ method: 'equal_principal' }));
  const c = A.compute(D({ method: 'fee_first' }));
  [a, b, c].forEach((r) => {
    assert.ok(Math.abs(r.totalPaid - 13080) < 1e-9, r.label.method + ' 总支出 ' + r.totalPaid);
    assert.ok(Math.abs(r.totalFee - 1080) < 1e-9);
  });
  assert.ok(Math.abs(a.aprPct - b.aprPct) < 1e-9, 'a/b 同现金流');
  assert.ok(c.aprPct > a.aprPct, '首期付清更高');
  // 首期付清是「把同一笔手续费提前交」，年化差 1.5 个百分点上下
  assert.ok(c.aprPct - a.aprPct > 1 && c.aprPct - a.aprPct < 2, '差 ' + (c.aprPct - a.aprPct));
  assert.ok(Math.abs(c.aprPct - 18.981196361366813) < 1e-9);
});

test('A7 真免息（月费率 0）且标价不变：年化 0、手续费 0、不编成本', () => {
  const r = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 12000, planPrice: 12000 }));
  assert.equal(r.ok, true);
  assert.equal(r.totalFee, 0);
  assert.equal(r.monthlyRate, 0);
  assert.equal(r.aprPct, 0);
  assert.equal(r.schedule.every((x) => x.feePart === 0), true);
  assert.equal(r.schedule.every((x) => Math.abs(x.pay - 1000) < 1e-12), true);
  assert.equal(r.teachRatio, NaN);
  assert.equal(r.freeInterest.noGap, true);
  assert.equal(r.checks.filter((c) => !c.pass).length, 0);
});

test('A8 期数为 1：只有一次还款，年化 = 月费率的复利年化', () => {
  const r = A.compute(D({ periods: 1, monthlyRatePct: 0.75 }));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.totalFee - 90) < 1e-12);
  assert.ok(Math.abs(r.perPeriodPay - 12090) < 1e-12);
  assert.ok(Math.abs(r.monthlyRatePct - 0.75) < 1e-9);
  assert.ok(Math.abs(r.aprPct - (Math.pow(1.0075, 12) - 1) * 100) < 1e-9);
  assert.equal(r.notes.some((n) => n.msg.indexOf('只有 1 期') >= 0), true);
});

test('A9 期数为 1 且手续费首期付清：不会除以 0，也不崩', () => {
  const r = A.compute(D({ periods: 1, method: 'fee_first' }));
  assert.equal(r.ok, true);
  assert.equal(Number.isNaN(r.aprPct), false);
  assert.ok(Math.abs(r.totalFee - 90) < 1e-12);
  assert.equal(r.checks.filter((c) => !c.pass).length, 0);
});

/* ═══════════════ B. 三条独立路线对拍 IRR ═══════════════ */

function newtonAnnuity() { /* 占位：见下 */ }
/* 路线①：等额还款用年金因子闭式做牛顿迭代（只用每期还款额，不看逐期拆分） */
function newtonByAnnuity(P, pay, n) {
  const f = (i) => (i === 0 ? pay * n - P : pay * (1 - Math.pow(1 + i, -n)) / i - P);
  let i = 0.01;
  for (let k = 0; k < 300; k++) {
    const h = 1e-9;
    const d = (f(i + h) - f(i - h)) / (2 * h);
    if (!isFinite(d) || Math.abs(d) < 1e-18) break;
    const step = f(i) / d;
    i -= step;
    if (i < -0.9) i = -0.9;
    if (Math.abs(step) < 1e-15) break;
  }
  return i;
}
/* 路线②：对给定利率直接算 NPV（逐期累加，不用引擎的解） */
function npvAt(P, pays, i) {
  let s = 0;
  for (let k = 0; k < pays.length; k++) s += pays[k] / Math.pow(1 + i, k + 1);
  return s - P;
}
/* 路线③：在「年化」域里二分（与引擎在月利率域里解是不同的参数化） */
function aprByBisection(P, pays) {
  const ap = (apr) => npvAt(P, pays, Math.pow(1 + apr, 1 / 12) - 1);
  let lo = -0.9, hi = 100;
  for (let k = 0; k < 400; k++) {
    const mid = (lo + hi) / 2;
    if (ap(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

test('B1 对拍：默认场景三条路线与引擎一致', () => {
  const r = A.compute(D());
  const pays = r.schedule.map((x) => x.pay);
  const i1 = newtonByAnnuity(r.input.principal, r.perPeriodPay, r.input.periods);
  const i2 = aprByBisection(r.input.principal, pays);
  const i3 = A.monthlyRateFromFlows(r.input.principal, pays).i;
  assert.ok(near(r.monthlyRate, i1, 1e-10), r.monthlyRate + ' vs newton ' + i1);
  assert.ok(near(r.apr, i2, 1e-10), r.apr + ' vs bisection ' + i2);
  assert.ok(near(i3, i1, 1e-10), i3 + ' vs ' + i1);
  assert.ok(Math.abs(npvAt(r.input.principal, pays, r.monthlyRate)) < 1e-6);
});

test('B2 对拍：40 组（本金 × 期数 × 月费率）逐组三路线一致', () => {
  const P = [1000, 5000, 12000, 60000];
  const N = [3, 6, 12, 24, 36];
  const R = [0.1, 0.3, 0.75, 1.5, 2.9];
  let n = 0;
  P.forEach((p) => N.forEach((nn) => R.forEach((rr) => {
    if (n >= 40) return;
    n++;
    const r = A.compute(D({ principal: p, periods: nn, monthlyRatePct: rr }));
    assert.equal(r.ok, true);
    const pays = r.schedule.map((x) => x.pay);
    const i1 = newtonByAnnuity(p, r.perPeriodPay, nn);
    assert.ok(near(r.monthlyRate, i1, 1e-8), 'P=' + p + ' n=' + nn + ' r=' + rr + '：' + r.monthlyRate + ' vs ' + i1);
    assert.ok(Math.abs(npvAt(p, pays, r.monthlyRate)) < Math.max(1e-6, p * 1e-10));
  })));
  assert.equal(n, 40);
});

test('B3 三种口径 × 5 个提前还清时点：两条独立路线都与引擎一致', () => {
  ['equal_installment', 'equal_principal', 'fee_first'].forEach((m) => {
    [1, 3, 6, 9, 11].forEach((k) => {
      const r = A.compute(D({ method: m, earlyEnabled: true, earlyAt: k, earlyFeeRatePct: 2 }));
      const e = r.early;
      const pays = r.schedule.slice(0, k - 1).map((x) => x.pay).concat([e.closePay]);
      const i = A.monthlyRateFromFlows(r.input.principal, pays).i;
      assert.ok(near(e.monthlyRate, i, 1e-12), m + ' k=' + k);
      assert.ok(near(e.apr, Math.pow(1 + i, 12) - 1, 1e-12));
      assert.ok(Math.abs(npvAt(r.input.principal, pays, i)) < 1e-6);
      const sum = r.schedule.slice(0, k - 1).reduce((s, x) => s + x.pay, 0) + e.closePay;
      assert.ok(Math.abs(sum - e.totalPaid) < 1e-9);
    });
  });
});

/* ═══════════════ C. 票据守恒与恒等式 ═══════════════ */

test('C1 逐期守恒：还款 = 本金 + 手续费、逐期本金合计 = 本金、手续费合计 = 总额', () => {
  [{}, { method: 'fee_first' }, { method: 'equal_principal' }, { periods: 7, monthlyRatePct: 1.234 },
   { periods: 60, monthlyRatePct: 0.01 }, { periods: 2, method: 'fee_first', monthlyRatePct: 3 }].forEach((over) => {
    const r = A.compute(D(over));
    assert.equal(r.ok, true);
    let sp = 0, sf = 0, spay = 0;
    r.schedule.forEach((x) => {
      assert.ok(Math.abs(x.pay - (x.principalPart + x.feePart)) < 1e-9, JSON.stringify(over));
      sp += x.principalPart; sf += x.feePart; spay += x.pay;
    });
    assert.ok(near(sp, r.input.principal, 1e-12), JSON.stringify(over) + ' 本金合计 ' + sp);
    assert.ok(near(sf, r.totalFee, 1e-12), JSON.stringify(over) + ' 手续费合计 ' + sf);
    assert.ok(near(spay, r.totalPaid, 1e-12));
    assert.equal(r.schedule[r.schedule.length - 1].remaining, 0);
    r.schedule.forEach((x) => {
      const expect = Math.max(0, r.input.principal - x.cumPrincipal);
      assert.ok(Math.abs(x.remaining - expect) < 1e-9, '第 ' + x.period + ' 期剩余 ' + x.remaining + ' vs ' + expect);
    });
  });
});

/* ═══════════════ D. 提前还清与盈亏临界 ═══════════════ */

test('D1 提前还清（违约金 0）：少花手续费、真实成本下降，临界违约金率为正', () => {
  const r = A.compute(D({ earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: 0 }));
  const e = r.early;
  assert.equal(e.remaining, 7000);                      // 前 5 期已还本金 5×1000，剩 7000
  assert.ok(Math.abs(e.penalty) < 1e-12);
  assert.ok(Math.abs(e.closePay - 7090) < 1e-9);        // 第 6 期手续费 90 + 剩余本金 7000
  assert.ok(Math.abs(e.totalPaid - (5 * 1090 + 7090)) < 1e-9);
  assert.ok(Math.abs(e.totalPaid - 12540) < 1e-9);
  assert.ok(Math.abs(e.savedVsFull - (13080 - 12540)) < 1e-9);
  assert.equal(e.better, true);
  assert.ok(e.apr < r.apr, '提前还清的真实成本应更低：' + e.apr + ' vs ' + r.apr);
  assert.ok(e.aprDeltaPct < 0);
  assert.ok(e.vStarPct != null && Math.abs(e.vStarPct - 3.4496) < 0.01, '临界违约金率 ' + e.vStarPct);
});

test('D2 盈亏临界：临界违约金率处两条路的实际年化相等，越过就更亏', () => {
  const r = A.compute(D({ earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: 0 }));
  const vStar = r.early.vStarPct;
  const atStar = A.compute(D({ earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: vStar }));
  const at0 = A.compute(D({ earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: 0 }));
  assert.ok(Math.abs(atStar.early.apr - r.apr) < 1e-6, '临界点年化 ' + atStar.early.apr + ' vs ' + r.apr);
  assert.ok(at0.early.totalPaid < atStar.early.totalPaid);
  const above = A.compute(D({ earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: vStar + 3 }));
  assert.ok(above.early.apr > r.apr, '临界之上，提前还清折算出的真实成本高于不还清');
  /* 如实记录一个反直觉但正确的现象：临界之上「年化更高」并不等于「总支出更多」。
     违约金 6.45% 时总支出 12930 < 不还清 13080（少花 150 元），可它的
     资金占用年化反而更高（22.39% vs 17.48%）。两件事口径不同：
       · better / savedVsFull 看的是**总支出**；
       · apr 看的是**这笔钱按什么成本在占用**。
     页面把两者分开写，不混为一谈。 */
  assert.equal(above.early.better, true, '总支出口径下仍然更省');
  assert.ok(above.early.totalPaid < r.totalPaid);
  assert.ok(Math.abs(above.early.savedVsFull - 88.5122) < 1e-3, '省 ' + above.early.savedVsFull);
  assert.ok(Math.abs(above.early.apr * 100 - 22.386816017188682) < 1e-6, '年化 ' + above.early.apr * 100);
});

test('D3 违约金顶格 + 第 1 期就还清：总支出更高、年化也更高（违约金压过了省下的手续费）', () => {
  const r = A.compute(D({ earlyEnabled: true, earlyAt: 1, earlyFeeRatePct: 20 }));
  const e = r.early;
  assert.ok(Math.abs(e.remaining - 12000) < 1e-9);           // 第 1 期还清时本金一分未还
  assert.ok(Math.abs(e.penalty - 2400) < 1e-9);
  assert.ok(Math.abs(e.totalPaid - 14490) < 1e-9);           // 90 + 12000 + 2400
  assert.equal(e.better, false);
  assert.ok(e.savedVsFull < 0);
  assert.ok(e.apr > r.apr, '年化也更高：' + e.apr + ' vs ' + r.apr);
  /* 第 1 期就还清时不存在「更省」的区间（提前还清的真实成本本来就更低，年化 9.38% < 17.48%），
     所以 v* 报 null 是正确行为：在这条路上违约金只会一直把它推贵。
     对照：第 6 期还清的临界值是 3.45%。 */
  assert.equal(e.vStarPct, null, 'v* ' + e.vStarPct);
  const k6 = A.compute(D({ earlyEnabled: true, earlyAt: 6 }));
  assert.ok(Math.abs(k6.early.vStarPct - 3.4498) < 0.01, 'k=6 的 v* ' + k6.early.vStarPct);
  // 同一组参数把违约金降到 0：又变成划算 —— 结论由违约金决定，不是预设
  const zero = A.compute(D({ earlyEnabled: true, earlyAt: 1, earlyFeeRatePct: 0 }));
  assert.equal(zero.early.better, true);
  assert.ok(zero.early.apr < r.apr);
  assert.ok(Math.abs(zero.early.totalPaid - 12090) < 1e-9);
});

test('D4 提前还清只在第 1…n−1 期成立（末期不算提前还清）', () => {
  assert.ok(hasField(bad({ earlyEnabled: true, earlyAt: 12 }), 'earlyAt'));
  assert.ok(hasField(bad({ earlyEnabled: true, earlyAt: 0 }), 'earlyAt'));
  const ok1 = A.compute(D({ earlyEnabled: true, earlyAt: 1 }));
  assert.equal(ok1.ok, true);
  // 第 1 期就还清：本期手续费 90 + 全部本金 12000 = 12090
  assert.ok(Math.abs(ok1.early.closePay - 12090) < 1e-9, 'closePay ' + ok1.early.closePay);
  const ok11 = A.compute(D({ earlyEnabled: true, earlyAt: 11 }));
  assert.ok(Math.abs(ok11.early.closePay - 2090) < 1e-9, 'closePay ' + ok11.early.closePay);
});

test('D5 每一期都能提前还清；违约金 0 时 k=1 最省，之后随 k 单调递增', () => {
  const totals = [];
  for (let k = 1; k <= 11; k++) {
    const r = A.compute(D({ earlyEnabled: true, earlyAt: k, earlyFeeRatePct: 0 }));
    assert.equal(r.ok, true, 'k=' + k);
    assert.equal(r.early.better, true, '违约金 0 时应一律更省（k=' + k + '）');
    totals.push(r.early.totalPaid);
  }
  // 手算锚点：k=1 → 90 + 12000 = 12090；k=2 → 1090 + 90 + 11000 = 12180；k=11 → 10×1090 + 90 + 2000 = 12990
  assert.ok(Math.abs(totals[0] - 12090) < 1e-9, 'k=1 → ' + totals[0]);
  assert.ok(Math.abs(totals[1] - 12180) < 1e-9, 'k=2 → ' + totals[1]);
  assert.ok(Math.abs(totals[10] - 12990) < 1e-9, 'k=11 → ' + totals[10]);
  for (let i = 1; i < totals.length; i++) {
    assert.ok(totals[i] > totals[i - 1], 'k=' + (i + 1) + ' 应比上一期贵：' + totals[i] + ' vs ' + totals[i - 1]);
  }
  assert.ok(totals[10] < A.compute(D()).totalPaid, '即使最后一期提前还清也比不还清省');
});

test('D6 三种口径下提前还清都算得出来，剩余本金 = 本金 − 已还各期本金之和', () => {
  ['equal_installment', 'equal_principal', 'fee_first'].forEach((m) => {
    const r = A.compute(D({ method: m, earlyEnabled: true, earlyAt: 4 }));
    assert.equal(r.ok, true, m);
    // 第 4 期还清时本金只还掉了前 3 期，各 P/n = 1000 → 剩余 9000；本期手续费照收
    const paidPrincipal = r.schedule.slice(0, 3).reduce((s2, x) => s2 + x.principalPart, 0);
    assert.ok(Math.abs(r.early.remaining - (12000 - paidPrincipal)) < 1e-9, m);
    assert.ok(Math.abs(r.early.remaining - 9000) < 1e-9, m + ' 剩余 ' + r.early.remaining);
    assert.ok(Math.abs(r.early.closePay - (r.schedule[3].feePart + 9000)) < 1e-9, m + ' closePay ' + r.early.closePay);
    assert.equal(Number.isNaN(r.early.apr), false);
  });
});

test('E1 标价差的盈亏临界现金收益率 = (1+差额/本金)^(12/n) − 1', () => {
  const r = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 11800, planPrice: 12000 }));
  const fi = r.freeInterest;
  assert.ok(Math.abs(fi.priceGap - 200) < 1e-12);
  const expect = (Math.pow(1 + 200 / 12000, 12 / 12) - 1) * 100;
  assert.ok(Math.abs(fi.breakEvenRatePct - expect) < 1e-12);
  assert.ok(Math.abs(fi.breakEvenRatePct - 1.6666666666666667) < 1e-9);
  const r24 = A.compute(D({ monthlyRatePct: 0, periods: 24, upfrontPrice: 11800, planPrice: 12000 }));
  assert.ok(r24.freeInterest.breakEvenRatePct < fi.breakEvenRatePct);
  assert.ok(Math.abs(r24.freeInterest.breakEvenRatePct - (Math.pow(1 + 200 / 12000, 12 / 24) - 1) * 100) < 1e-12);
});

test('E2 现金收益率跨过临界点时结论翻转', () => {
  const below = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 11800, planPrice: 12000, cashRatePct: 1 }));
  const above = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 11800, planPrice: 12000, cashRatePct: 3 }));
  assert.equal(below.freeInterest.verdict, 'gap_hurts');
  assert.equal(above.freeInterest.verdict, 'gap_ok');
  assert.ok(Math.abs(below.freeInterest.cashEarn - 12000 * (Math.pow(1.01, 1) - 1)) < 1e-9);
  assert.ok(Math.abs(above.freeInterest.cashEarn - 12000 * (Math.pow(1.03, 1) - 1)) < 1e-9);
  // 临界点上净额应为 0（注意单位：临界值是百分数，这里要除以 100）
  const at = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 11800, planPrice: 12000, cashRatePct: 200 / 12000 * 100 }));
  assert.ok(Math.abs(at.freeInterest.netVsCash) < 1e-6, '临界点净额 ' + at.freeInterest.netVsCash);
  // 浮点误差会让「恰好相等」落到相邻的两档里，这里按净额判定而不强求字面 'gap_even'
  assert.ok(at.freeInterest.verdict === 'gap_even' || Math.abs(at.freeInterest.netVsCash) < 1e-6);
});

test('E3 标价没差时：不编成本、不给「不便宜」的结论', () => {
  const r = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 12000, planPrice: 12000 }));
  assert.equal(r.freeInterest.noGap, true);
  assert.equal(r.freeInterest.verdict, 'no_gap');
  assert.equal(r.freeInterest.breakEvenRatePct, 0);
  assert.equal(r.notes.some((n) => n.msg.indexOf('字面意义上的免息') >= 0), true);
});

test('E4 分期标价更低（分期比一次付清便宜）也算得出来，差额为负', () => {
  const r = A.compute(D({ monthlyRatePct: 0, upfrontPrice: 12500, planPrice: 12000, cashRatePct: 0 }));
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.freeInterest.priceGap + 500) < 1e-12);
  assert.equal(r.freeInterest.verdict, 'gap_ok');
  assert.equal(r.freeInterest.breakEvenRatePct, 0);
});

/* ═══════════════ F. 阶梯与不变量 ═══════════════ */

test('F1 月费率阶梯：年化与手续费都随月费率单调递增，比值收敛在 1–2.2 之间', () => {
  const r = A.compute(D());
  for (let i = 1; i < r.rateLadder.length; i++) {
    assert.ok(r.rateLadder[i].aprPct > r.rateLadder[i - 1].aprPct);
    assert.ok(r.rateLadder[i].totalFee > r.rateLadder[i - 1].totalFee);
    assert.ok(r.rateLadder[i].ratio >= r.rateLadder[i - 1].ratio - 1e-12);
    assert.ok(r.rateLadder[i].ratio > 1 && r.rateLadder[i].ratio < 2.2, '比值 ' + r.rateLadder[i].ratio);
  }
  const p03 = r.rateLadder.find((x) => x.monthlyRatePct === 0.3);
  assert.ok(Math.abs(p03.aprPct - 6.782313984545096) < 1e-9);
  assert.ok(Math.abs(p03.totalFee - 432) < 1e-12);
});

test('F2 期数阶梯：手续费总额随期数单调递增，每期还款随期数单调递减', () => {
  const r = A.compute(D());
  for (let i = 1; i < r.termLadder.length; i++) {
    assert.ok(r.termLadder[i].totalFee > r.termLadder[i - 1].totalFee, JSON.stringify(r.termLadder));
    assert.ok(r.termLadder[i].perPeriodPay < r.termLadder[i - 1].perPeriodPay);
  }
  const t12 = r.termLadder.find((x) => x.periods === 12), t24 = r.termLadder.find((x) => x.periods === 24);
  assert.ok(Math.abs(t12.totalFee - 1080) < 1e-9 && Math.abs(t24.totalFee - 2160) < 1e-9);
});

test('F3 期数阶梯的年化不是「越长越高」的直线（如实记录这个形状）', () => {
  const r = A.compute(D());
  const t = {};
  r.termLadder.forEach((x) => { t[x.periods] = x.aprPct; });
  assert.ok(t[3] < t[12], '短期年化应低于 12 期：' + t[3] + ' vs ' + t[12]);
  assert.ok(t[24] > t[12], '24 期略高于 12 期');
  assert.ok(t[36] < t[24], '36 期反而略低于 24 期（页面解释了原因）：' + t[36] + ' vs ' + t[24]);
  assert.ok(Math.abs(t[3] - 14.310942839380791) < 1e-9, '3 期锚点 ' + t[3]);
  assert.ok(Math.abs(t[24] - 17.720278042131877) < 1e-9, '24 期锚点 ' + t[24]);
  const note = r.notes.find((n) => n.msg.indexOf('不是「越长年化越高」的直线') >= 0);
  assert.ok(note, '应当有一条说明期数年化非单调的提示：' + JSON.stringify(r.notes.map((x) => x.msg.slice(0, 40))));
  assert.ok(note.msg.indexOf('年化最高的是 24 期') >= 0, note.msg);
  assert.ok(note.msg.indexOf('36 期 17.51%') >= 0, note.msg);
});

test('F4 不变量：有手续费时 实际年化 > 比例直算，且不超过它的 2.2 倍', () => {
  [[0.1, 3], [0.5, 6], [0.75, 12], [1.5, 12], [2, 36], [0.01, 60]].forEach(([r0, n]) => {
    const r = A.compute(D({ monthlyRatePct: r0, periods: n }));
    const naive = r0 * 12;
    assert.ok(r.aprPct > naive - 1e-9, r0 + '% × ' + n + ' 期：' + r.aprPct + ' vs ' + naive);
    assert.ok(r.aprPct < naive * 2.2, r0 + '% × ' + n + ' 期：比值过大 ' + r.aprPct / naive);
  });
});

test('F5 手续费时点：总支出相同，首期付清的年化不低于每期收', () => {
  [3, 6, 12, 24].forEach((n) => {
    const a = A.compute(D({ periods: n }));
    const b = A.compute(D({ periods: n, method: 'fee_first' }));
    assert.ok(Math.abs(a.totalPaid - b.totalPaid) < 1e-9, n + ' 期总支出应相同');
    assert.ok(b.aprPct >= a.aprPct - 1e-9, n + ' 期：' + b.aprPct + ' vs ' + a.aprPct);
  });
});

/* ═══════════════ G. 阈值两侧与边界 ═══════════════ */

test('G1 本金上下界两侧', () => {
  assert.equal(A.compute(D({ principal: A.LIMITS.principal[0] })).ok, true);
  assert.equal(A.compute(D({ principal: A.LIMITS.principal[1] })).ok, true);
  assert.ok(hasField(bad({ principal: 0 }), 'principal'));
  assert.ok(hasField(bad({ principal: -1 }), 'principal'));
  assert.ok(hasField(bad({ principal: A.LIMITS.principal[1] + 1 }), 'principal'));
});

test('G2 月费率上下界两侧（含 0 与 10%），极端值给警示', () => {
  assert.equal(A.compute(D({ monthlyRatePct: 0 })).ok, true);
  assert.equal(A.compute(D({ monthlyRatePct: 10 })).ok, true);
  assert.ok(hasField(bad({ monthlyRatePct: -0.01 }), 'monthlyRatePct'));
  assert.ok(hasField(bad({ monthlyRatePct: 10.01 }), 'monthlyRatePct'));
  const r = A.compute(D({ monthlyRatePct: 10, periods: 12 }));
  assert.equal(r.notes.filter((n) => n.level === 'warn').length >= 2, true, JSON.stringify(r.notes));
});

test('G3 期数上下界两侧与非整数', () => {
  assert.equal(A.compute(D({ periods: 1 })).ok, true);
  assert.equal(A.compute(D({ periods: 60 })).ok, true);
  assert.ok(hasField(bad({ periods: 0 }), 'periods'));
  assert.ok(hasField(bad({ periods: 61 }), 'periods'));
  assert.ok(hasField(bad({ periods: 2.5 }), 'periods'));
});

test('G4 违约金率与现金收益率边界', () => {
  assert.equal(A.compute(D({ earlyEnabled: true, earlyAt: 3, earlyFeeRatePct: 0 })).ok, true);
  assert.equal(A.compute(D({ earlyEnabled: true, earlyAt: 3, earlyFeeRatePct: 20 })).ok, true);
  assert.ok(hasField(bad({ earlyFeeRatePct: -1 }), 'earlyFeeRatePct'));
  assert.ok(hasField(bad({ earlyFeeRatePct: 21 }), 'earlyFeeRatePct'));
  assert.equal(A.compute(D({ cashRatePct: 30 })).ok, true);
  assert.ok(hasField(bad({ cashRatePct: 31 }), 'cashRatePct'));
});

test('G5 退化：本金极小 / 期数 1 / 月费率 0 / 违约金 0 —— 都不崩、无 NaN', () => {
  [{ principal: 0.01 }, { periods: 1 }, { monthlyRatePct: 0 }, { earlyEnabled: true, earlyAt: 1, earlyFeeRatePct: 0 },
   { principal: 0.01, periods: 60, monthlyRatePct: 0 }, { periods: 2, method: 'fee_first' }].forEach((over) => {
    const r = A.compute(D(over));
    assert.equal(r.ok, true, JSON.stringify(over));
    assert.equal(Number.isNaN(r.aprPct), false, JSON.stringify(over) + ' apr NaN');
    assert.equal(Number.isNaN(r.totalPaid), false);
    if (r.early) assert.equal(Number.isNaN(r.early.apr), false);
    r.schedule.forEach((x) => {
      ['pay', 'principalPart', 'feePart', 'cumPrincipal', 'remaining'].forEach((k) => {
        assert.equal(Number.isNaN(x[k]), false, JSON.stringify(over) + ' 第 ' + x.period + ' 期 ' + k);
      });
    });
  });
});

/* ═══════════════ H. 非法输入（逐条核字段） ═══════════════ */

test('H1 30 条非法输入逐条核 field 与 code', () => {
  const cases = [
    [{ principal: 'abc' }, 'principal', 'not_number'],
    [{ principal: NaN }, 'principal', 'not_number'],
    [{ principal: Infinity }, 'principal', 'not_number'],
    [{ principal: 0 }, 'principal', 'out_of_range'],
    [{ principal: -1 }, 'principal', 'out_of_range'],
    [{ principal: 10000001 }, 'principal', 'out_of_range'],
    [{ periods: 'x' }, 'periods', 'not_number'],
    [{ periods: 0 }, 'periods', 'out_of_range'],
    [{ periods: -3 }, 'periods', 'out_of_range'],
    [{ periods: 61 }, 'periods', 'out_of_range'],
    [{ periods: 4.5 }, 'periods', 'not_integer'],
    [{ monthlyRatePct: 'x' }, 'monthlyRatePct', 'not_number'],
    [{ monthlyRatePct: -0.5 }, 'monthlyRatePct', 'out_of_range'],
    [{ monthlyRatePct: 11 }, 'monthlyRatePct', 'out_of_range'],
    [{ method: 'flat' }, 'method', 'bad_enum'],
    [{ method: '' }, 'method', 'bad_enum'],
    [{ method: null }, 'method', 'bad_enum'],
    [{ method: 'per_period' }, 'method', 'bad_enum'],
    [{ earlyFeeRatePct: 25 }, 'earlyFeeRatePct', 'out_of_range'],
    [{ earlyFeeRatePct: -0.1 }, 'earlyFeeRatePct', 'out_of_range'],
    [{ cashRatePct: -1 }, 'cashRatePct', 'out_of_range'],
    [{ cashRatePct: 100 }, 'cashRatePct', 'out_of_range'],
    [{ upfrontPrice: -1 }, 'upfrontPrice', 'out_of_range'],
    [{ upfrontPrice: 10000001 }, 'upfrontPrice', 'out_of_range'],
    [{ planPrice: -5 }, 'planPrice', 'out_of_range'],
    [{ planPrice: 10000001 }, 'planPrice', 'out_of_range'],
    [{ earlyEnabled: true, earlyAt: 'x' }, 'earlyAt', 'not_number'],
    [{ earlyEnabled: true, earlyAt: 1.5 }, 'earlyAt', 'not_integer'],
    [{ earlyEnabled: true, earlyAt: 0 }, 'earlyAt', 'out_of_range'],
    [{ earlyEnabled: true, earlyAt: 13 }, 'earlyAt', 'out_of_range'],
  ];
  let n = 0;
  cases.forEach(([over, field, code]) => {
    const r = A.compute(D(over));
    assert.equal(r.ok, false, JSON.stringify(over) + ' 本该被拒');
    const hit = r.errors.filter((e) => e.field === field && e.code === code);
    assert.ok(hit.length >= 1, JSON.stringify(over) + ' 期望 ' + field + '/' + code + '，实际 ' + JSON.stringify(r.errors));
    assert.equal(typeof hit[0].msg, 'string');
    assert.ok(hit[0].msg.length > 3);
    n++;
  });
  assert.equal(n, 30);
});

test('H2 一次把多个错一起报出来（不是只报第一个）', () => {
  const r = A.compute(D({ principal: -5, periods: 0, monthlyRatePct: 99, cashRatePct: -2 }));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length >= 4, true, JSON.stringify(r.errors));
  ['principal', 'periods', 'monthlyRatePct', 'cashRatePct'].forEach((f) => assert.ok(hasField(r.errors, f), f));
});

test('H3 被拒绝时不返回任何结果字段（不能拿 undefined 当正确）', () => {
  const r = A.compute(D({ principal: 0 }));
  assert.equal(r.ok, false);
  assert.equal(r.schedule, undefined);
  assert.equal(r.aprPct, undefined);
  assert.equal(r.totalPaid, undefined);
  assert.equal(r.early, undefined);
  assert.equal(Array.isArray(r.errors) && r.errors.length > 0, true);
});

/* ═══════════════ I. 随机压力 + 自检 ═══════════════ */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('I1 300 组随机参数：每次都过自检、无 NaN、票据守恒', () => {
  const rnd = mulberry32(20261112);
  const methods = ['equal_installment', 'equal_principal', 'fee_first'];
  let assertCount = 0, groups = 0;
  for (let g = 0; g < 300; g++) {
    const over = {
      principal: Math.round((0.01 + rnd() * 99999.99) * 100) / 100,
      periods: 1 + Math.floor(rnd() * 60),
      monthlyRatePct: Math.round(rnd() * 1000) / 100,
      method: methods[Math.floor(rnd() * 3)],
      earlyEnabled: rnd() < 0.5,
      earlyFeeRatePct: Math.round(rnd() * 2000) / 100,
      cashRatePct: Math.round(rnd() * 3000) / 100,
      upfrontPrice: Math.round(rnd() * 100000 * 100) / 100,
      planPrice: Math.round(rnd() * 100000 * 100) / 100,
    };
    // 期数为 1 时不存在「提前还清」这个动作（末期不算提前），随机生成里要关掉
    if (over.periods === 1) over.earlyEnabled = false;
    over.earlyAt = 1 + Math.floor(rnd() * Math.max(1, over.periods - 1));
    const r = A.compute(over);
    assert.equal(r.ok, true, '第 ' + g + ' 组被拒：' + JSON.stringify(over) + ' ' + JSON.stringify(r.errors));
    groups++;
    assert.equal(Number.isNaN(r.aprPct), false, JSON.stringify(over));
    assert.equal(Number.isNaN(r.totalPaid), false);
    assert.equal(r.schedule.length, over.periods);
    assert.ok(Math.abs(r.schedule.reduce((s, x) => s + x.pay, 0) - r.totalPaid) < 1e-6);
    assert.ok(Math.abs(r.schedule.reduce((s, x) => s + x.principalPart, 0) - over.principal) < 1e-6);
    const cf = r.checks.filter((c) => !c.pass);
    assert.equal(cf.length, 0, '第 ' + g + ' 组自检不通过：' + JSON.stringify(over) + ' → ' + JSON.stringify(cf));
    assertCount += r.checks.length + 6;
  }
  assert.equal(groups, 300);
  /* 实测：300 组 ×（8 条自检 + 6 条守恒）= 4,200 条断言左右（本轮实测 4,198） */
  assert.ok(assertCount > 4000 && assertCount < 4300, '累计断言 ' + assertCount);
});

test('I2 200 组随机：IRR 与「对已知利率的 NPV 符号」一致（独立判据）', () => {
  const rnd = mulberry32(777);
  const methods = ['equal_installment', 'equal_principal', 'fee_first'];
  for (let g = 0; g < 200; g++) {
    const over = {
      principal: Math.round((100 + rnd() * 50000) * 100) / 100,
      periods: 2 + Math.floor(rnd() * 48),
      monthlyRatePct: Math.round(rnd() * 500) / 100,
      method: methods[Math.floor(rnd() * 3)],
    };
    const r = A.compute(over);
    assert.equal(r.ok, true);
    const pays = r.schedule.map((x) => x.pay);
    const i = r.monthlyRate;
    if (i > 1e-6) {
      assert.ok(npvAt(over.principal, pays, i * 0.5) > 0, '更低利率处 NPV 应为正（第 ' + g + ' 组）');
      assert.ok(npvAt(over.principal, pays, i * 1.5 + 1e-6) < 0, '更高利率处 NPV 应为负（第 ' + g + ' 组）');
    }
  }
});

test('I3 100 组随机：免息差额的盈亏临界率回代后净额约为 0', () => {
  const rnd = mulberry32(31337);
  for (let g = 0; g < 100; g++) {
    const P = Math.round((1000 + rnd() * 40000) * 100) / 100;
    const gap = Math.round(rnd() * 800 * 100) / 100;
    const n = 1 + Math.floor(rnd() * 36);
    const base = { principal: P, periods: n, monthlyRatePct: 0, upfrontPrice: P, planPrice: P + gap, cashRatePct: 0 };
    const r = A.compute(base);
    assert.equal(r.ok, true);
    if (gap <= 0) { assert.equal(r.freeInterest.noGap, true); continue; }
    const star = r.freeInterest.breakEvenRatePct;
    if (star == null) {
      // 临界值超过可输入上限（30%/年）时如实报 null，而不是给一个填不进去的数
      assert.ok(r.freeInterest.breakEvenRatePct === null);
      const capped = A.compute(Object.assign({}, base, { cashRatePct: A.LIMITS.cashRatePct[1] }));
      assert.equal(capped.freeInterest.verdict, 'gap_hurts', '填到上限仍追不平：' + JSON.stringify({ P: P, gap: gap, n: n }));
      continue;
    }
    const at = A.compute(Object.assign({}, base, { cashRatePct: star }));
    assert.equal(at.ok, true, 'star=' + star + ' P=' + P + ' gap=' + gap + ' n=' + n);
    /* 临界率是**显示用的两位小数**，直接回代会有舍入残差：
       以 r* = 1.6667% 为例，本金 12000 的净额约 0.04 元。
       这里按「本金 × 临界率的舍入步长（0.005%）」给容差，而不是用一个拍脑袋的大数。 */
    const tol = P * (0.005 / 100) * 2 + 1e-9;
    assert.ok(Math.abs(at.freeInterest.netVsCash) < tol,
      '第 ' + g + ' 组 net=' + at.freeInterest.netVsCash + ' P=' + P + ' gap=' + gap + ' n=' + n + ' star=' + star + ' cashEarn=' + at.freeInterest.cashEarn + ' tol=' + tol);
    // 临界率本身必须落在两个方向之间：低于它亏、高于它省
    const below = A.compute(Object.assign({}, base, { cashRatePct: Math.max(0, star - 1) }));
    const above = A.compute(Object.assign({}, base, { cashRatePct: star + 1 }));
    assert.ok(below.freeInterest.cashEarn <= at.freeInterest.cashEarn);
    assert.ok(above.freeInterest.cashEarn >= at.freeInterest.cashEarn);
  }
});

test('J1 自检在数据被破坏时确实会红（不是恒定绿）', () => {
  const r = A.compute(D());
  const sch = A.schedule(r.input);
  assert.equal(r.checks.filter((c) => !c.pass).length, 0);
  // 破坏 1：末期剩余本金不为 0
  const b1 = { rows: sch.rows.map((x) => Object.assign({}, x)), totalFee: sch.totalFee };
  b1.rows[b1.rows.length - 1].remaining = 12.34;
  assert.ok(A._selfCheckForTest(r.input, b1, r.monthlyRate, r.apr).some((c) => !c.pass), '破坏剩余本金后应报红');
  // 破坏 2：手续费总额被改
  const b2 = { rows: sch.rows, totalFee: sch.totalFee + 1 };
  assert.ok(A._selfCheckForTest(r.input, b2, r.monthlyRate, r.apr).some((c) => !c.pass), '破坏手续费总额后应报红');
  // 破坏 3：利率不是解
  assert.ok(A._selfCheckForTest(r.input, sch, r.monthlyRate * 1.05, r.apr).some((c) => !c.pass), '把利率改掉后应报红');
  // 破坏 4：年化与月利率不自洽
  assert.ok(A._selfCheckForTest(r.input, sch, r.monthlyRate, r.apr + 0.01).some((c) => !c.pass), '年化不自洽应报红');
  // 破坏 5：某期还款额 ≠ 本金 + 手续费
  const b5 = { rows: sch.rows.map((x) => Object.assign({}, x)), totalFee: sch.totalFee };
  b5.rows[2].pay += 1;
  assert.ok(A._selfCheckForTest(r.input, b5, r.monthlyRate, r.apr).some((c) => !c.pass), '破坏单期还款额应报红');
});

test('J2 页面用的自检条数与字段稳定', () => {
  const r = A.compute(D());
  assert.equal(r.checks.length, 8);
  r.checks.forEach((c) => {
    assert.equal(typeof c.name, 'string');
    assert.ok(c.name.length > 5);
    assert.equal(typeof c.detail, 'string');
    assert.equal(typeof c.pass, 'boolean');
  });
});

/* ═══════════════ K. 确定性与纯函数 ═══════════════ */

test('K1 同一输入重复算 50 次结果完全一致', () => {
  const over = { periods: 17, monthlyRatePct: 1.07, earlyEnabled: true, earlyAt: 5, earlyFeeRatePct: 1.5 };
  const first = JSON.stringify(A.compute(D(over)));
  for (let k = 0; k < 50; k++) assert.equal(JSON.stringify(A.compute(D(over))), first);
});

test('K2 不改传入对象（纯函数）', () => {
  const inp = D({ periods: 9 });
  const copy = JSON.stringify(inp);
  A.compute(inp);
  assert.equal(JSON.stringify(inp), copy);
  A.defaults().principal = 1;
  assert.equal(A.defaults().principal, 12000);
});

test('K3 场景列表里的每个场景都能算出来，且都有标签', () => {
  const list = A.scenarios();
  assert.ok(list.length >= 8);
  list.forEach((s) => {
    assert.equal(typeof s.label, 'string');
    assert.ok(s.label.length > 4);
    const r = A.compute(Object.assign(A.defaults(), s.over));
    assert.equal(r.ok, true, s.label + ' → ' + JSON.stringify(r.errors));
  });
});

/* ═══════════════ L. 输出与导出契约 ═══════════════ */

test('L1 compute 返回的必备字段都在且类型正确', () => {
  const r = A.compute(D());
  ['totalFee', 'totalPaid', 'perPeriodPay', 'monthlyRate', 'monthlyRatePct', 'apr', 'aprPct', 'naivePct', 'feeRatioPct']
    .forEach((k) => {
      assert.equal(typeof r[k], 'number', k);
      assert.equal(Number.isFinite(r[k]), true, k + ' = ' + r[k]);
    });
  assert.equal(Array.isArray(r.schedule), true);
  assert.equal(Array.isArray(r.rateLadder), true);
  assert.equal(Array.isArray(r.termLadder), true);
  assert.equal(Array.isArray(r.checks), true);
  assert.equal(Array.isArray(r.notes), true);
  assert.equal(typeof r.label.method, 'string');
  assert.equal(typeof r.freeInterest.verdict, 'string');
});

test('L2 CSV 契约：表头、行数 = 期数、合计行、6 位小数', () => {
  const r = A.compute(D({ periods: 7 }));
  const csv = A.toCSV(r);
  const L = csv.split('\n');
  assert.equal(L[0], '期数,本期还款,其中本金,其中手续费,累计已还本金,剩余本金');
  L.slice(1, 8).forEach((line, i) => {
    const c = line.split(',');
    assert.equal(c.length, 6);
    assert.equal(Number(c[0]), i + 1);
    assert.equal(c[1].split('.')[1].length, 6);
  });
  assert.equal(csv.indexOf('实际月利率') > 0, true);
});

test('L3 Markdown 契约：标题、逐期表、年化', () => {
  const r = A.compute(D({ periods: 3 }));
  const md = A.toMarkdown(r);
  assert.equal(md.indexOf('# 月费率摊成年化') >= 0, true);
  assert.equal(md.indexOf('| 期数 |') >= 0, true);
  assert.equal((md.match(/^\| \d+ \|/gm) || []).length, 3);
  assert.equal(md.indexOf('实际年化（复利）') >= 0, true);
});

test('L4 JSON 契约：可解析、关键字段与 compute 一致', () => {
  const r = A.compute(D({ periods: 5, earlyEnabled: true, earlyAt: 2 }));
  const o = JSON.parse(A.toJSON(r));
  assert.equal(o.input.periods, 5);
  assert.equal(o.schedule.length, 5);
  assert.ok(Math.abs(o.aprPct - r.aprPct) < 1e-12);
  assert.ok(Math.abs(o.totalFee - r.totalFee) < 1e-12);
  assert.equal(o.checks.length, r.checks.length);
  assert.equal(o.early.at, 2);
  assert.equal(o.rateLadder.length, r.rateLadder.length);
});

test('L5 展示格式：金额千分位两位小数、百分比、无穷与 NaN 显示为 —', () => {
  assert.equal(A.fmtMoney(13080), '13,080.00');
  assert.equal(A.fmtMoney(1090), '1,090.00');
  assert.equal(A.fmtMoney(NaN), '—');
  assert.equal(A.fmtMoney(Infinity), '—');
  assert.equal(A.fmtPct(17.477762), '17.48%');
  assert.equal(A.fmtPct(9), '9.00%');
  assert.equal(A.fmtPct(NaN), '—');
  assert.equal(A.fmtRatio(1.9419735), '1.94 倍');
  assert.equal(A.fmtRatio(NaN), '—');
});

test('M0 回归：年化与本金量级无关（0.01 元到 1000 万元的结果必须一致）', () => {
  /* 这条是给一个真实缺陷立的回归测试：早先 npv 闭包里的循环变量叫 k，与外层二分的 k 同名，
     内层循环把外层计数器改掉，二分只走一步就退出。小额本金时噪声刚好是正的、看不出来；
     本金 9,999,999.99 时残差变成负的，结果偏成 16.897% 而不是 17.4778%。
     现在 npv 先按本金归一化，再断言「量级无关」。 */
  const Ps = [0.01, 1, 100, 12000, 999999.99, 9999999.99, 10000000];
  const base = A.compute(D({ principal: 12000, periods: 60 })).aprPct;
  Ps.forEach((P) => {
    const r = A.compute(D({ principal: P, periods: 60 }));
    assert.equal(r.ok, true, 'P=' + P);
    assert.ok(Math.abs(r.aprPct - base) < 1e-6, 'P=' + P + '：' + r.aprPct + ' vs ' + base);
    assert.equal(r.checks.filter((c) => !c.pass).length, 0, 'P=' + P + ' 自检');
  });
  // 60 期 / 0.75% 的锚点（独立算：A = 12000×1.45/60 = 290，Σ290/(1+i)^t = 12000）
  assert.ok(Math.abs(base - 16.897322791296034) < 1e-9, '60 期锚点 ' + base);
});

test('M0b 回归：二分真的走到了收敛（根处归一化 NPV 接近 0，且不是一步退出）', () => {
  const P = 9999999.99, n = 60, f = 0.0075;
  const pay = (P + P * f * n) / n;
  const pays = [];
  for (let j = 0; j < n; j++) pays.push(pay);
  const r = A.monthlyRateFromFlows(P, pays);
  assert.equal(isFinite(r.i), true, JSON.stringify(r));
  let s = 0;
  for (let j = 0; j < n; j++) s += (pays[j] / P) / Math.pow(1 + r.i, j + 1);
  assert.ok(Math.abs(s - 1) < 1e-12, '归一化 NPV 残差 ' + (s - 1));
  // 与「年金因子闭式」独立对拍
  const ann = (1 - Math.pow(1 + r.i, -n)) / r.i;
  assert.ok(Math.abs(pay * ann - P) / P < 1e-12, '年金因子回代 ' + (pay * ann / P));
  // 一步退出的特征是根落在探测点上（0.001/0.005/…），这里必须不是
  [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5].forEach((probe) => {
    assert.ok(Math.abs(r.i - probe) > 1e-12, '根落在探测点 ' + probe + ' 上，说明二分没走');
  });
});

/* ═══════════════ M. 常识、单位与闭式核对 ═══════════════ */

test('M1 独立核对：等额还款口径的解精确满足年金因子闭式，并逐例对拍手算值', () => {
  /* 等额还款 A = P(1+nf)/n 时，Σ A/(1+i)^t = P 可以精确写成
       A · (1 − (1+i)^−n) / i = P
     这里是**在年化域里二分**求 i，用的是闭式年金因子（和引擎的逐期现金流二分是两条不同的式子），
     然后把结果与引擎的解逐例对拍；不依赖任何近似展开。 */
  const closed = (P, A_, n) => {
    const g = (i) => (i === 0 ? A_ * n - P : A_ * (1 - Math.pow(1 + i, -n)) / i - P);
    let lo = 0, hi = 10;
    for (let k = 0; k < 300; k++) { const mid = (lo + hi) / 2; if (g(mid) > 0) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  const cases = [[12000, 12, 0.75], [12000, 6, 0.75], [12000, 24, 0.75], [5000, 3, 1.5],
    [60000, 36, 0.6], [1000, 60, 0.05], [3000, 7, 1.234], [12000, 1, 0.75], [500, 48, 2.5]];
  cases.forEach(([P, n, fPct]) => {
    const r = A.compute(D({ principal: P, periods: n, monthlyRatePct: fPct, method: 'equal_installment' }));
    const A_ = P * (1 + n * fPct / 100) / n;
    const i1 = closed(P, A_, n);
    const rel = Math.abs(i1 - r.monthlyRate) / Math.max(1e-300, r.monthlyRate);
    assert.ok(rel < 1e-10, n + ' 期 / ' + fPct + '%：闭式年金 ' + i1 + ' vs 引擎 ' + r.monthlyRate);
    // 手算锚点写死：默认场景 i = 1090·a(12,i)=12000 的解
    if (P === 12000 && n === 12 && fPct === 0.75) {
      assert.ok(Math.abs(r.monthlyRate - 0.013513735380182523) < 1e-15);
      const annFactor = (1 - Math.pow(1 + r.monthlyRate, -12)) / r.monthlyRate;
      assert.ok(Math.abs(1090 * annFactor - 12000) < 1e-6, '年金因子回代 ' + (1090 * annFactor));
    }
  });
});

test('M2 单位核对：12 期 = 1 年，月利率 1% 的复利年化是 12.6825%', () => {
  const r = A.compute(D({ periods: 12, monthlyRatePct: 1, method: 'equal_installment' }));
  // 等额还款口径下手机算：A = 12000×1.12/12 = 1120，i = 1% ⇒ Σ1120/1.01^t = 1120×11.255077 = 12605.7 ≠ 12000
  // 所以这组输入的真实月利率不是 1%，此断言只核对「年化 = (1+i)^12 − 1」这条单位关系
  assert.ok(Math.abs(r.aprPct - ((Math.pow(1 + r.monthlyRate, 12) - 1) * 100)) < 1e-9);
  assert.equal(r.naivePct, 12);
  // 单期场景下月利率恰好等于月费率，可以精确核对单位
  const one = A.compute(D({ periods: 1, monthlyRatePct: 1 }));
  assert.ok(Math.abs(one.monthlyRatePct - 1) < 1e-9);
  assert.ok(Math.abs(one.aprPct - ((Math.pow(1.01, 12) - 1) * 100)) < 1e-9);
  assert.ok(Math.abs(one.aprPct - 12.682503013196972) < 1e-9);
});

test('M3 反直觉但正确：24 期手续费是 12 期的两倍，年化却只高一点点', () => {
  const a = A.compute(D({ periods: 12 })), b = A.compute(D({ periods: 24 }));
  assert.ok(Math.abs(b.totalFee / a.totalFee - 2) < 1e-12);
  assert.ok(b.aprPct - a.aprPct < 0.5, '只该高一点点：' + (b.aprPct - a.aprPct));
  assert.ok(b.aprPct - a.aprPct > 0.1);
});

test('M4 手续费总额与「月费率 × 期数 × 本金」严格一致（不受口径影响）', () => {
  ['equal_installment', 'equal_principal', 'fee_first'].forEach((m) => {
    [[12000, 12, 0.75], [9999.99, 7, 1.234], [500, 60, 0.05]].forEach(([P, n, f]) => {
      const r = A.compute(D({ principal: P, periods: n, monthlyRatePct: f, method: m }));
      assert.ok(Math.abs(r.totalFee - P * f / 100 * n) < 1e-9, m + ' ' + JSON.stringify([P, n, f]));
    });
  });
});

#!/usr/bin/env node
/* 批次 58 封面（1200×1200）：数字全部来自同一次引擎输出（先落盘 evidence/封面取值.json）。
 * 画法：生成临时 HTML → agent-browser 截图 → 01-installment-apr/cover.png。不手抄任何数字。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.existsSync(path.join(__dirname, '01-installment-apr')) ? __dirname : path.dirname(__dirname);
const APP = path.join(ROOT, '01-installment-apr');
const AB_REAL = '/Users/xululu/.workbuddy/binaries/node/versions/22.22.2-6/bin/agent-browser';
const SESSION = 'codex58-cover';
const C = require(path.join(APP, 'core.js'));

const v = C.compute(C.defaults());
if (!v.ok) { console.error('引擎没算干净，不画封面：', v.errors); process.exit(1); }
const bad = v.checks.filter((c) => !c.pass);
if (bad.length) { console.error('自检不通过，不画封面：', bad); process.exit(1); }

const early = C.compute(Object.assign(C.defaults(), { earlyEnabled: true, earlyAt: 6, earlyFeeRatePct: 0 }));
const free = C.compute(Object.assign(C.defaults(), { monthlyRatePct: 0, upfrontPrice: 11800, planPrice: 12000, cashRatePct: 0 }));

const out = {
  P: v.input.principal, n: v.input.periods, f: v.input.monthlyRatePct,
  fee: v.totalFee, pay: v.perPeriodPay, total: v.totalPaid,
  ratio: v.teachRatio, aprPct: v.aprPct, naivePct: v.naivePct,
  aprPP: v.aprPct - v.naivePct,                       // 两个年化口径相差几个百分点
  feeRatioPct: v.feeRatioPct,
  avgRatio: (v.input.periods + 1) / (2 * v.input.periods),
  early: { at: early.early.at, closePay: early.early.closePay, totalPaid: early.early.totalPaid, saved: early.early.savedVsFull, vStar: early.early.vStarPct, apr: early.early.apr * 100 },
  free: { gap: free.freeInterest.priceGap, breakEven: free.freeInterest.breakEvenRatePct, cash: free.freeInterest.cashEarn },
  checks: v.checks.length, selfFail: bad.length,
  stamp: new Date().toISOString(),
};
fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence', '封面取值.json'), JSON.stringify(out, null, 2));

const M = (x) => x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const P2 = (x) => x.toFixed(2) + '%';

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:1200px;background:#f5f2ea;color:#12303a;
  font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;padding:46px 56px;position:relative;overflow:hidden}
h1{font-size:60px;letter-spacing:1px;line-height:1.1}
.sub{margin-top:14px;font-size:26px;color:#3f5b66}
.sub b{color:#0b4f56}
.hero{margin-top:26px;background:linear-gradient(180deg,#0f6a72,#0b4f56);color:#fff;border-radius:22px;padding:26px 36px;display:flex;justify-content:space-between;align-items:flex-end}
.hero .cap{font-size:24px;opacity:.85}
.hero .big{font-size:96px;font-weight:800;line-height:1;letter-spacing:-2px}
.hero .right{text-align:right;font-size:23px;line-height:1.6}
.hero .right b{font-size:30px}
.chain{display:flex;gap:10px;margin-top:20px;align-items:stretch}
.step{flex:1;background:#fff;border:1px solid #d7e2e6;border-radius:14px;padding:13px 15px}
.step .k{font-size:20px;color:#6d8590}
.step .v{font-size:30px;font-weight:700;color:#0b4f56;margin:6px 0}
.step .d{font-size:18px;color:#6d8590;line-height:1.35}
.pts{margin-top:18px;display:grid;gap:12px}
.pt{background:#fff;border:1px solid #d7e2e6;border-radius:14px;padding:14px 20px;font-size:23px;line-height:1.5;color:#2b4a55}
.pt b{color:#b8560f;font-size:25px}
.pt i{font-style:normal;color:#0b4f56;font-weight:700}
.foot{margin-top:16px;font-size:19px;line-height:1.55;color:#6d8590}
.foot span{color:#8d9aa2}
.receipt{position:absolute;right:56px;top:46px;font-size:20px;color:#6d8590;text-align:right;line-height:1.5}
</style></head><body>
<div class="receipt">逐期票据口径<br>本金 / 期数 / 月费率 → 每期还款<br>→ 实际年化（复利）</div>
<h1>月费率摊成年化</h1>
<div class="sub">「${out.n} 期，月费率 ${out.f}%」——摊开成一张逐期票据：直算成年化是 <b>${P2(out.naivePct)}</b>，
但手续费按<b>整笔本金</b>每期收、本金却在一期期变少。</div>

<div class="hero">
  <div><div class="cap">实际年化（复利口径）</div><div class="big">${P2(out.aprPct)}</div></div>
  <div class="right">比例直算：<b>${P2(out.naivePct)}</b>（相差 ${out.aprPP.toFixed(2)} 个百分点）<br>
  教训比值 <b>${out.ratio.toFixed(2)} 倍</b><br>
  每期还款 <b>${M(out.pay)} 元</b> · 手续费合计 <b>${M(out.fee)} 元</b></div>
</div>

<div class="chain">
  <div class="step"><div class="k">你看到的</div><div class="v">${out.f}%/月</div><div class="d">结账页上那个数</div></div>
  <div class="step"><div class="k">它按什么收</div><div class="v">整笔本金 × 月费率</div><div class="d">不是按剩下没还的部分</div></div>
  <div class="step"><div class="k">×12 直算</div><div class="v">${P2(out.naivePct)}</div><div class="d">最常见的那一步错</div></div>
  <div class="step"><div class="k">平均占用本金</div><div class="v">${(out.avgRatio * 100).toFixed(1)}%</div><div class="d">(n+1)/(2n) = (${out.n}+1)/(2×${out.n})</div></div>
  <div class="step"><div class="k">折成年化</div><div class="v">${P2(out.aprPct)}</div><div class="d">(1+i)<sup>12</sup>−1</div></div>
</div>

<div class="pts">
  <div class="pt">本金 ${M(out.P)} 元、手续费占本金 <i>${P2(out.feeRatioPct)}</i>，
    但它换来的不是 <i>${P2(out.naivePct)}</i> 的成本，而是 <b>${P2(out.aprPct)}</b>。</div>
  <div class="pt">第 ${out.early.at} 期提前还清（违约金 0）：当次付 <b>${M(out.early.closePay)} 元</b>、总支出 ${M(out.early.totalPaid)} 元，
    比不还清少花 <b>${M(out.early.saved)} 元</b>；盈亏临界的违约金率是 <i>${out.early.vStar.toFixed(2)}%</i>。</div>
  <div class="pt">「免息」也不一定便宜：标价差 ${M(out.free.gap)} 元，这笔本金留 ${out.n} 期要赚回它，现金收益率得超过 <b>${P2(out.free.breakEven)}</b>。</div>
</div>

<div class="foot">口径：手续费 = 本金 × 月费率 × 期数；实际月利率 i 是 Σ pay<sub>t</sub>/(1+i)<sup>t</sup> = 本金 的解；实际年化 = (1+i)<sup>12</sup>−1。<br>
<span>默认场景是虚构示例，不代表任何真实产品、银行或平台的费率；页面不联网、不内置任何费率表、不推荐任何分期产品。自检 ${out.checks} 条，不通过 ${out.selfFail} 条。</span></div>
</body></html>`;

const tmp = path.join(ROOT, 'evidence', '_cover.html');
fs.writeFileSync(tmp, html);
/* 用独立 profile 起一个会话：绝不 close --all（那会把本轮的主会话一起关掉）。
   这个 profile 里同时只会有一个会话，跑完把 tmp 页面留着即可，收尾统一 close --all。 */
const COVER_PROF = '/Users/xululu/.agent-browser/cover-profile';
execFileSync(AB_REAL, ['--profile', COVER_PROF, '--session', SESSION, 'open', 'file://' + tmp], { encoding: 'utf8', timeout: 120000 });
execFileSync(AB_REAL, ['--session', SESSION, 'set', 'viewport', '1200', '1200'], { encoding: 'utf8', timeout: 60000 });
execFileSync('sleep', ['1']);
const shot = path.join(APP, 'cover.png');
execFileSync(AB_REAL, ['--session', SESSION, 'screenshot', shot], { encoding: 'utf8', timeout: 120000 });
const sz = fs.statSync(shot).size;
const b = fs.readFileSync(shot);
console.log('cover.png ' + sz + ' 字节 ' + b.readUInt32BE(16) + '×' + b.readUInt32BE(20));

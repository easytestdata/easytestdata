// Homepage teaser: regenerate the pre-rendered sample with a different template/preset/seed.
import { generatePlan } from "./core-adapter.js";
import { chartSvg, fmtInt, ledgerRowsHtml, statTilesHtml, summarize } from "./render.js";

const root = document.getElementById("teaser");
if (root) {
  const template = document.getElementById("teaser-template");
  const preset = document.getElementById("teaser-preset");
  const shuffle = document.getElementById("teaser-shuffle");
  const seedLabel = document.getElementById("teaser-seed");
  const stats = document.getElementById("teaser-stats");
  const chart = document.getElementById("teaser-chart");
  const ledger = document.getElementById("teaser-ledger");
  const total = document.getElementById("teaser-total");
  const open = document.getElementById("teaser-open");
  let seed = Number(seedLabel.textContent) || 42;

  const render = () => {
    const params = { template: template.value, preset: preset.value, seed, months: 12 };
    const plan = generatePlan(params);
    const s = summarize(plan);
    stats.innerHTML = statTilesHtml(s, { dark: true, limit: 4 });
    chart.innerHTML = chartSvg(s.monthly, { width: 400, height: 200, compact: true });
    ledger.innerHTML = ledgerRowsHtml(plan, 6);
    total.textContent = fmtInt(s.transactions);
    seedLabel.textContent = String(seed);
    open.href = `/playground?${new URLSearchParams({ ...params, seed: String(seed), months: "12" })}`;
  };

  template.addEventListener("change", render);
  preset.addEventListener("change", render);
  shuffle.addEventListener("click", () => {
    seed = Math.floor(Math.random() * 100000);
    render();
  });
}

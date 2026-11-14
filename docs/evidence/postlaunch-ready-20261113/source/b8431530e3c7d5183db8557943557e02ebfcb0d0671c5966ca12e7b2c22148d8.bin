import {calculateHostRevenue, formatHostUsdc, HostRevenueInputError, type HostRevenueField, type HostRevenueInput, type HostRevenueScenario} from '../../src/updates/host-revenue.js';

function appendText<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag);
  element.textContent = content;
  parent.append(element);
  return element;
}

function renderScenario(results: HTMLElement, scenario: HostRevenueScenario): void {
  results.replaceChildren();
  const top = results.ownerDocument.createElement('div');
  top.className = 'section-top';
  const holder = results.ownerDocument.createElement('div');
  const heading = appendText(holder, 'h2', 'Your modeled revenue.');
  heading.id = 'host-calculator-result-title';
  top.append(holder);
  appendText(top, 'p', `${scenario.feePercent}% fee scenario · ${scenario.days} ${scenario.days === '1' ? 'day' : 'days'} · identical paid hours each day.`);
  results.append(top);
  const details = results.ownerDocument.createElement('dl');
  details.className = 'host-calculator-summary';
  for (const [period, values] of [['Per day', scenario.daily], [`For ${scenario.days} ${scenario.days === '1' ? 'day' : 'days'}`, scenario.period]] as const) {
    for (const [label, value] of [['gross', values.grossAtomic], ['modeled fee', values.feeAtomic], ['net after modeled fee', values.netAtomic]] as const) {
      const row = results.ownerDocument.createElement('div');
      appendText(row, 'dt', `${period} — ${label}`);
      appendText(row, 'dd', formatHostUsdc(value));
      details.append(row);
    }
  }
  results.append(details);
  appendText(results, 'p', 'Net here deducts only the modeled fee. Electricity, hardware, taxes, downtime and other operating costs are excluded.');
  results.hidden = false;
}

/** Local arithmetic only: no requests, stored profile, wallet or transactions. */
export function mountHostCalculator(main: HTMLElement, heroHtml: string): void {
  main.innerHTML = heroHtml + `<section class="section host-calculator" aria-labelledby="host-calculator-form-title">
    <div class="section-top"><div><div class="eyebrow">Host revenue scenario</div><h2 id="host-calculator-form-title">Model completed work.</h2></div><p>Explore how your chosen price, paid hours and a hypothetical fee affect revenue. Price for completed work, not guaranteed income.</p></div>
    <form class="inline-form" id="host-calculator-form" novalidate>
      <p class="host-calculator-help">This calculator runs entirely in your browser. It reads no live market data and needs no wallet.</p>
      <label class="field"><span>Price basis</span><select id="host-price-basis" name="priceBasis" aria-describedby="host-price-basis-error"><option value="hour">USDC per hour</option><option value="second">USDC per second</option></select></label>
      <p id="host-price-basis-error" class="host-calculator-error" role="alert" hidden></p>
      <label class="field"><span>Price / USDC per chosen unit</span><input id="host-price" name="priceUsdc" type="text" inputmode="decimal" value="1" maxlength="24" autocomplete="off" spellcheck="false" aria-describedby="host-price-help host-price-error"></label>
      <p id="host-price-help" class="host-calculator-help">0–1,000,000,000 USDC per chosen unit. Use a plain decimal with up to six decimal places.</p>
      <p id="host-price-error" class="host-calculator-error" role="alert" hidden></p>
      <div class="form-row">
        <div><label class="field"><span>Paid hours per day</span><input id="host-paid-hours" name="paidHoursPerDay" type="text" inputmode="decimal" value="8" maxlength="24" autocomplete="off" spellcheck="false" aria-describedby="host-hours-help host-paid-hours-error"></label><p id="host-paid-hours-error" class="host-calculator-error" role="alert" hidden></p></div>
        <div><label class="field"><span>Period / days</span><input id="host-days" name="days" type="text" inputmode="numeric" value="30" maxlength="3" autocomplete="off" spellcheck="false" aria-describedby="host-days-help host-days-error"></label><p id="host-days-error" class="host-calculator-error" role="alert" hidden></p></div>
      </div>
      <p id="host-hours-help" class="host-calculator-help">0–24 paid hours per day, up to six decimal places. Count only completed billable work; available or idle hours do not earn revenue in this model.</p>
      <p id="host-days-help" class="host-calculator-help">1–366 whole days. The model repeats the same price and paid hours each day.</p>
      <label class="field"><span>Hypothetical fee model</span><select id="host-fee-model" name="feeModel" aria-describedby="host-fee-help host-fee-model-error"><option value="standard">Standard scenario / 9%</option><option value="sealed">Sealed scenario / 12%</option></select></label>
      <p id="host-fee-help" class="host-calculator-help">These are modeling assumptions. They do not describe the actual Legacy fee, confirm GPU or sealed availability, or establish collateral or booking terms.</p>
      <p id="host-fee-model-error" class="host-calculator-error" role="alert" hidden></p>
      <button class="pill primary" type="submit">Calculate scenario <span aria-hidden="true">↗</span></button>
      <p class="host-calculator-help" id="host-calculator-progress" role="status" aria-live="polite">Ready to calculate. No result yet.</p>
    </form>
    <div class="host-calculator-scope"><h3>How this model counts</h3><p>Gross revenue equals your price multiplied by paid time. Per-second pricing uses 3,600 seconds per paid hour; fractional hours are modeled continuously. Gross is rounded down daily to six USDC decimal places (one atomic unit is 0.000001 USDC). The daily fee is then rounded up to the next atomic unit. Net is gross less that fee, and period totals sum the rounded daily amounts.</p><p>This daily rounding policy is an estimate, not a representation of settlement-contract rounding or actual host payouts. No demand, utilization, admission, hardware eligibility or operating-cost assumptions are supplied by Telomere here.</p><a class="text-link" href="/hosts/">Review the host overview <span aria-hidden="true">↗</span></a></div>
    <section class="host-calculator-results" aria-labelledby="host-calculator-result-title" hidden></section>
  </section>`;
  const form = main.querySelector<HTMLFormElement>('#host-calculator-form')!;
  const results = main.querySelector<HTMLElement>('.host-calculator-results')!;
  const progress = main.querySelector<HTMLElement>('#host-calculator-progress')!;
  const fields: Record<HostRevenueField, HTMLInputElement | HTMLSelectElement> = {
    priceBasis: main.querySelector<HTMLSelectElement>('#host-price-basis')!,
    priceUsdc: main.querySelector<HTMLInputElement>('#host-price')!,
    paidHoursPerDay: main.querySelector<HTMLInputElement>('#host-paid-hours')!,
    days: main.querySelector<HTMLInputElement>('#host-days')!,
    feeModel: main.querySelector<HTMLSelectElement>('#host-fee-model')!,
  };
  const errors: Record<HostRevenueField, HTMLElement> = {
    priceBasis: main.querySelector<HTMLElement>('#host-price-basis-error')!,
    priceUsdc: main.querySelector<HTMLElement>('#host-price-error')!,
    paidHoursPerDay: main.querySelector<HTMLElement>('#host-paid-hours-error')!,
    days: main.querySelector<HTMLElement>('#host-days-error')!,
    feeModel: main.querySelector<HTMLElement>('#host-fee-model-error')!,
  };
  const clearErrors = (): void => {
    for (const key of Object.keys(fields) as HostRevenueField[]) {
      fields[key].removeAttribute('aria-invalid');
      errors[key].hidden = true;
      errors[key].textContent = '';
    }
  };
  const invalidateResult = (): void => {
    clearErrors();
    results.hidden = true;
    progress.textContent = 'Inputs changed. Calculate to update the scenario.';
  };
  form.addEventListener('input', invalidateResult);
  form.addEventListener('change', invalidateResult);
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearErrors();
    results.hidden = true;
    try {
      const input: HostRevenueInput = {
        priceBasis: fields.priceBasis.value as HostRevenueInput['priceBasis'], priceUsdc: fields.priceUsdc.value,
        paidHoursPerDay: fields.paidHoursPerDay.value, days: fields.days.value,
        feeModel: fields.feeModel.value as HostRevenueInput['feeModel'],
      };
      renderScenario(results, calculateHostRevenue(input));
      progress.textContent = 'Scenario calculated. Review daily and period amounts below.';
    } catch (failure: unknown) {
      if (failure instanceof HostRevenueInputError) {
        fields[failure.field].setAttribute('aria-invalid', 'true');
        errors[failure.field].textContent = failure.message;
        errors[failure.field].hidden = false;
        fields[failure.field].focus();
        progress.textContent = 'Check the highlighted field, then calculate again.';
      } else {
        progress.textContent = 'Calculation did not complete. Review your inputs and try again.';
      }
    }
  });
}

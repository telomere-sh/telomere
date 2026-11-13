import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  LEASH_PRESETS, LEASH_PREAUDIT_LIMITS, formatUsdcAtomic, mountLeashPresets,
  parseUsdcAtomic, resolveLeashLimits, resolveLeashPreset, validateLeashValues,
} from '../public/leash-presets.js';

describe('exact USDC spending suggestions', () => {
  it.each([
    ['conservative', '0.1', '1', '100000', '1000000'],
    ['standard', '1', '10', '1000000', '10000000'],
    ['selection-max', '20', '200', '20000000', '200000000'],
  ])('resolves %s without rounding', (id, hourly, daily, hourAtomic, dayAtomic) => {
    expect(resolveLeashPreset(id)).toEqual({ok: true, value: {
      hourly, daily, maxPerHourAtomic: hourAtomic, maxPerDayAtomic: dayAtomic,
    }});
  });

  it('preserves all six decimals using integer arithmetic', () => {
    expect(parseUsdcAtomic('0.000001')).toBe('1');
    expect(parseUsdcAtomic('250.000000')).toBe('250000000');
    expect(formatUsdcAtomic('100000001')).toBe('100.000001');
    expect(formatUsdcAtomic('1000000')).toBe('1');
    expect(formatUsdcAtomic('0')).toBe('0');
  });

  it.each(['', ' 1', '1 ', '1e2', '+1', '-1', '.1', '1.', '01', '0.0000001', 'NaN', 'Infinity', '1,000'])('rejects malformed decimal %s', value => {
    expect(parseUsdcAtomic(value)).toBeNull();
    expect(validateLeashValues(value, '10').ok).toBe(false);
  });

  it('rejects nonstring decimals, unknown choices, zero and reversed periods', () => {
    expect(parseUsdcAtomic(0.1)).toBeNull();
    expect(resolveLeashPreset('other').ok).toBe(false);
    expect(resolveLeashPreset('__proto__').ok).toBe(false);
    expect(validateLeashValues('0', '10').ok).toBe(false);
    expect(validateLeashValues('1', '0').ok).toBe(false);
    expect(validateLeashValues('2', '1')).toMatchObject({ok: false, field: 'daily'});
  });

  it('uses audited caps as exact maxima and enforces lower configuration', () => {
    expect(resolveLeashLimits()).toEqual({ok: true, value: LEASH_PREAUDIT_LIMITS});
    expect(validateLeashValues('250', '1000').ok).toBe(true);
    expect(validateLeashValues('250.000001', '1000')).toMatchObject({ok: false, field: 'hourly'});
    expect(validateLeashValues('1', '1000.000001')).toMatchObject({ok: false, field: 'daily'});
    expect(resolveLeashPreset('standard', {maxPerHourAtomic: '999999', maxPerDayAtomic: '10000000'})).toMatchObject({ok: false, field: 'hourly'});
    expect(resolveLeashPreset('standard', {maxPerHourAtomic: '1000000', maxPerDayAtomic: '9999999'})).toMatchObject({ok: false, field: 'daily'});
    expect(resolveLeashPreset('conservative', {maxPerHourAtomic: '100000', maxPerDayAtomic: '1000000'}).ok).toBe(true);
  });

  it.each([
    {maxPerHourAtomic: '0', maxPerDayAtomic: '1000000'},
    {maxPerHourAtomic: '-1', maxPerDayAtomic: '1000000'},
    {maxPerHourAtomic: '1.0', maxPerDayAtomic: '1000000'},
    {maxPerHourAtomic: '1e6', maxPerDayAtomic: '1000000'},
    {maxPerHourAtomic: '1000000', maxPerDayAtomic: '999999'},
    {maxPerHourAtomic: '250000001', maxPerDayAtomic: '1000000000'},
    {maxPerHourAtomic: '250000000', maxPerDayAtomic: '1000000001'},
    {maxPerHourAtomic: '999999999999999999999999', maxPerDayAtomic: '999999999999999999999999'},
  ])('rejects invalid/out-of-range runtime configuration %o', limits => {
    expect(resolveLeashLimits(limits).ok).toBe(false);
    expect(resolveLeashPreset('conservative', limits).ok).toBe(false);
  });

  it('rejects malformed runtime objects and malformed atomic formatting', () => {
    expect(resolveLeashLimits(null as never).ok).toBe(false);
    expect(resolveLeashLimits({} as never).ok).toBe(false);
    expect(resolveLeashLimits({maxPerHourAtomic: 1, maxPerDayAtomic: '1000000'} as never).ok).toBe(false);
    expect(() => formatUsdcAtomic('1.5')).toThrow();
    expect(() => formatUsdcAtomic('-1')).toThrow();
  });
});

// A deliberately narrow form adapter verifies event and mutation boundaries in
// node, without adding a browser or a DOM dependency to the project.
class FormNode {
  id = '';
  className = '';
  type = '';
  textContent = '';
  value = '';
  disabled = false;
  readOnly = false;
  dataset: Record<string, string> = {};
  children: FormNode[] = [];
  parent: FormNode | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  submit = vi.fn();
  requestSubmit = vi.fn();
  constructor(readonly tag: string, readonly ownerDocument: FormDocument) {}
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener();
    if (event.bubbles && this.parent) this.parent.dispatchEvent(event);
    return true;
  }
  append(...nodes: FormNode[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  insertBefore(node: FormNode, reference: FormNode): void {
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error('Reference is not a direct form child.');
    node.parent = this;
    this.children.splice(index, 0, node);
  }
  closest(selector: string): FormNode | null {
    if (this.className.split(' ').includes(selector.slice(1))) return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelector(selector: string): FormNode | null {
    const name = /name="([^"]+)"/.exec(selector)?.[1];
    return this.walk().find(node => node.tag === 'input' && node.getAttribute('name') === name && node.type === 'number') ?? null;
  }
  walk(): FormNode[] { return this.children.flatMap(child => [child, ...child.walk()]); }
  click(): void { this.dispatchEvent(new Event('click', {bubbles: true})); }
}

class FormDocument {
  defaultView = {Event};
  roots: FormNode[] = [];
  createElement(tag: string): FormNode { return new FormNode(tag, this); }
  getElementById(id: string): FormNode | null { return this.roots.flatMap(root => [root, ...root.walk()]).find(node => node.id === id) ?? null; }
}

function fixture() {
  const doc = new FormDocument();
  const form = doc.createElement('form');
  doc.roots.push(form);
  const row = doc.createElement('div');
  row.className = 'form-row';
  const input = (name: string, value: string) => {
    const field = doc.createElement('label');
    field.className = 'field';
    const node = doc.createElement('input');
    node.type = 'number';
    node.setAttribute('name', name);
    node.setAttribute('min', '0.01');
    node.setAttribute('max', '1000');
    node.setAttribute('step', '0.01');
    node.value = value;
    field.append(node);
    row.append(field);
    return node;
  };
  const hourly = input('hourly', '0.01');
  const daily = input('daily', '0.05');
  hourly.setAttribute('aria-describedby', 'existing-hourly-help');
  const untouched = ['name', 'expiry', 'hardware', 'sealed', 'agent'].map(name => {
    const node = doc.createElement('input');
    node.setAttribute('name', name);
    node.value = `${name}-original`;
    return node;
  });
  form.append(row, ...untouched);
  const events: string[] = [];
  for (const field of [hourly, daily]) for (const type of ['input', 'change']) {
    field.addEventListener(type, () => events.push(`${field.getAttribute('name')}:${type}:${hourly.value}/${daily.value}`));
  }
  const submit = vi.fn();
  form.addEventListener('submit', submit);
  const wallet = {request: vi.fn(), signTransaction: vi.fn(), signMessage: vi.fn()};
  const fetch = vi.fn();
  vi.stubGlobal('ethereum', wallet);
  vi.stubGlobal('fetch', fetch);
  const mount = (limits?: {maxPerHourAtomic: string; maxPerDayAtomic: string}) => mountLeashPresets(form as unknown as HTMLFormElement, limits);
  const buttons = () => form.walk().filter(node => node.tag === 'button');
  const error = () => form.walk().find(node => node.getAttribute('role') === 'alert')!;
  const status = () => form.walk().find(node => node.getAttribute('role') === 'status')!;
  const assertNoTransactions = () => {
    expect(submit).not.toHaveBeenCalled();
    expect(form.submit).not.toHaveBeenCalled();
    expect(form.requestSubmit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(wallet.request).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.signMessage).not.toHaveBeenCalled();
  };
  return {form, hourly, daily, untouched, events, mount, buttons, error, status, assertNoTransactions};
}

afterEach(() => vi.unstubAllGlobals());

describe('editable existing-form preset controls', () => {
  it('mounts once, writes both fields before ordinary validation events, and leaves unrelated inputs intact', () => {
    const f = fixture();
    f.mount();
    f.mount();
    expect(f.buttons()).toHaveLength(LEASH_PRESETS.length);
    expect(f.buttons().every(button => button.type === 'button')).toBe(true);
    expect(f.hourly.getAttribute('aria-describedby')).toBe(`existing-hourly-help ${f.error().id}`);
    expect(f.daily.getAttribute('aria-describedby')).toBe(f.error().id);
    f.buttons()[2]!.click();
    expect(f.hourly.value).toBe('20');
    expect(f.daily.value).toBe('200');
    expect(f.events).toEqual(['hourly:input:20/200', 'hourly:change:20/200', 'daily:input:20/200', 'daily:change:20/200']);
    expect(f.status().textContent).toContain('Selection-max applied');
    expect(f.status().getAttribute('aria-live')).toBe('polite');
    expect(f.untouched.map(node => node.value)).toEqual(['name-original', 'expiry-original', 'hardware-original', 'sealed-original', 'agent-original']);
    f.assertNoTransactions();
  });

  it('keeps values editable and clears success on any form edit or reset', () => {
    const f = fixture();
    f.mount();
    f.buttons()[0]!.click();
    f.hourly.value = '0.3';
    f.hourly.dispatchEvent(new Event('input', {bubbles: true}));
    expect(f.hourly.value).toBe('0.3');
    expect(f.status().textContent).toBe('');
    f.buttons()[0]!.click();
    f.untouched[0]!.dispatchEvent(new Event('change', {bubbles: true}));
    expect(f.status().textContent).toBe('');
    f.buttons()[0]!.click();
    f.form.dispatchEvent(new Event('reset'));
    expect(f.status().textContent).toBe('');
    f.assertNoTransactions();
  });

  it('rejects lower runtime caps atomically and refreshes limits on idempotent mount', () => {
    const f = fixture();
    f.mount();
    f.mount({maxPerHourAtomic: '100000', maxPerDayAtomic: '1000000'});
    f.buttons()[1]!.click();
    expect([f.hourly.value, f.daily.value]).toEqual(['0.01', '0.05']);
    expect(f.events).toEqual([]);
    expect(f.error().textContent).toContain('hourly cap of 0.1 USDC');
    f.untouched[1]!.dispatchEvent(new Event('input', {bubbles: true}));
    expect(f.error().textContent).toBe('');
    f.buttons()[0]!.click();
    expect([f.hourly.value, f.daily.value]).toEqual(['0.1', '1']);
    f.assertNoTransactions();
  });

  it.each(['min', 'max', 'step', 'disabled', 'readOnly'])('checks both native fields before mutation: %s', constraint => {
    const f = fixture();
    f.mount();
    if (constraint === 'disabled' || constraint === 'readOnly') f.daily[constraint] = true;
    else f.daily.setAttribute(constraint, constraint === 'min' ? '2' : constraint === 'step' ? '3' : '0.5');
    f.buttons()[0]!.click();
    expect([f.hourly.value, f.daily.value]).toEqual(['0.01', '0.05']);
    expect(f.events).toEqual([]);
    expect(f.error().textContent).toContain('current hourly or daily field limits');
    f.assertNoTransactions();
  });

  it('rejects invalid runtime caps without events and exposes a field-linked message', () => {
    const f = fixture();
    f.mount({maxPerHourAtomic: '250000001', maxPerDayAtomic: '1000000000'});
    f.buttons()[0]!.click();
    expect([f.hourly.value, f.daily.value]).toEqual(['0.01', '0.05']);
    expect(f.events).toEqual([]);
    expect(f.error().textContent).toContain('configuration is invalid');
    expect(f.error().getAttribute('role')).toBe('alert');
    expect(f.daily.getAttribute('aria-describedby')).toBe(f.error().id);
    f.assertNoTransactions();
  });
});

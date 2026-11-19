// Minimal DOM stub for testing public/markdown.js's renderMarkdown outside
// a browser. This project ships no jsdom dependency (see tests/README.md's
// "hand-verified only" convention for client-side code) - markdown.js only
// touches a handful of DOM primitives (createElement/createTextNode/
// createDocumentFragment, textContent, append, classList.add, dataset,
// style.textAlign), so a hand-rolled stub covering just those is enough to
// exercise the real rendering logic and assert on real output structure,
// in the same spirit as the rest of this app (hand-rolled over a dependency).
//
// installDomStub() installs `document` as a global and returns nothing;
// call it once per test file (or per test, it's cheap) before importing/
// using renderMarkdown. Elements expose `.toHTML()` for assertions and
// `.querySelectorAll(selector)` (flat; `tag`, `.class` or `tag.class` only)
// for structural checks.
//
// For the superagent job pane: append() accepts strings and flattens
// fragments like the real DOM, elements know their parentElement, carry
// listeners (dispatch(type) / click() call them), and a scrollTop. Clearing an
// element (textContent or replaceChildren) resets scrollTop on it and every
// ancestor, as a browser clamps the scroll once the content collapses, so a
// re-render that does not restore the scroll position is caught.

class TextNode {
  constructor(text) { this.text = String(text); }
  get textContent() { return this.text; }
  toHTML() {
    return this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function matcher(selector) {
  const [tag, ...classes] = selector.split('.');
  return (node) => node instanceof Element
    && (!tag || node.tag === tag)
    && classes.every((c) => node.classList.contains(c));
}

function adopt(parent, nodes) {
  const out = [];
  for (const node of nodes) {
    if (node instanceof Fragment) out.push(...adopt(parent, node.children.splice(0)));
    else if (typeof node === 'string') out.push(new TextNode(node));
    else {
      if (node instanceof Element) node.parentElement = parent;
      out.push(node);
    }
  }
  return out;
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.parentElement = null;
    this.listeners = {};
    this.scrollTop = 0;
    this.hidden = false;
    this._checked = false;
    this._disabled = false;
    this._type = '';
    const tokens = () => (this.attrs.class ? this.attrs.class.split(/\s+/).filter(Boolean) : []);
    const setTokens = (list) => {
      if (list.length) this.attrs.class = list.join(' ');
      else delete this.attrs.class;
    };
    this.classList = {
      add: (...cs) => setTokens([...tokens(), ...cs.filter((c) => !tokens().includes(c))]),
      remove: (...cs) => setTokens(tokens().filter((c) => !cs.includes(c))),
      contains: (c) => tokens().includes(c),
      toggle: (c, force) => {
        const on = force ?? !tokens().includes(c);
        if (on) this.classList.add(c);
        else this.classList.remove(c);
        return on;
      },
    };
  }
  append(...nodes) { this.children.push(...adopt(this, nodes)); }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) { this.children.unshift(...adopt(this, nodes)); }
  replaceChildren(...nodes) {
    this.collapse();
    this.children = adopt(this, nodes);
  }
  collapse() {
    for (let n = this; n; n = n.parentElement) n.scrollTop = 0;
  }
  set textContent(v) {
    this.collapse();
    this.children = [new TextNode(v)];
  }
  get textContent() {
    return this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('');
  }
  set href(v) { this.attrs.href = v; }
  get href() { return this.attrs.href; }
  set target(v) { this.attrs.target = v; }
  set rel(v) { this.attrs.rel = v; }
  set title(v) { this.attrs.title = v; }
  get title() { return this.attrs.title ?? ''; }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class ?? ''; }
  set type(v) { this._type = v; }
  get type() { return this._type; }
  set checked(v) { this._checked = v; }
  set disabled(v) { this._disabled = v; }
  get disabled() { return this._disabled; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault() {}, ...event });
  }
  click() { this.dispatch('click'); }
  // Flat descendant search - enough for these tests, no nesting scoping
  // needed since markdown.js's own structures are shallow.
  querySelectorAll(selector) {
    const match = matcher(selector);
    const out = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  toHTML() {
    const attrParts = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`);
    if (this.dataset.lang) attrParts.push(` data-lang="${this.dataset.lang}"`);
    if (this.style.textAlign) attrParts.push(` style="text-align:${this.style.textAlign}"`);
    if (this.tag === 'input') {
      attrParts.push(` type="${this._type}"`);
      if (this._checked) attrParts.push(' checked');
      if (this._disabled) attrParts.push(' disabled');
      return `<input${attrParts.join('')}>`;
    }
    if (this.tag === 'hr') return `<hr${attrParts.join('')}>`;
    const inner = this.children.map((c) => c.toHTML()).join('');
    return `<${this.tag}${attrParts.join('')}>${inner}</${this.tag}>`;
  }
}

class Fragment {
  constructor() { this.children = []; }
  append(...nodes) { this.children.push(...adopt(this, nodes)); }
  get textContent() { return this.children.map((c) => c.textContent ?? '').join(''); }
  querySelectorAll(selector) { return Element.prototype.querySelectorAll.call(this, selector); }
  toHTML() { return this.children.map((c) => c.toHTML()).join(''); }
}

export function installDomStub() {
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new Fragment(),
  };
}

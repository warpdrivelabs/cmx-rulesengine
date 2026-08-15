/**
 * RuleElementBase —— 可嵌决策规则 Web Component 的共用基类（F5，对标 flow FlowElementBase）。
 *
 * 把 native-page 核模块（ui-native/rule/*.js，导出 { configure, mount, default.views }）包成框架无关
 * custom element：第三方 `<script type=module>` 引入 + 放标签 + 配 `api-base`/`token`/`decision-key`
 * 等属性即用，可嵌进 React/Vue/Angular/原生。对标 cmx-mega-sheet 的 <cmx-megasheet>。
 *
 * 三件事：
 *  ① 属性 → configure()：api-base/token/tenant/user 映射成核 CFG 覆盖（apiBase 前缀、authHeaders 注 Bearer/X-Tenant）。
 *  ② 区域 host → mount()：每区造一个 shadow 内 <div>，令 div.renderRoot=div 自身，把 (host,props) 交给核 mount(ctx,view)。
 *  ③ props：collectProps() 从 decision-key/version 属性收集 ctx.props（多实例设计器/仿真台按 key@@version 隔离）。
 *
 * 纯 vanilla、shadow DOM、零框架依赖。
 */

const ElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : /** @type {any} */ (class {});

const BASE_CSS = `
:host{display:block;min-height:280px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif}
:host([hidden]){display:none}
.rule-shell{display:flex;width:100%;height:100%;min-height:280px;overflow:hidden}
.rule-region{overflow:auto;min-width:0;min-height:0;box-sizing:border-box}
.rule-region-explorer{flex:0 0 260px;border-right:1px solid var(--rule-line,#e2e6ec)}
.rule-region-content{flex:1 1 auto}
.rule-region-property{flex:0 0 330px;border-left:1px solid var(--rule-line,#e2e6ec)}
.rule-shell[data-single] .rule-region{flex:1 1 auto;border:0}
`;

export class RuleElementBase extends ElementBase {
  // 子类须提供：static coreModule（native 核命名空间）、static regions（区域数组）；可选 collectProps()。
  _built = false;
  _hosts = [];

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._applyConfigure();
    this._buildShadow();
    this._mountRegions();
  }
  disconnectedCallback() {
    for (const h of this._hosts) { try { h.remove(); } catch { /* */ } }
    this._hosts = [];
    this._built = false;
  }
  attributeChangedCallback(name, oldVal, newVal) {
    if (!this._built || oldVal === newVal) return;
    this._applyConfigure();
    this._mountRegions();
  }

  _applyConfigure() {
    const core = this.constructor.coreModule;
    if (!core || typeof core.configure !== 'function') return;
    const apiBase = this.getAttribute('api-base') || '';
    const token = this.getAttribute('token') || '';
    const tenant = this.getAttribute('tenant') || '';
    const user = this.getAttribute('user') || '';
    const creds = this.getAttribute('credentials') || (token ? 'omit' : 'same-origin');
    const cfg = {
      apiBase,
      fetchInit: { credentials: creds },
      authHeaders: () => {
        const h = {};
        if (token) h.Authorization = 'Bearer ' + token;
        if (tenant) h['X-Tenant'] = tenant;
        return h;
      },
    };
    if (user) cfg.getUser = () => user;
    core.configure(cfg);
  }

  _buildShadow() {
    const shadow = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    shadow.appendChild(style);
    const shell = document.createElement('div');
    shell.className = 'rule-shell';
    const regions = this.constructor.regions || ['content'];
    if (regions.length === 1) shell.setAttribute('data-single', '');
    for (const view of regions) {
      const host = document.createElement('div');
      host.className = 'rule-region rule-region-' + view;
      host.renderRoot = host;
      host.__ruleRegion = view;
      shell.appendChild(host);
      this._hosts.push(host);
    }
    shadow.appendChild(shell);
  }

  _mountRegions() {
    const core = this.constructor.coreModule;
    if (!core || typeof core.mount !== 'function') return;
    const props = (typeof this.collectProps === 'function') ? this.collectProps() : undefined;
    for (const host of this._hosts) {
      const ctx = props !== undefined ? { host, props } : { host };
      try { core.mount(ctx, host.__ruleRegion); } catch (e) { console.error('[rule-element] mount 失败', host.__ruleRegion, e); }
    }
  }

  /** 逃生舱：拿到核模块（configure/mount + 公开函数），宿主可做高级操作。 */
  getCore() { return this.constructor.coreModule; }
}

/** 安全注册 custom element（重复定义/无 customElements 环境跳过）。 */
export function defineRuleElement(tag, cls) {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, cls);
}

/** decision-key/version → ctx.props（多实例设计器/仿真台按 key@@version 隔离）。 */
export function collectDecisionProps(el) {
  const key = el.getAttribute('decision-key') || '';
  const version = parseInt(el.getAttribute('version') || '1', 10) || 1;
  const name = el.getAttribute('decision-name') || key;
  return { key, name, version };
}

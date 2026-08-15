/**
 * cmx-rulesengine 可嵌 Web Component 桶入口（F5，对标 cmx-flowengine/web/index.js）。
 *
 * 用法（第三方/任意框架，无需门户）：
 *   <script type="module" src="https://cdn/…/cmx-rulesengine/web/index.js"></script>
 *   <rule-designer  api-base="https://rules.example" token="<JWT>" decision-key="credit_approval"></rule-designer>
 *   <rule-simulator api-base="https://rules.example" token="<JWT>" decision-key="credit_approval"></rule-simulator>
 *   <rule-logs      api-base="https://rules.example" token="<JWT>"></rule-logs>
 *
 * 三个 custom element 各包一个 native-page 核（ui-native/rule/*.js，一芯多壳）：属性 api-base/token/
 * tenant/decision-key → 核 configure + 四区 mount。api-base 为空 = 同源（门户内嵌路径）。
 */

export { RuleElementBase, defineRuleElement, collectDecisionProps } from './elements/base-element.js';
export { RuleDesignerElement } from './elements/rule-designer.js';
export { RuleSimulatorElement } from './elements/rule-simulator.js';
export { RuleLogsElement } from './elements/rule-logs.js';

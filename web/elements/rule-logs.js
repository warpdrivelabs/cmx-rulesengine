/** <rule-logs> —— 可嵌决策审计中心（四区，列表页无需 decision-key）。属性：api-base/token/tenant。 */
import { RuleElementBase, defineRuleElement } from './base-element.js';
import * as core from '../ui-native/rule/logs.js';

export class RuleLogsElement extends RuleElementBase {
  static coreModule = core;
  static regions = ['explorer', 'content', 'property'];
  static get observedAttributes() { return ['api-base', 'token', 'tenant', 'user']; }
}
defineRuleElement('rule-logs', RuleLogsElement);

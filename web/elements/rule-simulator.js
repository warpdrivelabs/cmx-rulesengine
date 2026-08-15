/** <rule-simulator> —— 可嵌决策仿真台（四区）。属性：api-base/token/tenant/decision-key/version。 */
import { RuleElementBase, defineRuleElement, collectDecisionProps } from './base-element.js';
import * as core from '../ui-native/rule/simulator.js';

export class RuleSimulatorElement extends RuleElementBase {
  static coreModule = core;
  static regions = ['explorer', 'content', 'property'];
  static get observedAttributes() { return ['api-base', 'token', 'tenant', 'user', 'decision-key', 'version']; }
  collectProps() { return collectDecisionProps(this); }
}
defineRuleElement('rule-simulator', RuleSimulatorElement);

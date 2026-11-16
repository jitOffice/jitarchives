/** 自研控件共用的选项类型：值统一为字符串，便于与既有 v-model 字段类型保持一致。 */
export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

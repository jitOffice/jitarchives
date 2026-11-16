/**
 * 元数据模板字段定义与档案动态著录值的服务端校验（阶段二第四批）。
 * 单一职责：把「字段类型 + options + validation」规范成可持久化 JSON，并按定义校验/归一化用户提交的值。
 * 所有校验只在后端执行，前端仅据 /template-fields 定义渲染控件，不作为安全/正确性保证。
 */
import { BadRequestException } from '@nestjs/common';
import { FieldType, TemplateFieldRow } from './template.repositories';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FieldDefinitionInput {
  type: FieldType;
  options?: unknown; // string[]
  validation?: unknown; // object
}

/** 校验并归一化字段定义（写入 template_fields 前）。返回安全的 JSON 字符串。 */
export function normalizeFieldDefinition(input: FieldDefinitionInput): {
  optionsJson: string;
  validationJson: string;
} {
  const options = Array.isArray(input.options)
    ? input.options.map((o) => String(o).trim()).filter((o) => o.length > 0)
    : [];
  let validation: Record<string, unknown> = {};
  const raw = input.validation;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) validation = { ...(raw as object) };

  switch (input.type) {
    case 'select':
    case 'tags': {
      if (options.length === 0) {
        throw new BadRequestException(`${input.type === 'select' ? '下拉' : '多选'}字段必须提供候选项`);
      }
      if (new Set(options).size !== options.length) {
        throw new BadRequestException('候选项不能重复');
      }
      if (options.some((o) => o.length > 50)) {
        throw new BadRequestException('单个候选项不能超过 50 个字符');
      }
      break;
    }
    case 'number': {
      const min = validation.min;
      const max = validation.max;
      if (min !== undefined && min !== null && !Number.isFinite(Number(min))) {
        throw new BadRequestException('数值字段最小值不合法');
      }
      if (max !== undefined && max !== null && !Number.isFinite(Number(max))) {
        throw new BadRequestException('数值字段最大值不合法');
      }
      if (min != null && max != null && Number(min) > Number(max)) {
        throw new BadRequestException('数值字段最小值不能大于最大值');
      }
      break;
    }
    case 'text':
    case 'textarea': {
      const maxLen = validation.maxLength;
      if (maxLen !== undefined && maxLen !== null) {
        const n = Number(maxLen);
        if (!Number.isInteger(n) || n <= 0 || n > 5000) {
          throw new BadRequestException('文本字段最大长度需为 1-5000 的整数');
        }
      }
      if (validation.pattern !== undefined && validation.pattern !== null) {
        try {
          new RegExp(String(validation.pattern));
        } catch {
          throw new BadRequestException('文本字段正则表达式不合法');
        }
      }
      break;
    }
    default:
      break;
  }
  return { optionsJson: JSON.stringify(options), validationJson: JSON.stringify(validation) };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * 按字段定义校验并归一化档案动态著录值，返回用于入库的字符串（value_text）。
 * - 非必填且为空：入库空串；
 * - 必填为空：拒绝；
 * - 各类型分别做数值范围 / 日期格式 / 选项成员 / 正则 / 长度 / 布尔 / 多选数量校验。
 */
export function normalizeArchiveValue(field: TemplateFieldRow, raw: unknown): string {
  const options = parseJson<string[]>(field.optionsJson, []);
  const validation = parseJson<Record<string, unknown>>(field.validationJson, {});
  const isEmpty =
    raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');

  if (isEmpty) {
    if (field.required === 1) throw new BadRequestException(`「${field.label}」为必填项`);
    return '';
  }

  switch (field.type) {
    case 'text':
    case 'textarea': {
      const s = String(raw).trim();
      const maxLen = validation.maxLength != null ? Number(validation.maxLength) : field.type === 'text' ? 200 : 2000;
      if (s.length > maxLen) throw new BadRequestException(`「${field.label}」不能超过 ${maxLen} 个字符`);
      if (validation.pattern != null) {
        let re: RegExp;
        try {
          re = new RegExp(String(validation.pattern));
        } catch {
          throw new BadRequestException(`「${field.label}」校验规则配置异常`);
        }
        if (!re.test(s)) throw new BadRequestException(`「${field.label}」格式不符合要求`);
      }
      return s;
    }
    case 'number': {
      const n = Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new BadRequestException(`「${field.label}」必须为数字`);
      if (validation.min != null && n < Number(validation.min)) {
        throw new BadRequestException(`「${field.label}」不能小于 ${validation.min}`);
      }
      if (validation.max != null && n > Number(validation.max)) {
        throw new BadRequestException(`「${field.label}」不能大于 ${validation.max}`);
      }
      return String(n);
    }
    case 'date': {
      const s = String(raw).trim().slice(0, 10);
      if (!DATE_RE.test(s) || Number(s.slice(0, 4)) < 1900 || Number(s.slice(5, 7)) > 12 || Number(s.slice(8, 10)) > 31) {
        throw new BadRequestException(`「${field.label}」日期格式需为 YYYY-MM-DD`);
      }
      return s;
    }
    case 'select': {
      const s = String(raw).trim();
      if (!options.includes(s)) throw new BadRequestException(`「${field.label}」取值不在候选项内`);
      return s;
    }
    case 'bool': {
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'yes', '是'].includes(s)) return '1';
      if (['0', 'false', 'no', '否', ''].includes(s)) return '0';
      throw new BadRequestException(`「${field.label}」必须为布尔值`);
    }
    case 'tags': {
      let arr: unknown;
      if (Array.isArray(raw)) arr = raw;
      else {
        try {
          arr = JSON.parse(String(raw));
        } catch {
          arr = String(raw)
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean);
        }
      }
      if (!Array.isArray(arr)) throw new BadRequestException(`「${field.label}」必须为多选项集合`);
      const items = arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
      const maxItems = validation.maxItems != null ? Number(validation.maxItems) : undefined;
      if (maxItems != null && items.length > maxItems) {
        throw new BadRequestException(`「${field.label}」最多选择 ${maxItems} 项`);
      }
      for (const it of items) {
        if (!options.includes(it)) throw new BadRequestException(`「${field.label}」存在非法选项：${it}`);
      }
      return JSON.stringify(Array.from(new Set(items)));
    }
    default:
      throw new BadRequestException('不支持的字段类型');
  }
}

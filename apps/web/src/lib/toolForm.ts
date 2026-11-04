import type { JobOptions, ToolField } from './api';

export type FormValues = Record<string, string | boolean>;

/** Starting values for a tool's form, taken from the field definitions. */
export function initialValues(fields: ToolField[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    if (f.type === 'checkbox') values[f.key] = f.default === true;
    else values[f.key] = f.default === undefined ? '' : String(f.default);
  }
  return values;
}

/** A field is shown (and sent) only while the field it depends on has the required value. */
export function isVisible(field: ToolField, values: FormValues): boolean {
  if (!field.showIf) return true;
  return String(values[field.showIf.key]) === String(field.showIf.equals);
}

export type BuildResult = { ok: true; options: JobOptions } | { ok: false; error: string; field: string };

/**
 * Turn form values into the JSON the API expects: hidden and empty optional fields are left out,
 * numbers become numbers, and obvious mistakes are caught before a request is made.
 * (The server validates again — this is only for fast, friendly feedback.)
 */
export function buildOptions(fields: ToolField[], values: FormValues): BuildResult {
  const options: JobOptions = {};
  for (const f of fields) {
    if (!isVisible(f, values)) continue;
    const raw = values[f.key];
    if (f.type === 'checkbox') {
      options[f.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? (f.type === 'password' ? raw : raw.trim()) : '';
    if (text === '') {
      if (f.required) return { ok: false, field: f.key, error: `Please fill in “${f.label}”.` };
      continue;
    }
    if (f.type === 'number' || f.valueType === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, field: f.key, error: `“${f.label}” must be a number.` };
      if (f.min !== undefined && n < f.min)
        return { ok: false, field: f.key, error: `“${f.label}” must be at least ${f.min}.` };
      if (f.max !== undefined && n > f.max)
        return { ok: false, field: f.key, error: `“${f.label}” must be at most ${f.max}.` };
      options[f.key] = n;
    } else {
      options[f.key] = text;
    }
  }
  return { ok: true, options };
}

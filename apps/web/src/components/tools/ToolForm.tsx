'use client';

import type { ToolField } from '@/lib/api';
import { isVisible, type FormValues } from '@/lib/toolForm';
import { cn } from '@/lib/cn';
import { Input, Label, Select } from '@/components/ui/primitives';

interface Props {
  fields: ToolField[];
  values: FormValues;
  onChange: (key: string, value: string | boolean) => void;
  /** Key of the field that failed validation, for aria-invalid and focus styling. */
  invalidField?: string;
  disabled?: boolean;
}

/**
 * Renders a tool's options from the field definitions supplied by the backend, so adding a tool never
 * needs new form code here. Labels, hints and errors are real text (not colour alone) and every control
 * is a native, keyboard-friendly element.
 */
export function ToolForm({ fields, values, onChange, invalidField, disabled }: Props) {
  const visible = fields.filter((f) => isVisible(f, values));
  if (visible.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visible.map((f) => {
        const id = `tool-field-${f.key}`;
        const hintId = f.hint ? `${id}-hint` : undefined;
        const invalid = invalidField === f.key;
        const value = values[f.key];
        if (f.type === 'checkbox') {
          return (
            <label
              key={f.key}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 sm:col-span-2"
            >
              <input
                id={id}
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--accent)]"
                checked={value === true}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
              <span className="text-sm text-ink">
                {f.label}
                {f.hint && <span className="block text-xs text-muted">{f.hint}</span>}
              </span>
            </label>
          );
        }
        const wide = f.type === 'pages' || f.type === 'text' || f.type === 'password';
        return (
          <div key={f.key} className={cn(wide && 'sm:col-span-2')}>
            <Label htmlFor={id}>
              {f.label}
              {f.required && (
                <span className="text-danger" aria-hidden>
                  {' '}
                  *
                </span>
              )}
            </Label>
            {f.type === 'select' ? (
              <Select
                id={id}
                value={String(value ?? '')}
                disabled={disabled}
                aria-describedby={hintId}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="relative">
                <Input
                  id={id}
                  type={f.type === 'password' ? 'password' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  autoComplete={f.type === 'password' ? 'new-password' : 'off'}
                  autoCapitalize="off"
                  spellCheck={false}
                  maxLength={f.maxLength}
                  placeholder={f.placeholder ?? (f.type === 'pages' ? 'e.g. 1-3, 5' : undefined)}
                  value={String(value ?? '')}
                  disabled={disabled}
                  aria-describedby={hintId}
                  aria-invalid={invalid || undefined}
                  required={f.required}
                  className={cn(f.unit && 'pr-16', invalid && 'border-danger')}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
                {f.unit && (
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">
                    {f.unit}
                  </span>
                )}
              </div>
            )}
            {f.hint && (
              <p id={hintId} className="mt-1 text-xs text-muted">
                {f.hint}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

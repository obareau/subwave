'use client';

// Bound field components: the react-hook-form half of lib/form.ts.
//
// Each takes `control` + `name`, subscribes with useController, and renders the
// whole Field composition — label, control, description, error — with the ARIA
// already wired through fieldAria. That single-sourcing is the point: thirteen
// forms inherit correct aria-invalid / aria-describedby instead of thirteen
// forms each getting it right.
//
// Deliberately five components, chosen by counting what the converted forms
// actually use. Anything else — chip inputs, month/day pickers, sliders, the
// avatar picker — drops to a raw <Controller>. A bound wrapper for a one-off
// control is indirection with no payoff.
//
// This lives beside form.ts rather than inside it so form.ts keeps its git
// history: its comments (the three-generics rationale, the dangling
// aria-describedby note) are load-bearing and a .ts -> .tsx rename reads as
// delete-plus-add.
import { useId } from 'react';
import type {
  ComponentPropsWithoutRef,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { fieldAria } from '@/lib/form';
import {
  Field,
  FieldLabel,
  FieldTitle,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface Option {
  value: string;
  label: string;
}

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

// One hook call shared by all five, so the id derivation and the fieldAria
// call happen in exactly one place.
function useBoundField<T extends FieldValues>(
  control: Control<T>,
  name: FieldPath<T>,
  hasDescription: boolean,
) {
  // useId, not the field name: two forms on one page (StationsPanel has a
  // create and a rename form) would otherwise mint the same element ids.
  const uid = useId();
  const baseId = `${uid}-${name}`;
  const { field, fieldState } = useController({ control, name });
  const aria = fieldAria(baseId, fieldState.error, { hasDescription });
  return { field, fieldState, aria };
}

// Native attributes a caller may need on the underlying element that this
// component doesn't otherwise name (autoComplete, maxLength, min/max/step,
// autoFocus, ...) — everything the component itself already controls is
// omitted so a stray rest prop can never fight the controlled value/handlers.
type TextFieldRest = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'ref' | 'id' | 'name' | 'className' | 'disabled' | 'placeholder' | 'type'
>;

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  numeric,
  type,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { placeholder?: string; numeric?: boolean; type?: string } & TextFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Input
        {...rest}
        {...aria.controlProps}
        type={type ?? (numeric ? 'number' : 'text')}
        placeholder={placeholder}
        disabled={disabled}
        // A zod z.coerce.number() field has an INPUT type of unknown (measured:
        // z.input accepts a string, z.output does not), so the value arriving
        // here is not necessarily a string. Stringify for the DOM and hand back
        // a number on change when `numeric`, so the resolver's coercion never
        // has to rescue a value the input mangled.
        value={field.value == null ? '' : String(field.value)}
        onChange={e => {
          const raw = e.target.value;
          if (!numeric) { field.onChange(raw); return; }
          if (raw === '') { field.onChange(''); return; }
          const n = Number(raw);
          field.onChange(Number.isFinite(n) ? n : raw);
        }}
        onBlur={field.onBlur}
        ref={field.ref}
      />
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type TextareaFieldRest = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'onBlur' | 'ref' | 'id' | 'name' | 'className' | 'disabled' | 'placeholder' | 'rows'
>;

export function TextareaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  rows,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { placeholder?: string; rows?: number } & TextareaFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Textarea
        {...rest}
        {...aria.controlProps}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        value={field.value == null ? '' : String(field.value)}
        onChange={e => field.onChange(e.target.value)}
        onBlur={field.onBlur}
        ref={field.ref}
      />
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type SelectFieldRest = Omit<
  ComponentPropsWithoutRef<typeof SelectTrigger>,
  'value' | 'onBlur' | 'ref' | 'id' | 'children' | 'className' | 'disabled'
>;

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  placeholder,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { options: Option[]; placeholder?: string } & SelectFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Select
        value={field.value == null ? '' : String(field.value)}
        onValueChange={field.onChange}
        disabled={disabled}
      >
        <SelectTrigger {...rest} {...aria.controlProps} onBlur={field.onBlur} ref={field.ref}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {/* SelectItem always inside a SelectGroup — shadcn composition rule. */}
          <SelectGroup>
            {options.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type SwitchFieldRest = Omit<
  ComponentPropsWithoutRef<typeof Switch>,
  'checked' | 'onCheckedChange' | 'onBlur' | 'ref' | 'id' | 'className' | 'disabled'
>;

export function SwitchField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  ...rest
}: BaseProps<T> & SwitchFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field
      orientation="horizontal"
      data-invalid={aria.invalid || undefined}
      className={className}
    >
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Switch
        {...rest}
        {...aria.controlProps}
        checked={!!field.value}
        onCheckedChange={field.onChange}
        onBlur={field.onBlur}
        disabled={disabled}
        ref={field.ref}
      />
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

// ToggleGroup's own props are a `type`-discriminated union (single vs
// multiple value shapes), and Omit over a union collapses to its SHARED keys
// only — exactly what's wanted here: the type-specific `value`/`onValueChange`
// stay owned by this component, and what's left (orientation, dir, loop, ...)
// is safe to forward.
type ToggleGroupFieldRest = Omit<
  ComponentPropsWithoutRef<typeof ToggleGroup>,
  'type' | 'value' | 'defaultValue' | 'onValueChange' | 'disabled' | 'children' | 'className'
>;

export function ToggleGroupField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  disabled,
  className,
  multiple,
  ...rest
}: BaseProps<T> & { options: Option[]; multiple?: boolean } & ToggleGroupFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  // `multiple` is opt-in and defaults to the original single-select radio
  // behaviour (unclickable-to-empty, since that reading is what every other
  // caller of this component wants — a required field like `frequency`).
  // Array-valued fields (Show's `energies`, capped multi-choice) need Radix's
  // own `type="multiple"`, whose value/onValueChange shape is a string[], not
  // a string — so both branches read/write field.value through the same
  // `field`, just coerced to the shape Radix expects for that type.
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      {/* A ToggleGroup is a group of buttons with no single labelable control,
          so it names itself via aria-labelledby rather than htmlFor. FieldTitle,
          not FieldLabel: FieldLabel renders a <label>, whose htmlFor would have
          to point at a <div>, which is invalid. FieldTitle is the primitive for
          exactly this case — a plain div with the same typography. */}
      <FieldTitle {...aria.labelledByProps}>{label}</FieldTitle>
      {multiple ? (
        <ToggleGroup
          {...rest}
          {...aria.groupProps}
          type="multiple"
          value={Array.isArray(field.value) ? field.value.map(String) : []}
          onValueChange={(v: string[]) => field.onChange(v)}
          disabled={disabled}
        >
          {options.map(o => (
            <ToggleGroupItem key={o.value} value={o.value}>{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <ToggleGroup
          {...rest}
          {...aria.groupProps}
          type="single"
          value={field.value == null ? '' : String(field.value)}
          onValueChange={(v: string) => { if (v) field.onChange(v); }}
          disabled={disabled}
        >
          {options.map(o => (
            <ToggleGroupItem key={o.value} value={o.value}>{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

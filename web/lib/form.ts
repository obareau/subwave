// Thin react-hook-form + zod wiring, written once rather than in each of the
// ~78 admin forms.
//
// The schemas come from lib/schemas.generated.ts — the committed mirror of
// controller/src/schemas/**, kept honest by a CI drift check. So the rules this
// resolver enforces are byte-for-byte the rules the controller enforces.
//
// Note there is deliberately no ui/form.tsx: shadcn's Field primitives are
// already vendored at components/ui/field.tsx, and FieldError already accepts
// react-hook-form's { message } error shape.
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
import type { z } from 'zod';

// All THREE generics are passed on purpose.
//
// react-hook-form is useForm<TFieldValues, TContext, TTransformedValues>, and
// handleSubmit's callback receives TTransformedValues — which is what
// zodResolver actually hands it at runtime, i.e. z.output<S>. Passing only
// z.input<S> lets TTransformedValues silently default to the INPUT type. That
// is harmless while a schema's output is a superset of its input (webhooks),
// but the first type-CHANGING transform — z.coerce.number(),
// z.string().transform(Number), an object-reshaping .transform() — would type
// `values.x` as string while it is really a number, with no error anywhere.
// The middle generic is TContext, which nothing here uses; `unknown` rather
// than react-hook-form's `any` default.
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  return useForm<z.input<S>, unknown, z.output<S>>({
    // A cast is unavoidable here: inside this function TS only knows S by its
    // constraint, so it collapses z.input<S>/z.output<S> to plain FieldValues
    // and zodResolver comes back as Resolver<FieldValues, unknown, FieldValues>.
    // The assertion is deliberately on the SCHEMA, not on the resolver: it
    // states only the tautology that S is a ZodType carrying S's own input and
    // output types, and lets the Resolver type stay DERIVED from
    // @hookform/resolvers' own signature — so if that signature changes, this
    // follows it instead of overriding it. Nothing about runtime changes;
    // zodResolver(schema) is still exactly what is called.
    resolver: zodResolver(schema as unknown as z.ZodType<z.output<S>, z.input<S>>),
    defaultValues,
    // Validate as the operator types, so the Save button's disabled state
    // tracks validity without a submit attempt — matching the behaviour the
    // hand-rolled `valid()` predicate used to provide.
    mode: 'onChange',
  });
}

// ARIA wiring for one field, derived from a single base id.
//
// The Field primitives in components/ui/field.tsx are presentational: their
// `data-invalid` turns the field red, and FieldError renders role="alert" so a
// message is ANNOUNCED the moment it appears. Neither of those associates the
// message with the control, which is what a screen-reader user needs when they
// tab BACK to the input — without it the field is an unlabelled-as-invalid box
// whose explanation was read once and is now unreachable.
//
// Returned as spreadable groups so no form open-codes the id suffixes. Two
// forms deriving `-error` differently is exactly the drift this shared
// foundation exists to prevent, and every convertible form has this same shape.
export function fieldAria(
  baseId: string,
  error?: { message?: string },
  opts?: { hasDescription?: boolean },
) {
  const errorId = `${baseId}-error`;
  const descriptionId = `${baseId}-description`;
  const invalid = !!error;
  // Reference only ids that are actually in the DOM: FieldError renders null
  // when there is no error, and a dangling aria-describedby is inconsistently
  // handled across screen readers (dropped by some, announced empty by others).
  const describedBy =
    [opts?.hasDescription ? descriptionId : null, invalid ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    invalid,
    // For a Field wrapping a real control: label points at it, control owns the id.
    labelProps: { htmlFor: baseId },
    controlProps: {
      id: baseId,
      // Absent rather than aria-invalid="false" — the attribute only carries
      // meaning when set, and a literal "false" is noise on every valid field.
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    // For a Field wrapping a GROUP of controls (chips, checkboxes) with no
    // single labelable element: htmlFor would point at a <div>, which is
    // invalid, so the group names itself via aria-labelledby instead.
    labelledByProps: { id: `${baseId}-label` },
    groupProps: {
      'aria-labelledby': `${baseId}-label`,
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    descriptionProps: { id: descriptionId },
    errorProps: { id: errorId },
  } as const;
}

// Maps the controller's `fieldErrors` payload back onto individual inputs.
// The controller emits dotted paths ('webhooks.1.url'), which is exactly
// react-hook-form's setError field syntax — so a rule only the server can
// check still lands on the right input rather than in a toast.
//
// Generic over all three of UseFormReturn's parameters so a form built by
// useZodForm (whose transformed type differs from its field type) is accepted
// without the call site restating anything.
export function applyServerFieldErrors<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues,
>(
  form: UseFormReturn<TFieldValues, TContext, TTransformedValues>,
  fieldErrors: Record<string, string> | undefined,
): boolean {
  if (!fieldErrors) return false;
  const entries = Object.entries(fieldErrors);
  for (const [path, message] of entries) {
    form.setError(path as Path<TFieldValues>, { type: 'server', message });
  }
  return entries.length > 0;
}
